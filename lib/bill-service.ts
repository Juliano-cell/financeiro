import { addMonths } from "./finance-rules.mjs";

type BillContext = {
  d1: D1Database;
  householdId: string;
  userId: string;
  timestamp?: string;
};

type BillClassification = {
  categoryId: string;
  subcategoryId?: string | null;
};

export type CreateBillInput = BillClassification & {
  description: string;
  amountCents: number;
  dueDate: string;
  accountId?: string | null;
  recurrence: "none" | "monthly";
  recurrenceEndDate?: string | null;
  notes?: string | null;
};

export type UpdateBillOccurrenceInput = BillClassification & {
  id: string;
  description: string;
  amountCents: number;
  dueDate: string;
  accountId?: string | null;
  notes?: string | null;
};

export type UpdateRecurringBillSeriesInput = BillClassification & {
  id: string;
  anchorBillId: string;
  scope: "future" | "selected";
  occurrenceIds: string[];
  changeDueDate: boolean;
  description: string;
  amountCents: number;
  dayOfMonth: number;
  accountId?: string | null;
  endsOn?: string | null;
  notes?: string | null;
};

type BillRow = {
  id: string;
  household_id: string;
  description: string;
  amount_cents: number;
  category_id: string | null;
  subcategory_id: string | null;
  account_id: string | null;
  due_date: string;
  recurrence_series_id: string | null;
  status: "pending" | "paid" | "cancelled";
  payment_transaction_id: string | null;
  notes: string | null;
};

export class BillServiceError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "BillServiceError";
    this.status = status;
    this.code = code;
  }
}

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const isoTimestamp = (context: BillContext) => context.timestamp ?? new Date().toISOString();

function saoPauloDate(timestamp: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function assertText(value: string) {
  if (!value.trim() || value.trim().length > 120) throw new BillServiceError("Descrição inválida.");
}

function assertMoney(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000_000) throw new BillServiceError("Valor inválido.");
}

function assertDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new BillServiceError("Data inválida.");
}

async function assertActiveMembership(context: BillContext) {
  const membership = await context.d1.prepare("SELECT id FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'active' LIMIT 1").bind(context.householdId, context.userId).first<{ id: string }>();
  if (!membership) throw new BillServiceError("Usuário não pertence mais a esta família.", 403);
}

async function validateAccount(context: BillContext, accountId?: string | null) {
  if (!accountId) return;
  const account = await context.d1.prepare("SELECT id FROM accounts WHERE id = ? AND household_id = ? AND is_active = 1 LIMIT 1").bind(accountId, context.householdId).first<{ id: string }>();
  if (!account) throw new BillServiceError("Conta inválida ou inativa.");
}

async function validateClassification(context: BillContext, classification: BillClassification, payment = false) {
  const classificationError = () => new BillServiceError(
    payment ? "Classifique este vencimento com uma categoria e subcategoria válidas antes de pagar." : "Selecione uma categoria válida para o vencimento.",
    payment ? 409 : 400,
    payment ? "BILL_CLASSIFICATION_REQUIRED" : undefined,
  );
  if (!classification.categoryId) throw classificationError();
  const category = await context.d1.prepare("SELECT id FROM categories WHERE id = ? AND household_id = ? AND is_active = 1 AND type IN ('expense','both') LIMIT 1").bind(classification.categoryId, context.householdId).first<{ id: string }>();
  if (!category) throw classificationError();
  const count = await context.d1.prepare("SELECT count(*) AS total FROM subcategories WHERE household_id = ? AND category_id = ? AND is_active = 1").bind(context.householdId, category.id).first<{ total: number }>();
  if ((count?.total ?? 0) > 0 && !classification.subcategoryId) {
    throw new BillServiceError(
      payment ? "Classifique este vencimento com uma subcategoria válida antes de pagar." : "Selecione uma subcategoria para o vencimento.",
      payment ? 409 : 400,
      payment ? "BILL_CLASSIFICATION_REQUIRED" : undefined,
    );
  }
  if (classification.subcategoryId) {
    const subcategory = await context.d1.prepare("SELECT id FROM subcategories WHERE id = ? AND household_id = ? AND category_id = ? AND is_active = 1 LIMIT 1").bind(classification.subcategoryId, context.householdId, category.id).first<{ id: string }>();
    if (!subcategory) throw new BillServiceError(payment ? "Classifique este vencimento com uma subcategoria válida antes de pagar." : "Subcategoria inválida para o vencimento.", payment ? 409 : 400, payment ? "BILL_CLASSIFICATION_REQUIRED" : undefined);
  }
}

async function getBill(context: BillContext, billId: string) {
  return context.d1.prepare("SELECT id, household_id, description, amount_cents, category_id, subcategory_id, account_id, due_date, recurrence_series_id, status, payment_transaction_id, notes FROM bills WHERE id = ? AND household_id = ? LIMIT 1").bind(billId, context.householdId).first<BillRow>();
}

function changes(result: D1Result | undefined) {
  return result?.meta.changes ?? 0;
}

function assertOccurrenceIds(ids: string[]) {
  if (ids.length < 1) throw new BillServiceError("Selecione pelo menos um vencimento para alterar.");
  if (ids.length > 48 || new Set(ids).size !== ids.length || ids.some((id) => !id || id.length > 100)) {
    throw new BillServiceError("A seleção de vencimentos é inválida.");
  }
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function requestedIdsCte(ids: string[]) {
  return `requested(id) AS (VALUES ${ids.map(() => "(?)").join(", ")})`;
}

function dueDateWithDay(dueDate: string, dayOfMonth: number) {
  const month = dueDate.slice(0, 7);
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${month}-${String(Math.min(dayOfMonth, lastDay)).padStart(2, "0")}`;
}

function recurrenceDateConflict() {
  return new BillServiceError("Não foi possível alterar os vencimentos porque duas ocorrências da série ficariam com a mesma data.", 409, "BILL_RECURRENCE_DUE_DATE_CONFLICT");
}

function isRecurrenceDateConstraint(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("bills.recurrence_series_id, bills.due_date") || message.includes("bills_series_due_unique");
}

async function validateRecurringDueDates(
  input: UpdateRecurringBillSeriesInput,
  context: BillContext,
  occurrences: Array<{ id: string; due_date: string }>,
) {
  const resultingDates = occurrences.map((occurrence) => {
    const adjustedDueDate = input.changeDueDate ? dueDateWithDay(occurrence.due_date, input.dayOfMonth) : occurrence.due_date;
    return input.scope === "future" && input.endsOn && adjustedDueDate > input.endsOn ? occurrence.due_date : adjustedDueDate;
  });
  if (new Set(resultingDates).size !== resultingDates.length) throw recurrenceDateConflict();
  const distinctDates = [...new Set(resultingDates)];
  const requestedPlaceholders = input.occurrenceIds.map(() => "?").join(", ");
  const datePlaceholders = distinctDates.map(() => "?").join(", ");
  const collision = await context.d1.prepare(`SELECT id FROM bills WHERE household_id = ? AND recurrence_series_id = ? AND id NOT IN (${requestedPlaceholders}) AND due_date IN (${datePlaceholders}) LIMIT 1`).bind(context.householdId, input.id, ...input.occurrenceIds, ...distinctDates).first<{ id: string }>();
  if (collision) throw recurrenceDateConflict();
}

function recurringOccurrenceUpdate(
  input: UpdateRecurringBillSeriesInput,
  context: BillContext,
  anchorDueDate: string,
  expectedCount: number,
  timestamp: string,
) {
  const requestedCte = requestedIdsCte(input.occurrenceIds);
  const futureCondition = input.scope === "future" ? "AND b.due_date >= ?" : "";
  const futureGuard = input.scope === "future"
    ? "AND (SELECT count(*) FROM bills AS future WHERE future.household_id = ? AND future.recurrence_series_id = ? AND future.status = 'pending' AND future.due_date >= ?) = ?"
    : "";
  const adjustedDueDate = "CASE WHEN ? = 1 THEN substr(due_date, 1, 8) || printf('%02d', min(?, CAST(strftime('%d', date(substr(due_date, 1, 7) || '-01', '+1 month', '-1 day')) AS INTEGER))) ELSE due_date END";
  const statement = context.d1.prepare(`WITH ${requestedCte},
    eligible AS (
      SELECT b.id, b.due_date
      FROM bills AS b
      INNER JOIN requested AS r ON r.id = b.id
      WHERE b.household_id = ? AND b.recurrence_series_id = ? AND b.status = 'pending' ${futureCondition}
    ),
    adjusted AS (SELECT id, due_date, ${adjustedDueDate} AS adjusted_due_date FROM eligible),
    planned AS (SELECT id, due_date, adjusted_due_date, CASE WHEN ? IS NOT NULL AND adjusted_due_date > ? THEN 1 ELSE 0 END AS cancel FROM adjusted)
    UPDATE bills SET
      description = CASE WHEN (SELECT cancel FROM planned WHERE planned.id = bills.id) = 1 THEN description ELSE ? END,
      amount_cents = CASE WHEN (SELECT cancel FROM planned WHERE planned.id = bills.id) = 1 THEN amount_cents ELSE ? END,
      category_id = CASE WHEN (SELECT cancel FROM planned WHERE planned.id = bills.id) = 1 THEN category_id ELSE ? END,
      subcategory_id = CASE WHEN (SELECT cancel FROM planned WHERE planned.id = bills.id) = 1 THEN subcategory_id ELSE ? END,
      account_id = CASE WHEN (SELECT cancel FROM planned WHERE planned.id = bills.id) = 1 THEN account_id ELSE ? END,
      due_date = CASE WHEN (SELECT cancel FROM planned WHERE planned.id = bills.id) = 1 THEN due_date ELSE (SELECT adjusted_due_date FROM planned WHERE planned.id = bills.id) END,
      recurrence_end_date = CASE WHEN (SELECT cancel FROM planned WHERE planned.id = bills.id) = 1 OR ? = 'selected' THEN recurrence_end_date ELSE ? END,
      notes = CASE WHEN (SELECT cancel FROM planned WHERE planned.id = bills.id) = 1 THEN notes ELSE ? END,
      status = CASE WHEN (SELECT cancel FROM planned WHERE planned.id = bills.id) = 1 THEN 'cancelled' ELSE status END,
      updated_at = ?
    WHERE household_id = ? AND recurrence_series_id = ? AND status = 'pending' AND id IN (SELECT id FROM requested)
      AND (SELECT count(*) FROM eligible) = ?
      ${futureGuard}
      AND EXISTS (SELECT 1 FROM bills AS anchor WHERE anchor.id = ? AND anchor.household_id = ? AND anchor.recurrence_series_id = ? AND anchor.status = 'pending')
      AND EXISTS (SELECT 1 FROM recurring_bill_series AS series WHERE series.id = ? AND series.household_id = ? AND series.is_active = 1)`);
  const bindings: unknown[] = [
    ...input.occurrenceIds,
    context.householdId,
    input.id,
    ...(input.scope === "future" ? [anchorDueDate] : []),
    input.changeDueDate ? 1 : 0,
    input.dayOfMonth,
    input.scope === "future" ? input.endsOn ?? null : null,
    input.scope === "future" ? input.endsOn ?? null : null,
    input.description.trim(),
    input.amountCents,
    input.categoryId,
    input.subcategoryId ?? null,
    input.accountId ?? null,
    input.scope,
    input.endsOn ?? null,
    input.notes ?? null,
    timestamp,
    context.householdId,
    input.id,
    expectedCount,
    ...(input.scope === "future" ? [context.householdId, input.id, anchorDueDate, expectedCount] : []),
    input.anchorBillId,
    context.householdId,
    input.id,
    input.id,
    context.householdId,
  ];
  return statement.bind(...bindings);
}

export async function createBill(input: CreateBillInput, context: BillContext) {
  assertText(input.description);
  assertMoney(input.amountCents);
  assertDate(input.dueDate);
  if (input.recurrenceEndDate) assertDate(input.recurrenceEndDate);
  if (input.recurrence === "monthly" && input.recurrenceEndDate && input.recurrenceEndDate < input.dueDate) throw new BillServiceError("A data final da recorrência não pode ser anterior ao primeiro vencimento.");
  await assertActiveMembership(context);
  await validateClassification(context, input);
  await validateAccount(context, input.accountId);

  const timestamp = isoTimestamp(context);
  const recurrenceEndDate = input.recurrence === "monthly" ? (input.recurrenceEndDate ?? null) : null;
  const seriesId = input.recurrence === "monthly" ? uid("bill_series") : null;
  const maxMonths = input.recurrence === "monthly" ? 24 : 1;
  const occurrences: Array<{ id: string; dueDate: string }> = [];
  for (let index = 0; index < maxMonths; index++) {
    const dueMonth = addMonths(input.dueDate.slice(0, 7), index);
    const dueDay = Math.min(Number(input.dueDate.slice(8)), new Date(Date.UTC(Number(dueMonth.slice(0, 4)), Number(dueMonth.slice(5, 7)), 0)).getUTCDate());
    const dueDate = `${dueMonth}-${String(dueDay).padStart(2, "0")}`;
    if (recurrenceEndDate && dueDate > recurrenceEndDate) break;
    occurrences.push({ id: uid("bill"), dueDate });
  }

  const statements: D1PreparedStatement[] = [];
  if (seriesId) statements.push(context.d1.prepare("INSERT INTO recurring_bill_series (id, household_id, description, amount_cents, category_id, subcategory_id, account_id, day_of_month, starts_on, ends_on, is_active, notes, created_by_user_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'web', ?, ?)").bind(seriesId, context.householdId, input.description.trim(), input.amountCents, input.categoryId, input.subcategoryId ?? null, input.accountId ?? null, Number(input.dueDate.slice(8)), input.dueDate, recurrenceEndDate, input.notes ?? null, context.userId, timestamp, timestamp));
  for (const occurrence of occurrences) statements.push(context.d1.prepare("INSERT INTO bills (id, household_id, description, amount_cents, category_id, subcategory_id, due_date, account_id, recurrence, recurrence_series_id, recurrence_end_date, notes, status, paid_at, payment_transaction_id, created_by_user_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, 'web', ?, ?)").bind(occurrence.id, context.householdId, input.description.trim(), input.amountCents, input.categoryId, input.subcategoryId ?? null, occurrence.dueDate, input.accountId ?? null, input.recurrence, seriesId, recurrenceEndDate, input.notes ?? null, context.userId, timestamp, timestamp));
  await context.d1.batch(statements);
  return { ids: occurrences.map((occurrence) => occurrence.id), seriesId };
}

export async function updateBillOccurrence(input: UpdateBillOccurrenceInput, context: BillContext) {
  assertText(input.description);
  assertMoney(input.amountCents);
  assertDate(input.dueDate);
  await assertActiveMembership(context);
  const bill = await getBill(context, input.id);
  if (!bill) throw new BillServiceError("Conta a pagar não encontrada.", 404);
  if (bill.status !== "pending") throw new BillServiceError("Somente ocorrências pendentes podem ser editadas.", 409);
  await validateClassification(context, input);
  await validateAccount(context, input.accountId);
  const result = await context.d1.prepare("UPDATE bills SET description = ?, amount_cents = ?, category_id = ?, subcategory_id = ?, due_date = ?, account_id = ?, notes = ?, updated_at = ? WHERE id = ? AND household_id = ? AND status = 'pending'").bind(input.description.trim(), input.amountCents, input.categoryId, input.subcategoryId ?? null, input.dueDate, input.accountId ?? null, input.notes ?? null, isoTimestamp(context), input.id, context.householdId).run();
  if (changes(result) !== 1) throw new BillServiceError("O vencimento foi alterado por outra operação.", 409);
}

export async function cancelBillOccurrence(billId: string, context: BillContext) {
  await assertActiveMembership(context);
  const bill = await getBill(context, billId);
  if (!bill) throw new BillServiceError("Conta a pagar não encontrada.", 404);
  if (bill.status === "paid") throw new BillServiceError("Uma ocorrência paga não pode ser cancelada.", 409);
  if (bill.status === "cancelled") return;
  const result = await context.d1.prepare("UPDATE bills SET status = 'cancelled', updated_at = ? WHERE id = ? AND household_id = ? AND status = 'pending'").bind(isoTimestamp(context), billId, context.householdId).run();
  if (changes(result) !== 1) throw new BillServiceError("O vencimento foi alterado por outra operação.", 409);
}

export async function updateRecurringBillSeries(input: UpdateRecurringBillSeriesInput, context: BillContext) {
  assertText(input.description);
  assertMoney(input.amountCents);
  if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) throw new BillServiceError("Dia de vencimento inválido.");
  if (input.scope === "future" && !input.changeDueDate) throw new BillServiceError("A edição dos próximos vencimentos exige um dia de vencimento válido.");
  if (input.endsOn) assertDate(input.endsOn);
  assertOccurrenceIds(input.occurrenceIds);
  await assertActiveMembership(context);
  const anchor = await getBill(context, input.anchorBillId);
  if (!anchor || anchor.recurrence_series_id !== input.id) throw new BillServiceError("Vencimento recorrente não encontrado.", 404);
  if (anchor.status !== "pending") throw new BillServiceError("Este vencimento não está mais pendente. Atualize os dados e tente novamente.", 409, "BILL_RECURRENCE_SELECTION_CHANGED");
  const series = await context.d1.prepare("SELECT id, starts_on, is_active FROM recurring_bill_series WHERE id = ? AND household_id = ? LIMIT 1").bind(input.id, context.householdId).first<{ id: string; starts_on: string; is_active: number }>();
  if (!series) throw new BillServiceError("Série recorrente não encontrada.", 404);
  if (!series.is_active) throw new BillServiceError("A série recorrente está cancelada.", 409);
  if (input.endsOn && input.endsOn < series.starts_on) throw new BillServiceError("A data final da recorrência não pode ser anterior ao início.");
  await validateClassification(context, input);
  await validateAccount(context, input.accountId);
  const timestamp = isoTimestamp(context);
  const selectedPlaceholders = input.occurrenceIds.map(() => "?").join(", ");
  const selectedResult = await context.d1.prepare(`SELECT id, due_date FROM bills WHERE household_id = ? AND recurrence_series_id = ? AND status = 'pending' AND id IN (${selectedPlaceholders}) ORDER BY due_date`).bind(context.householdId, input.id, ...input.occurrenceIds).all<{ id: string; due_date: string }>();
  if (!sameIds(input.occurrenceIds, selectedResult.results.map((occurrence) => occurrence.id))) {
    throw new BillServiceError("A seleção contém um vencimento inválido ou que não está mais pendente. Atualize os dados e tente novamente.", 409, "BILL_RECURRENCE_SELECTION_CHANGED");
  }
  if (input.scope === "future") {
    const futureResult = await context.d1.prepare("SELECT id FROM bills WHERE household_id = ? AND recurrence_series_id = ? AND status = 'pending' AND due_date >= ? ORDER BY due_date").bind(context.householdId, input.id, anchor.due_date).all<{ id: string }>();
    if (!sameIds(input.occurrenceIds, futureResult.results.map((occurrence) => occurrence.id))) {
      throw new BillServiceError("Os vencimentos futuros foram alterados. Atualize os dados e tente novamente.", 409, "BILL_RECURRENCE_SELECTION_CHANGED");
    }
  }
  await validateRecurringDueDates(input, context, selectedResult.results);

  const occurrenceUpdate = recurringOccurrenceUpdate(input, context, anchor.due_date, input.occurrenceIds.length, timestamp);
  if (input.scope === "selected") {
    let result: D1Result;
    try {
      result = await occurrenceUpdate.run();
    } catch (error) {
      if (isRecurrenceDateConstraint(error)) throw recurrenceDateConflict();
      throw error;
    }
    if (changes(result) !== input.occurrenceIds.length) throw new BillServiceError("Os vencimentos selecionados foram alterados. Atualize os dados e tente novamente.", 409, "BILL_RECURRENCE_SELECTION_CHANGED");
    return { updatedOccurrences: input.occurrenceIds.length };
  }

  const requestedCte = requestedIdsCte(input.occurrenceIds);
  const seriesUpdate = context.d1.prepare(`WITH ${requestedCte}
    UPDATE recurring_bill_series SET description = ?, amount_cents = ?, category_id = ?, subcategory_id = ?, account_id = ?, day_of_month = ?, ends_on = ?, notes = ?, updated_at = ?
    WHERE id = ? AND household_id = ? AND is_active = 1
      AND EXISTS (SELECT 1 FROM bills AS anchor WHERE anchor.id = ? AND anchor.household_id = ? AND anchor.recurrence_series_id = ? AND anchor.status = 'pending')
      AND (SELECT count(*) FROM bills AS selected INNER JOIN requested AS request ON request.id = selected.id WHERE selected.household_id = ? AND selected.recurrence_series_id = ? AND selected.status = 'pending' AND selected.due_date >= ?) = ?
      AND (SELECT count(*) FROM bills AS future WHERE future.household_id = ? AND future.recurrence_series_id = ? AND future.status = 'pending' AND future.due_date >= ?) = ?`).bind(
    ...input.occurrenceIds,
    input.description.trim(),
    input.amountCents,
    input.categoryId,
    input.subcategoryId ?? null,
    input.accountId ?? null,
    input.dayOfMonth,
    input.endsOn ?? null,
    input.notes ?? null,
    timestamp,
    input.id,
    context.householdId,
    input.anchorBillId,
    context.householdId,
    input.id,
    context.householdId,
    input.id,
    anchor.due_date,
    input.occurrenceIds.length,
    context.householdId,
    input.id,
    anchor.due_date,
    input.occurrenceIds.length,
  );
  let results: D1Result[];
  try {
    results = await context.d1.batch([seriesUpdate, occurrenceUpdate]);
  } catch (error) {
    if (isRecurrenceDateConstraint(error)) throw recurrenceDateConflict();
    throw error;
  }
  if (changes(results[0]) !== 1 || changes(results[1]) !== input.occurrenceIds.length) {
    throw new BillServiceError("A série ou seus vencimentos foram alterados. Atualize os dados e tente novamente.", 409, "BILL_RECURRENCE_SELECTION_CHANGED");
  }
  return { updatedOccurrences: input.occurrenceIds.length };
}

export async function cancelRecurringBillSeries(seriesId: string, context: BillContext) {
  await assertActiveMembership(context);
  const series = await context.d1.prepare("SELECT id, is_active FROM recurring_bill_series WHERE id = ? AND household_id = ? LIMIT 1").bind(seriesId, context.householdId).first<{ id: string; is_active: number }>();
  if (!series) throw new BillServiceError("Série recorrente não encontrada.", 404);
  if (!series.is_active) return;
  const timestamp = isoTimestamp(context);
  const results = await context.d1.batch([
    context.d1.prepare("UPDATE recurring_bill_series SET is_active = 0, updated_at = ? WHERE id = ? AND household_id = ? AND is_active = 1").bind(timestamp, seriesId, context.householdId),
    context.d1.prepare("UPDATE bills SET status = 'cancelled', updated_at = ? WHERE recurrence_series_id = ? AND household_id = ? AND status = 'pending' AND due_date >= ?").bind(timestamp, seriesId, context.householdId, saoPauloDate(timestamp)),
  ]);
  if (changes(results[0]) !== 1) throw new BillServiceError("A série foi alterada por outra operação.", 409);
}

export async function payBill(input: { id: string; accountId: string }, context: BillContext) {
  if (!input.accountId) throw new BillServiceError("Selecione a conta usada no pagamento.");
  await assertActiveMembership(context);
  const bill = await getBill(context, input.id);
  if (!bill) throw new BillServiceError("Conta a pagar não encontrada.", 404);
  if (bill.status === "paid") throw new BillServiceError("Esta conta já foi paga.", 409);
  if (bill.status === "cancelled") throw new BillServiceError("Uma conta cancelada não pode ser paga.", 409);
  await validateAccount(context, input.accountId);
  await validateClassification(context, { categoryId: bill.category_id ?? "", subcategoryId: bill.subcategory_id }, true);

  const timestamp = isoTimestamp(context);
  const transactionId = uid("transaction");
  const transactionDate = saoPauloDate(timestamp);
  const insert = context.d1.prepare(`INSERT INTO transactions (id, household_id, type, amount_cents, description, category_id, subcategory_id, transaction_date, transaction_time, responsible_user_id, account_id, payment_method, status, origin, notes, created_at, updated_at)
    SELECT ?, b.household_id, 'expense', b.amount_cents, b.description, b.category_id, b.subcategory_id, ?, NULL, ?, ?, 'conta_a_pagar', 'confirmed', 'dashboard', b.notes, ?, ?
    FROM bills b
    INNER JOIN accounts a ON a.id = ? AND a.household_id = b.household_id AND a.is_active = 1
    INNER JOIN categories c ON c.id = b.category_id AND c.household_id = b.household_id AND c.is_active = 1 AND c.type IN ('expense','both')
    WHERE b.id = ? AND b.household_id = ? AND b.status = 'pending' AND b.payment_transaction_id IS NULL
      AND EXISTS (SELECT 1 FROM household_members hm WHERE hm.household_id = b.household_id AND hm.user_id = ? AND hm.status = 'active')
      AND ((b.subcategory_id IS NULL AND NOT EXISTS (SELECT 1 FROM subcategories sx WHERE sx.household_id = b.household_id AND sx.category_id = b.category_id AND sx.is_active = 1))
        OR EXISTS (SELECT 1 FROM subcategories s WHERE s.id = b.subcategory_id AND s.household_id = b.household_id AND s.category_id = b.category_id AND s.is_active = 1))`).bind(transactionId, transactionDate, context.userId, input.accountId, timestamp, timestamp, input.accountId, input.id, context.householdId, context.userId);
  const update = context.d1.prepare("UPDATE bills SET status = 'paid', paid_at = ?, account_id = ?, payment_transaction_id = ?, updated_at = ? WHERE id = ? AND household_id = ? AND status = 'pending' AND payment_transaction_id IS NULL AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND household_id = ? AND account_id = ? AND payment_method = 'conta_a_pagar')").bind(timestamp, input.accountId, transactionId, timestamp, input.id, context.householdId, transactionId, context.householdId, input.accountId);
  const results = await context.d1.batch([insert, update]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) throw new BillServiceError("Este vencimento já foi pago ou alterado por outra operação.", 409, "BILL_ALREADY_PROCESSED");
  return { transactionId };
}

export async function undoBillPayment(billId: string, context: BillContext) {
  await assertActiveMembership(context);
  const bill = await getBill(context, billId);
  if (!bill) throw new BillServiceError("Conta a pagar não encontrada.", 404);
  if (bill.status !== "paid" || !bill.payment_transaction_id || !bill.account_id) throw new BillServiceError("Este vencimento não possui um pagamento válido para desfazer.", 409);
  const transaction = await context.d1.prepare("SELECT id FROM transactions WHERE id = ? AND household_id = ? AND type = 'expense' AND amount_cents = ? AND description = ? AND category_id IS ? AND subcategory_id IS ? AND account_id = ? AND payment_method = 'conta_a_pagar' AND status = 'confirmed' AND origin = 'dashboard' AND notes IS ? LIMIT 1").bind(bill.payment_transaction_id, context.householdId, bill.amount_cents, bill.description, bill.category_id, bill.subcategory_id, bill.account_id, bill.notes).first<{ id: string }>();
  if (!transaction) throw new BillServiceError("O vínculo de pagamento deste vencimento está inconsistente.", 409, "BILL_PAYMENT_INCONSISTENT");

  const timestamp = isoTimestamp(context);
  const update = context.d1.prepare(`UPDATE bills SET status = 'pending', paid_at = NULL, payment_transaction_id = NULL, updated_at = ?
    WHERE id = ? AND household_id = ? AND status = 'paid' AND payment_transaction_id = ?
      AND EXISTS (SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'active')
      AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND household_id = ? AND type = 'expense' AND amount_cents = ? AND description = ? AND category_id IS ? AND subcategory_id IS ? AND account_id = ? AND payment_method = 'conta_a_pagar' AND status = 'confirmed' AND origin = 'dashboard' AND notes IS ?)`).bind(timestamp, bill.id, context.householdId, transaction.id, context.householdId, context.userId, transaction.id, context.householdId, bill.amount_cents, bill.description, bill.category_id, bill.subcategory_id, bill.account_id, bill.notes);
  const remove = context.d1.prepare("DELETE FROM transactions WHERE id = ? AND household_id = ? AND type = 'expense' AND payment_method = 'conta_a_pagar' AND status = 'confirmed' AND origin = 'dashboard' AND NOT EXISTS (SELECT 1 FROM bills WHERE payment_transaction_id = transactions.id)").bind(transaction.id, context.householdId);
  const results = await context.d1.batch([update, remove]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) throw new BillServiceError("O pagamento foi alterado por outra operação e não pôde ser desfeito.", 409, "BILL_PAYMENT_CHANGED");
  return { transactionId: transaction.id };
}

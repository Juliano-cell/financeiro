import { dateInTimeZone } from "./finance-analytics.mjs";
import { addMonths } from "./finance-rules.mjs";
import {
  assertExpectedIncomeAmount,
  assertExpectedIncomeCivilDate,
  assertExpectedIncomeConfiguredDay,
  assertExpectedIncomeMonth,
  buildExpectedIncomeMaterializationPlan,
  expectedIncomeRequestFingerprint,
  normalizeExpectedIncomeFields,
  normalizeExpectedIncomeOccurrenceId,
  normalizeExpectedIncomeOperationId,
} from "./expected-income-rules.mjs";

type ExpectedIncomeContext = {
  d1: D1Database;
  householdId: string;
  userId: string;
  timestamp?: string;
  origin?: "web" | "telegram" | "system";
};

type ExpectedIncomeFields = {
  description: string;
  expectedAmountCents: number;
  plannedAccountId?: string | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
  notes?: string | null;
};

export type CreateExpectedIncomeInput = ExpectedIncomeFields & {
  operationId: string;
  expectedDate: string;
};

export type CreateRecurringExpectedIncomeInput = ExpectedIncomeFields & {
  operationId: string;
  configuredDay: number;
  startsOn: string;
  endsOn?: string | null;
};

export type MaterializeExpectedIncomeInput = {
  operationId: string;
  seriesId: string;
  throughMonth: string;
};

export type ReceiveExpectedIncomeInput = {
  operationId: string;
  occurrenceId: string;
  receivedAmountCents: number;
  receivedDate: string;
  actualAccountId: string;
};

export type CancelExpectedIncomeInput = {
  operationId: string;
  occurrenceId: string;
};

export type ReverseExpectedIncomeReceiptInput = {
  operationId: string;
  occurrenceId: string;
  reversalDate: string;
};

export type UpdateExpectedIncomeInput = ExpectedIncomeFields & {
  operationId: string;
  occurrenceId: string;
  expectedDate: string;
};

type OperationType = "create_occurrence" | "create_series" | "materialize" | "receive" | "cancel" | "reverse" | "update_occurrence";

type OperationRow = {
  id: string;
  request_hash: string;
  operation_type: OperationType;
  series_id: string | null;
  occurrence_id: string | null;
  transaction_id: string | null;
  financial_date: string | null;
};

type OccurrenceRow = {
  id: string;
  household_id: string;
  series_id: string | null;
  description: string;
  expected_amount_cents: number;
  expected_date: string;
  planned_account_id: string | null;
  category_id: string | null;
  subcategory_id: string | null;
  notes: string | null;
  status: "pending" | "received" | "cancelled";
  received_transaction_id: string | null;
  received_at: string | null;
  cancelled_at: string | null;
};

type SeriesRow = {
  id: string;
  description: string;
  expected_amount_cents: number;
  configured_day: number;
  starts_on: string;
  ends_on: string | null;
  planned_account_id: string | null;
  category_id: string | null;
  subcategory_id: string | null;
  notes: string | null;
  is_active: number;
  materialized_through_month: string;
  origin: "web" | "telegram" | "system";
};

type LinkedTransactionRow = {
  id: string;
  amount_cents: number;
  description: string;
  category_id: string | null;
  subcategory_id: string | null;
  transaction_date: string;
  responsible_user_id: string;
  account_id: string;
  payment_method: string | null;
  status: string;
  origin: string;
  notes: string | null;
};

export class ExpectedIncomeServiceError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "ExpectedIncomeServiceError";
    this.status = status;
    this.code = code;
  }
}

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

function timestamp(context: ExpectedIncomeContext) {
  const value = context.timestamp ?? new Date().toISOString();
  if (Number.isNaN(new Date(value).getTime())) throw new ExpectedIncomeServiceError("Timestamp da operação inválido.");
  return value;
}

function today(context: ExpectedIncomeContext) {
  return dateInTimeZone(new Date(timestamp(context)), "America/Sao_Paulo");
}

async function scopedId(prefix: string, householdId: string, operationId: string) {
  const bytes = new TextEncoder().encode(`${householdId}\u0000${operationId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `${prefix}_${Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function operationId(value: string) {
  try { return normalizeExpectedIncomeOperationId(value); }
  catch (error) { throw new ExpectedIncomeServiceError(error instanceof Error ? error.message : "Identificação da operação inválida."); }
}

function occurrenceId(value: string) {
  try { return normalizeExpectedIncomeOccurrenceId(value); }
  catch (error) { throw new ExpectedIncomeServiceError(error instanceof Error ? error.message : "Receita prevista inválida."); }
}

function civilDate(value: string, label: string) {
  try { return assertExpectedIncomeCivilDate(value, label); }
  catch (error) { throw new ExpectedIncomeServiceError(error instanceof Error ? error.message : `${label} inválida.`); }
}

function normalizedFields(input: ExpectedIncomeFields) {
  try { return normalizeExpectedIncomeFields(input); }
  catch (error) { throw new ExpectedIncomeServiceError(error instanceof Error ? error.message : "Dados da receita prevista inválidos."); }
}

function configuredDay(value: number) {
  try { return assertExpectedIncomeConfiguredDay(value); }
  catch (error) { throw new ExpectedIncomeServiceError(error instanceof Error ? error.message : "Dia configurado inválido."); }
}

function month(value: string) {
  try { return assertExpectedIncomeMonth(value); }
  catch (error) { throw new ExpectedIncomeServiceError(error instanceof Error ? error.message : "Mês inválido."); }
}

function receivedAmount(value: number) {
  try { return assertExpectedIncomeAmount(value); }
  catch { throw new ExpectedIncomeServiceError("Valor recebido inválido."); }
}

async function assertActiveMembership(context: ExpectedIncomeContext) {
  const membership = await context.d1.prepare("SELECT id FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'active' LIMIT 1").bind(context.householdId, context.userId).first<{ id: string }>();
  if (!membership) throw new ExpectedIncomeServiceError("Usuário não pertence mais a esta família.", 403);
}

async function validatePlannedAccount(context: ExpectedIncomeContext, accountId: string | null) {
  if (!accountId) return;
  const account = await context.d1.prepare("SELECT id FROM accounts WHERE id = ? AND household_id = ? AND is_active = 1 LIMIT 1").bind(accountId, context.householdId).first<{ id: string }>();
  if (!account) throw new ExpectedIncomeServiceError("Conta planejada inválida ou inativa.");
}

async function validateActualAccount(context: ExpectedIncomeContext, accountId: string) {
  const account = await context.d1.prepare("SELECT id FROM accounts WHERE id = ? AND household_id = ? AND is_active = 1 LIMIT 1").bind(accountId, context.householdId).first<{ id: string }>();
  if (!account) throw new ExpectedIncomeServiceError("Conta de recebimento inválida ou inativa.");
}

async function validateClassification(context: ExpectedIncomeContext, categoryId: string | null, subcategoryId: string | null) {
  if (!categoryId) {
    if (subcategoryId) throw new ExpectedIncomeServiceError("A subcategoria exige uma categoria.");
    return;
  }
  const category = await context.d1.prepare("SELECT id FROM categories WHERE id = ? AND household_id = ? AND is_active = 1 AND type IN ('income','both') LIMIT 1").bind(categoryId, context.householdId).first<{ id: string }>();
  if (!category) throw new ExpectedIncomeServiceError("Selecione uma categoria de receita válida.");
  if (!subcategoryId) return;
  const subcategory = await context.d1.prepare("SELECT id FROM subcategories WHERE id = ? AND household_id = ? AND category_id = ? AND is_active = 1 LIMIT 1").bind(subcategoryId, context.householdId, categoryId).first<{ id: string }>();
  if (!subcategory) throw new ExpectedIncomeServiceError("Subcategoria inválida para a receita prevista.");
}

async function storedOperation(context: ExpectedIncomeContext, idempotencyKey: string) {
  return context.d1.prepare(`SELECT id, request_hash, operation_type, series_id, occurrence_id, transaction_id, financial_date
    FROM expected_income_operations WHERE household_id = ? AND idempotency_key = ? LIMIT 1`).bind(context.householdId, idempotencyKey).first<OperationRow>();
}

async function resolveReplay(context: ExpectedIncomeContext, idempotencyKey: string, requestHash: string, expectedType: OperationType) {
  const operation = await storedOperation(context, idempotencyKey);
  if (!operation) return null;
  if (operation.request_hash !== requestHash || operation.operation_type !== expectedType) {
    throw new ExpectedIncomeServiceError("A identificação da operação já foi usada com dados diferentes.", 409, "EXPECTED_INCOME_IDEMPOTENCY_CONFLICT");
  }
  return operation;
}

async function getOccurrence(context: ExpectedIncomeContext, id: string) {
  return context.d1.prepare(`SELECT id, household_id, series_id, description, expected_amount_cents, expected_date,
      planned_account_id, category_id, subcategory_id, notes, status, received_transaction_id, received_at, cancelled_at
    FROM expected_income_occurrences WHERE id = ? AND household_id = ? LIMIT 1`).bind(id, context.householdId).first<OccurrenceRow>();
}

async function getSeries(context: ExpectedIncomeContext, id: string) {
  return context.d1.prepare(`SELECT id, description, expected_amount_cents, configured_day, starts_on, ends_on,
      planned_account_id, category_id, subcategory_id, notes, is_active, materialized_through_month, origin
    FROM expected_income_series WHERE id = ? AND household_id = ? LIMIT 1`).bind(id, context.householdId).first<SeriesRow>();
}

async function getLinkedTransaction(context: ExpectedIncomeContext, id: string) {
  return context.d1.prepare(`SELECT id, amount_cents, description, category_id, subcategory_id, transaction_date,
      responsible_user_id, account_id, payment_method, status, origin, notes
    FROM transactions WHERE id = ? AND household_id = ? AND type = 'income' LIMIT 1`).bind(id, context.householdId).first<LinkedTransactionRow>();
}

function operationStatement(context: ExpectedIncomeContext, values: {
  id: string;
  key: string;
  hash: string;
  type: OperationType;
  seriesId?: string | null;
  occurrenceId?: string | null;
  transactionId?: string | null;
  financialDate?: string | null;
  createdAt: string;
}) {
  return context.d1.prepare(`INSERT INTO expected_income_operations
    (id, household_id, idempotency_key, request_hash, operation_type, series_id, occurrence_id, transaction_id, performed_by_user_id, financial_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(values.id, context.householdId, values.key, values.hash, values.type, values.seriesId ?? null, values.occurrenceId ?? null, values.transactionId ?? null, context.userId, values.financialDate ?? null, values.createdAt);
}

function auditStatement(context: ExpectedIncomeContext, values: { action: string; entityType: string; entityId: string; oldData?: unknown; newData?: unknown; createdAt: string }) {
  return context.d1.prepare(`INSERT INTO audit_logs
    (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uid("audit"), context.householdId, context.userId, values.action, values.entityType, values.entityId, values.oldData === undefined ? null : JSON.stringify(values.oldData), values.newData === undefined ? null : JSON.stringify(values.newData), values.createdAt);
}

function occurrenceSnapshot(row: OccurrenceRow) {
  return {
    id: row.id,
    seriesId: row.series_id,
    description: row.description,
    expectedAmountCents: row.expected_amount_cents,
    expectedDate: row.expected_date,
    plannedAccountId: row.planned_account_id,
    categoryId: row.category_id,
    subcategoryId: row.subcategory_id,
    notes: row.notes,
    status: row.status,
    receivedTransactionId: row.received_transaction_id,
  };
}

function isUniqueConstraint(error: unknown) {
  return /UNIQUE constraint failed/iu.test(error instanceof Error ? error.message : String(error));
}

export async function createExpectedIncome(input: CreateExpectedIncomeInput, context: ExpectedIncomeContext) {
  const key = operationId(input.operationId);
  const fields = normalizedFields(input);
  const expectedDate = civilDate(input.expectedDate, "Data prevista");
  const payload = { ...fields, expectedDate };
  const hash = await expectedIncomeRequestFingerprint("create_occurrence", payload);
  await assertActiveMembership(context);
  const replay = await resolveReplay(context, key, hash, "create_occurrence");
  if (replay) return { occurrenceId: replay.occurrence_id!, replayed: true as const };
  await validatePlannedAccount(context, fields.plannedAccountId);
  await validateClassification(context, fields.categoryId, fields.subcategoryId);
  const at = timestamp(context);
  const id = uid("expected_income");
  const opId = await scopedId("expected_income_operation", context.householdId, key);
  const origin = context.origin ?? "web";
  const statements = [
    operationStatement(context, { id: opId, key, hash, type: "create_occurrence", occurrenceId: id, financialDate: expectedDate, createdAt: at }),
    context.d1.prepare(`INSERT INTO expected_income_occurrences
      (id, household_id, series_id, occurrence_month, description, expected_amount_cents, expected_date, planned_account_id, category_id, subcategory_id, notes, status, received_transaction_id, received_at, cancelled_at, last_operation_id, created_by_user_id, origin, created_at, updated_at)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?, ?, ?)`).bind(id, context.householdId, fields.description, fields.expectedAmountCents, expectedDate, fields.plannedAccountId, fields.categoryId, fields.subcategoryId, fields.notes, opId, context.userId, origin, at, at),
    auditStatement(context, { action: "create", entityType: "expected_income_occurrence", entityId: id, newData: { operationId: key, ...payload, status: "pending" }, createdAt: at }),
  ];
  try { await context.d1.batch(statements); }
  catch (error) {
    const concurrent = await resolveReplay(context, key, hash, "create_occurrence");
    if (concurrent) return { occurrenceId: concurrent.occurrence_id!, replayed: true as const };
    throw error;
  }
  return { occurrenceId: id, replayed: false as const };
}

export async function createRecurringExpectedIncome(input: CreateRecurringExpectedIncomeInput, context: ExpectedIncomeContext) {
  const key = operationId(input.operationId);
  const fields = normalizedFields(input);
  const day = configuredDay(input.configuredDay);
  const startsOn = civilDate(input.startsOn, "Data inicial");
  const endsOn = input.endsOn === undefined || input.endsOn === null ? null : civilDate(input.endsOn, "Data final");
  let plan;
  try { plan = buildExpectedIncomeMaterializationPlan({ startsOn, endsOn, configuredDay: day }); }
  catch (error) { throw new ExpectedIncomeServiceError(error instanceof Error ? error.message : "Recorrência inválida."); }
  const payload = { ...fields, configuredDay: day, startsOn, endsOn, recurrence: "monthly" };
  const hash = await expectedIncomeRequestFingerprint("create_series", payload);
  await assertActiveMembership(context);
  const replay = await resolveReplay(context, key, hash, "create_series");
  if (replay) {
    const initialCursor = replay.financial_date!.slice(0, 7);
    const rows = await context.d1.prepare("SELECT id, occurrence_month, expected_date FROM expected_income_occurrences WHERE household_id = ? AND series_id = ? AND occurrence_month <= ? ORDER BY occurrence_month").bind(context.householdId, replay.series_id, initialCursor).all<{ id: string; occurrence_month: string; expected_date: string }>();
    return { seriesId: replay.series_id!, occurrences: rows.results.map((row) => ({ occurrenceId: row.id, occurrenceMonth: row.occurrence_month, expectedDate: row.expected_date })), materializedThroughMonth: initialCursor, replayed: true as const };
  }
  await validatePlannedAccount(context, fields.plannedAccountId);
  await validateClassification(context, fields.categoryId, fields.subcategoryId);
  const at = timestamp(context);
  const seriesId = uid("expected_income_series");
  const opId = await scopedId("expected_income_operation", context.householdId, key);
  const origin = context.origin ?? "web";
  const occurrences = plan.occurrences.map((item) => ({ ...item, occurrenceId: uid("expected_income") }));
  const statements: D1PreparedStatement[] = [
    operationStatement(context, { id: opId, key, hash, type: "create_series", seriesId, financialDate: `${plan.materializedThroughMonth}-01`, createdAt: at }),
    context.d1.prepare(`INSERT INTO expected_income_series
      (id, household_id, description, expected_amount_cents, recurrence, configured_day, starts_on, ends_on, planned_account_id, category_id, subcategory_id, notes, is_active, materialized_through_month, last_operation_id, created_by_user_id, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'monthly', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`).bind(seriesId, context.householdId, fields.description, fields.expectedAmountCents, day, startsOn, endsOn, fields.plannedAccountId, fields.categoryId, fields.subcategoryId, fields.notes, plan.materializedThroughMonth, opId, context.userId, origin, at, at),
  ];
  for (const item of occurrences) {
    statements.push(context.d1.prepare(`INSERT INTO expected_income_occurrences
      (id, household_id, series_id, occurrence_month, description, expected_amount_cents, expected_date, planned_account_id, category_id, subcategory_id, notes, status, received_transaction_id, received_at, cancelled_at, last_operation_id, created_by_user_id, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?, ?, ?)`).bind(item.occurrenceId, context.householdId, seriesId, item.occurrenceMonth, fields.description, fields.expectedAmountCents, item.expectedDate, fields.plannedAccountId, fields.categoryId, fields.subcategoryId, fields.notes, opId, context.userId, origin, at, at));
  }
  statements.push(auditStatement(context, { action: "create", entityType: "expected_income_series", entityId: seriesId, newData: { operationId: key, ...payload, materializedThroughMonth: plan.materializedThroughMonth, occurrenceIds: occurrences.map((item) => item.occurrenceId) }, createdAt: at }));
  try { await context.d1.batch(statements); }
  catch (error) {
    const concurrent = await resolveReplay(context, key, hash, "create_series");
    if (concurrent) {
      const initialCursor = concurrent.financial_date!.slice(0, 7);
      const rows = await context.d1.prepare("SELECT id, occurrence_month, expected_date FROM expected_income_occurrences WHERE household_id = ? AND series_id = ? AND occurrence_month <= ? ORDER BY occurrence_month").bind(context.householdId, concurrent.series_id, initialCursor).all<{ id: string; occurrence_month: string; expected_date: string }>();
      return { seriesId: concurrent.series_id!, occurrences: rows.results.map((row) => ({ occurrenceId: row.id, occurrenceMonth: row.occurrence_month, expectedDate: row.expected_date })), materializedThroughMonth: initialCursor, replayed: true as const };
    }
    throw error;
  }
  return { seriesId, occurrences, materializedThroughMonth: plan.materializedThroughMonth, replayed: false as const };
}

async function materialize(input: MaterializeExpectedIncomeInput, context: ExpectedIncomeContext, allowRetry: boolean) {
  const key = operationId(input.operationId);
  const seriesId = occurrenceId(input.seriesId);
  const throughMonth = month(input.throughMonth);
  const payload = { seriesId, throughMonth };
  const hash = await expectedIncomeRequestFingerprint("materialize", payload);
  await assertActiveMembership(context);
  const replay = await resolveReplay(context, key, hash, "materialize");
  if (replay) return { seriesId, materializedThroughMonth: replay.financial_date!.slice(0, 7), createdOccurrenceIds: [] as string[], replayed: true as const };
  const series = await getSeries(context, seriesId);
  if (!series) throw new ExpectedIncomeServiceError("Série de receita prevista não encontrada.", 404);
  if (!series.is_active) throw new ExpectedIncomeServiceError("A série de receita prevista está inativa.", 409);
  let newCursor = series.materialized_through_month;
  let rawPlan: Array<{ occurrenceMonth: string; expectedDate: string }> = [];
  if (throughMonth > series.materialized_through_month) {
    try {
      const plan = buildExpectedIncomeMaterializationPlan({
        startsOn: series.starts_on,
        endsOn: series.ends_on,
        configuredDay: series.configured_day,
        fromMonth: addMonths(series.materialized_through_month, 1),
        throughMonth,
      });
      newCursor = plan.materializedThroughMonth < series.materialized_through_month ? series.materialized_through_month : plan.materializedThroughMonth;
      rawPlan = plan.occurrences;
    } catch (error) { throw new ExpectedIncomeServiceError(error instanceof Error ? error.message : "Materialização inválida."); }
  }
  const at = timestamp(context);
  const opId = await scopedId("expected_income_operation", context.householdId, key);
  const occurrences = rawPlan.map((item) => ({ ...item, occurrenceId: uid("expected_income") }));
  const statements: D1PreparedStatement[] = [operationStatement(context, { id: opId, key, hash, type: "materialize", seriesId, financialDate: `${newCursor}-01`, createdAt: at })];
  for (const item of occurrences) {
    statements.push(context.d1.prepare(`INSERT INTO expected_income_occurrences
      (id, household_id, series_id, occurrence_month, description, expected_amount_cents, expected_date, planned_account_id, category_id, subcategory_id, notes, status, received_transaction_id, received_at, cancelled_at, last_operation_id, created_by_user_id, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?, ?, ?)`).bind(item.occurrenceId, context.householdId, series.id, item.occurrenceMonth, series.description, series.expected_amount_cents, item.expectedDate, series.planned_account_id, series.category_id, series.subcategory_id, series.notes, opId, context.userId, series.origin, at, at));
  }
  if (newCursor > series.materialized_through_month) {
    statements.push(context.d1.prepare("UPDATE expected_income_series SET materialized_through_month = ?, last_operation_id = ?, updated_at = ? WHERE id = ? AND household_id = ? AND materialized_through_month = ? AND is_active = 1").bind(newCursor, opId, at, series.id, context.householdId, series.materialized_through_month));
  }
  statements.push(auditStatement(context, { action: "materialize", entityType: "expected_income_series", entityId: series.id, oldData: { materializedThroughMonth: series.materialized_through_month }, newData: { operationId: key, requestedThroughMonth: throughMonth, materializedThroughMonth: newCursor, occurrenceIds: occurrences.map((item) => item.occurrenceId) }, createdAt: at }));
  try { await context.d1.batch(statements); }
  catch (error) {
    const concurrent = await resolveReplay(context, key, hash, "materialize");
    if (concurrent) return { seriesId, materializedThroughMonth: concurrent.financial_date!.slice(0, 7), createdOccurrenceIds: [] as string[], replayed: true as const };
    if (allowRetry && isUniqueConstraint(error)) return materialize(input, context, false);
    throw error;
  }
  return { seriesId, materializedThroughMonth: newCursor, createdOccurrenceIds: occurrences.map((item) => item.occurrenceId), replayed: false as const };
}

export function materializeExpectedIncomeSeries(input: MaterializeExpectedIncomeInput, context: ExpectedIncomeContext) {
  return materialize(input, context, true);
}

export async function receiveExpectedIncome(input: ReceiveExpectedIncomeInput, context: ExpectedIncomeContext) {
  const key = operationId(input.operationId);
  const id = occurrenceId(input.occurrenceId);
  const amount = receivedAmount(input.receivedAmountCents);
  const receivedDate = civilDate(input.receivedDate, "Data recebida");
  const actualAccountId = occurrenceId(input.actualAccountId);
  const payload = { occurrenceId: id, receivedAmountCents: amount, receivedDate, actualAccountId };
  const hash = await expectedIncomeRequestFingerprint("receive", payload);
  await assertActiveMembership(context);
  const replay = await resolveReplay(context, key, hash, "receive");
  if (replay) return { occurrenceId: id, transactionId: replay.transaction_id!, replayed: true as const };
  if (receivedDate > today(context)) throw new ExpectedIncomeServiceError("A data recebida não pode estar no futuro.");
  const occurrence = await getOccurrence(context, id);
  if (!occurrence) throw new ExpectedIncomeServiceError("Receita prevista não encontrada.", 404);
  if (occurrence.status !== "pending") throw new ExpectedIncomeServiceError("Somente uma receita pendente pode ser recebida.", 409, "EXPECTED_INCOME_NOT_PENDING");
  await validateActualAccount(context, actualAccountId);
  const at = timestamp(context);
  const opId = await scopedId("expected_income_operation", context.householdId, key);
  const transactionId = await scopedId("transaction_expected_income", context.householdId, key);
  const transactionOrigin = context.origin === "telegram" ? "telegram" : "dashboard";
  const statements = [
    context.d1.prepare(`INSERT INTO transactions
      (id, household_id, type, amount_cents, description, category_id, subcategory_id, transaction_date, transaction_time, responsible_user_id, account_id, payment_method, status, origin, notes, created_at, updated_at)
      VALUES (?, ?, 'income', ?, ?, ?, ?, ?, NULL, ?, ?, 'conta_a_receber', 'confirmed', ?, ?, ?, ?)`).bind(transactionId, context.householdId, amount, occurrence.description, occurrence.category_id, occurrence.subcategory_id, receivedDate, context.userId, actualAccountId, transactionOrigin, occurrence.notes, at, at),
    operationStatement(context, { id: opId, key, hash, type: "receive", occurrenceId: id, transactionId, financialDate: receivedDate, createdAt: at }),
    context.d1.prepare(`UPDATE expected_income_occurrences
      SET status = 'received', received_transaction_id = ?, received_at = ?, cancelled_at = NULL, last_operation_id = ?, updated_at = ?
      WHERE id = ? AND household_id = ? AND status = 'pending' AND received_transaction_id IS NULL`).bind(transactionId, at, opId, at, id, context.householdId),
    auditStatement(context, { action: "receive", entityType: "expected_income_occurrence", entityId: id, oldData: occurrenceSnapshot(occurrence), newData: { ...occurrenceSnapshot(occurrence), status: "received", receivedTransactionId: transactionId, receivedAmountCents: amount, receivedDate, actualAccountId, operationId: key }, createdAt: at }),
    auditStatement(context, { action: "create", entityType: "transaction", entityId: transactionId, newData: { source: "expected_income", occurrenceId: id, type: "income", amountCents: amount, transactionDate: receivedDate, accountId: actualAccountId, status: "confirmed" }, createdAt: at }),
  ];
  try { await context.d1.batch(statements); }
  catch (error) {
    const concurrent = await resolveReplay(context, key, hash, "receive");
    if (concurrent) return { occurrenceId: id, transactionId: concurrent.transaction_id!, replayed: true as const };
    const current = await getOccurrence(context, id);
    if (current?.status !== "pending") throw new ExpectedIncomeServiceError("A receita foi processada por outra operação.", 409, "EXPECTED_INCOME_ALREADY_PROCESSED");
    throw error;
  }
  return { occurrenceId: id, transactionId, replayed: false as const };
}

export async function cancelExpectedIncome(input: CancelExpectedIncomeInput, context: ExpectedIncomeContext) {
  const key = operationId(input.operationId);
  const id = occurrenceId(input.occurrenceId);
  const payload = { occurrenceId: id };
  const hash = await expectedIncomeRequestFingerprint("cancel", payload);
  await assertActiveMembership(context);
  const replay = await resolveReplay(context, key, hash, "cancel");
  if (replay) return { occurrenceId: id, replayed: true as const };
  const occurrence = await getOccurrence(context, id);
  if (!occurrence) throw new ExpectedIncomeServiceError("Receita prevista não encontrada.", 404);
  if (occurrence.status !== "pending") throw new ExpectedIncomeServiceError("Somente uma receita pendente pode ser cancelada.", 409, "EXPECTED_INCOME_NOT_PENDING");
  const at = timestamp(context);
  const opId = await scopedId("expected_income_operation", context.householdId, key);
  const statements = [
    operationStatement(context, { id: opId, key, hash, type: "cancel", occurrenceId: id, financialDate: occurrence.expected_date, createdAt: at }),
    context.d1.prepare("UPDATE expected_income_occurrences SET status = 'cancelled', cancelled_at = ?, last_operation_id = ?, updated_at = ? WHERE id = ? AND household_id = ? AND status = 'pending'").bind(at, opId, at, id, context.householdId),
    auditStatement(context, { action: "cancel", entityType: "expected_income_occurrence", entityId: id, oldData: occurrenceSnapshot(occurrence), newData: { ...occurrenceSnapshot(occurrence), status: "cancelled", operationId: key }, createdAt: at }),
  ];
  try { await context.d1.batch(statements); }
  catch {
    const concurrent = await resolveReplay(context, key, hash, "cancel");
    if (concurrent) return { occurrenceId: id, replayed: true as const };
    throw new ExpectedIncomeServiceError("A receita foi processada por outra operação.", 409, "EXPECTED_INCOME_ALREADY_PROCESSED");
  }
  return { occurrenceId: id, replayed: false as const };
}

export async function reverseExpectedIncomeReceipt(input: ReverseExpectedIncomeReceiptInput, context: ExpectedIncomeContext) {
  const key = operationId(input.operationId);
  const id = occurrenceId(input.occurrenceId);
  const reversalDate = civilDate(input.reversalDate, "Data do estorno");
  const payload = { occurrenceId: id, reversalDate };
  const hash = await expectedIncomeRequestFingerprint("reverse", payload);
  await assertActiveMembership(context);
  const replay = await resolveReplay(context, key, hash, "reverse");
  if (replay) return { occurrenceId: id, transactionId: replay.transaction_id!, replayed: true as const };
  const occurrence = await getOccurrence(context, id);
  if (!occurrence) throw new ExpectedIncomeServiceError("Receita prevista não encontrada.", 404);
  if (occurrence.status !== "received" || !occurrence.received_transaction_id) throw new ExpectedIncomeServiceError("Esta receita não possui recebimento válido para estornar.", 409, "EXPECTED_INCOME_NOT_RECEIVED");
  const transaction = await getLinkedTransaction(context, occurrence.received_transaction_id);
  const exact = transaction
    && transaction.status === "confirmed"
    && transaction.payment_method === "conta_a_receber"
    && transaction.description === occurrence.description
    && transaction.category_id === occurrence.category_id
    && transaction.subcategory_id === occurrence.subcategory_id
    && transaction.notes === occurrence.notes;
  if (!exact) throw new ExpectedIncomeServiceError("O vínculo de recebimento está inconsistente.", 409, "EXPECTED_INCOME_RECEIPT_INCONSISTENT");
  if (reversalDate > today(context)) throw new ExpectedIncomeServiceError("A data do estorno não pode estar no futuro.");
  if (reversalDate < transaction.transaction_date) throw new ExpectedIncomeServiceError("A data do estorno não pode ser anterior ao recebimento.");
  const at = timestamp(context);
  const opId = await scopedId("expected_income_operation", context.householdId, key);
  const statements = [
    operationStatement(context, { id: opId, key, hash, type: "reverse", occurrenceId: id, transactionId: transaction.id, financialDate: reversalDate, createdAt: at }),
    context.d1.prepare(`UPDATE expected_income_occurrences
      SET status = 'pending', received_transaction_id = NULL, received_at = NULL, cancelled_at = NULL, last_operation_id = ?, updated_at = ?
      WHERE id = ? AND household_id = ? AND status = 'received' AND received_transaction_id = ?`).bind(opId, at, id, context.householdId, transaction.id),
    auditStatement(context, { action: "reverse", entityType: "expected_income_occurrence", entityId: id, oldData: { ...occurrenceSnapshot(occurrence), receivedAmountCents: transaction.amount_cents, receivedDate: transaction.transaction_date, actualAccountId: transaction.account_id }, newData: { ...occurrenceSnapshot(occurrence), status: "pending", receivedTransactionId: null, reversedTransactionId: transaction.id, reversalDate, operationId: key }, createdAt: at }),
  ];
  try { await context.d1.batch(statements); }
  catch (error) {
    const concurrent = await resolveReplay(context, key, hash, "reverse");
    if (concurrent) return { occurrenceId: id, transactionId: concurrent.transaction_id!, replayed: true as const };
    const current = await getOccurrence(context, id);
    if (current?.status !== "received" || current.received_transaction_id !== transaction.id) {
      throw new ExpectedIncomeServiceError("O recebimento foi processado por outra operação.", 409, "EXPECTED_INCOME_ALREADY_PROCESSED");
    }
    throw error;
  }
  return { occurrenceId: id, transactionId: transaction.id, replayed: false as const };
}

export async function updateExpectedIncome(input: UpdateExpectedIncomeInput, context: ExpectedIncomeContext) {
  const key = operationId(input.operationId);
  const id = occurrenceId(input.occurrenceId);
  const fields = normalizedFields(input);
  const expectedDate = civilDate(input.expectedDate, "Data prevista");
  const payload = { occurrenceId: id, ...fields, expectedDate };
  const hash = await expectedIncomeRequestFingerprint("update_occurrence", payload);
  await assertActiveMembership(context);
  const replay = await resolveReplay(context, key, hash, "update_occurrence");
  if (replay) return { occurrenceId: id, replayed: true as const };
  const occurrence = await getOccurrence(context, id);
  if (!occurrence) throw new ExpectedIncomeServiceError("Receita prevista não encontrada.", 404);
  if (occurrence.status !== "pending") throw new ExpectedIncomeServiceError("Somente uma receita pendente pode ser editada.", 409, "EXPECTED_INCOME_NOT_PENDING");
  await validatePlannedAccount(context, fields.plannedAccountId);
  await validateClassification(context, fields.categoryId, fields.subcategoryId);
  const at = timestamp(context);
  const opId = await scopedId("expected_income_operation", context.householdId, key);
  const statements = [
    operationStatement(context, { id: opId, key, hash, type: "update_occurrence", occurrenceId: id, financialDate: expectedDate, createdAt: at }),
    context.d1.prepare(`UPDATE expected_income_occurrences
      SET description = ?, expected_amount_cents = ?, expected_date = ?, planned_account_id = ?, category_id = ?, subcategory_id = ?, notes = ?, last_operation_id = ?, updated_at = ?
      WHERE id = ? AND household_id = ? AND status = 'pending'`).bind(fields.description, fields.expectedAmountCents, expectedDate, fields.plannedAccountId, fields.categoryId, fields.subcategoryId, fields.notes, opId, at, id, context.householdId),
    auditStatement(context, { action: "update", entityType: "expected_income_occurrence", entityId: id, oldData: occurrenceSnapshot(occurrence), newData: { ...payload, status: "pending", operationId: key }, createdAt: at }),
  ];
  try { await context.d1.batch(statements); }
  catch (error) {
    const concurrent = await resolveReplay(context, key, hash, "update_occurrence");
    if (concurrent) return { occurrenceId: id, replayed: true as const };
    throw error;
  }
  return { occurrenceId: id, replayed: false as const };
}

import { billInstallmentRequestFingerprint, buildBillInstallmentPlan, normalizeBillInstallmentContract } from "./bill-installment-rules.mjs";

export type CreateBillInstallmentSeriesInput = {
  operationId: string;
  description: string;
  totalAmountCents: number;
  installmentCount: number;
  firstDueDate: string;
  categoryId: string;
  subcategoryId?: string | null;
  accountId?: string | null;
  notes?: string | null;
};

type BillInstallmentContext = {
  d1: D1Database;
  householdId: string;
  userId: string;
  timestamp?: string;
  origin?: "web" | "telegram" | "system";
};

type StoredSeries = {
  id: string;
  request_fingerprint: string;
  installment_count: number;
  total_amount_cents: number;
  first_due_date: string;
};

type StoredOccurrence = {
  bill_id: string;
  installment_number: number;
  amount_cents: number;
  due_date: string;
};

export type BillInstallmentPlanItem = {
  billId: string;
  installmentNumber: number;
  installmentCount: number;
  amountCents: number;
  dueDate: string;
};

export class BillInstallmentServiceError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "BillInstallmentServiceError";
    this.status = status;
    this.code = code;
  }
}

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

function normalizeOperationId(value: string) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new BillInstallmentServiceError("Identificação da operação inválida.");
  return value.trim();
}

function normalizedContract(input: CreateBillInstallmentSeriesInput) {
  try { return normalizeBillInstallmentContract(input); }
  catch (error) { throw new BillInstallmentServiceError(error instanceof Error ? error.message : "Dados do parcelamento inválidos."); }
}

async function assertActiveMembership(context: BillInstallmentContext) {
  const membership = await context.d1.prepare("SELECT id FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'active' LIMIT 1").bind(context.householdId, context.userId).first<{ id: string }>();
  if (!membership) throw new BillInstallmentServiceError("Usuário não pertence mais a esta família.", 403);
}

async function validateClassification(context: BillInstallmentContext, categoryId: string, subcategoryId: string | null) {
  const category = await context.d1.prepare("SELECT id FROM categories WHERE id = ? AND household_id = ? AND is_active = 1 AND type IN ('expense','both') LIMIT 1").bind(categoryId, context.householdId).first<{ id: string }>();
  if (!category) throw new BillInstallmentServiceError("Selecione uma categoria válida para o parcelamento.");
  const count = await context.d1.prepare("SELECT count(*) AS total FROM subcategories WHERE household_id = ? AND category_id = ? AND is_active = 1").bind(context.householdId, category.id).first<{ total: number }>();
  if ((count?.total ?? 0) > 0 && !subcategoryId) throw new BillInstallmentServiceError("Selecione uma subcategoria para o parcelamento.");
  if (!subcategoryId) return;
  const subcategory = await context.d1.prepare("SELECT id FROM subcategories WHERE id = ? AND household_id = ? AND category_id = ? AND is_active = 1 LIMIT 1").bind(subcategoryId, context.householdId, category.id).first<{ id: string }>();
  if (!subcategory) throw new BillInstallmentServiceError("Subcategoria inválida para o parcelamento.");
}

async function validateAccount(context: BillInstallmentContext, accountId: string | null) {
  if (!accountId) return;
  const account = await context.d1.prepare("SELECT id FROM accounts WHERE id = ? AND household_id = ? AND is_active = 1 LIMIT 1").bind(accountId, context.householdId).first<{ id: string }>();
  if (!account) throw new BillInstallmentServiceError("Conta inválida ou inativa.");
}

async function storedSeries(context: BillInstallmentContext, operationId: string) {
  return context.d1.prepare(`SELECT id, request_fingerprint, installment_count, total_amount_cents, first_due_date
    FROM bill_installment_series
    WHERE household_id = ? AND idempotency_key = ? LIMIT 1`).bind(context.householdId, operationId).first<StoredSeries>();
}

async function resolveReplay(context: BillInstallmentContext, operationId: string, fingerprint: string) {
  const series = await storedSeries(context, operationId);
  if (!series) return null;
  if (series.request_fingerprint !== fingerprint) {
    throw new BillInstallmentServiceError("A identificação da operação já foi usada com dados diferentes.", 409, "BILL_INSTALLMENT_IDEMPOTENCY_CONFLICT");
  }
  const result = await context.d1.prepare(`SELECT occurrence.bill_id, occurrence.installment_number, bill.amount_cents, bill.due_date
    FROM bill_installment_occurrences occurrence
    INNER JOIN bills bill ON bill.id = occurrence.bill_id AND bill.household_id = occurrence.household_id
    WHERE occurrence.household_id = ? AND occurrence.series_id = ?
    ORDER BY occurrence.installment_number`).bind(context.householdId, series.id).all<StoredOccurrence>();
  const rows = result.results;
  const valid = rows.length === series.installment_count
    && rows.every((row, index) => row.installment_number === index + 1)
    && rows.reduce((sum, row) => sum + row.amount_cents, 0) === series.total_amount_cents
    && rows[0]?.due_date === series.first_due_date;
  if (!valid) throw new BillInstallmentServiceError("A série parcelada existente está inconsistente.", 409, "BILL_INSTALLMENT_INCONSISTENT");
  return {
    seriesId: series.id,
    billIds: rows.map((row) => row.bill_id),
    plan: rows.map((row) => ({ billId: row.bill_id, installmentNumber: row.installment_number, installmentCount: series.installment_count, amountCents: row.amount_cents, dueDate: row.due_date })),
    replayed: true as const,
  };
}

export async function createBillInstallmentSeries(input: CreateBillInstallmentSeriesInput, context: BillInstallmentContext) {
  const operationId = normalizeOperationId(input.operationId);
  const contract = normalizedContract(input);
  const fingerprint = await billInstallmentRequestFingerprint(contract);
  await assertActiveMembership(context);
  const replay = await resolveReplay(context, operationId, fingerprint);
  if (replay) return replay;
  await validateClassification(context, contract.categoryId, contract.subcategoryId);
  await validateAccount(context, contract.accountId);

  const rawPlan = buildBillInstallmentPlan(contract);
  const seriesId = uid("bill_installment_series");
  const plan: BillInstallmentPlanItem[] = rawPlan.map((item) => ({ ...item, billId: uid("bill") }));
  const billIds = plan.map((item) => item.billId);
  const timestamp = context.timestamp ?? new Date().toISOString();
  const origin = context.origin ?? "web";
  const configuredDay = Number(contract.firstDueDate.slice(8));
  const statements: D1PreparedStatement[] = [
    context.d1.prepare(`INSERT INTO bill_installment_series
      (id, household_id, description, total_amount_cents, installment_count, first_due_date, configured_day, category_id, subcategory_id, account_id, notes, idempotency_key, request_fingerprint, created_by_user_id, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(seriesId, context.householdId, contract.description, contract.totalAmountCents, contract.installmentCount, contract.firstDueDate, configuredDay, contract.categoryId, contract.subcategoryId, contract.accountId, contract.notes, operationId, fingerprint, context.userId, origin, timestamp, timestamp),
  ];
  for (const item of plan) {
    statements.push(
      context.d1.prepare(`INSERT INTO bills
        (id, household_id, description, amount_cents, category_id, subcategory_id, due_date, account_id, recurrence, recurrence_series_id, recurrence_end_date, notes, status, paid_at, payment_transaction_id, created_by_user_id, origin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'none', NULL, NULL, ?, 'pending', NULL, NULL, ?, ?, ?, ?)`).bind(item.billId, context.householdId, contract.description, item.amountCents, contract.categoryId, contract.subcategoryId, item.dueDate, contract.accountId, contract.notes, context.userId, origin, timestamp, timestamp),
      context.d1.prepare(`INSERT INTO bill_installment_occurrences
        (household_id, series_id, bill_id, installment_number, created_at)
        VALUES (?, ?, ?, ?, ?)`).bind(context.householdId, seriesId, item.billId, item.installmentNumber, timestamp),
    );
  }
  const auditPayload = JSON.stringify({
    operationId,
    contract,
    seriesId,
    billIds,
    plan,
  });
  statements.push(context.d1.prepare(`INSERT INTO audit_logs
    (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at)
    VALUES (?, ?, ?, 'create', 'bill_installment_series', ?, NULL, ?, ?)`).bind(uid("audit"), context.householdId, context.userId, seriesId, auditPayload, timestamp));

  try {
    await context.d1.batch(statements);
  } catch (error) {
    const concurrentReplay = await resolveReplay(context, operationId, fingerprint);
    if (concurrentReplay) return concurrentReplay;
    throw error;
  }
  return { seriesId, billIds, plan, replayed: false as const };
}

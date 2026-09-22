import { addMonths, dateForDayOfMonth, daysInMonth } from "./finance-rules.mjs";

// Context is supplied by authenticated server code, never parsed from client input.
export type InvoiceContext = { d1: D1Database; householdId: string; userId: string; timestamp?: string };
export type PayInvoiceInput = { invoiceId: string; accountId: string; paidAt: string; idempotencyKey: string; operationId?: string; expectedRemainingCents: number };
export type ReverseInvoicePaymentInput = { paymentId: string; reversedAt: string; idempotencyKey: string; operationId?: string };
type InvoiceRow = { id: string; household_id: string; card_id: string; reference_month: string; due_date: string; closes_on: string | null; status: string; invoice_total_cents: number; paid_cents: number; remaining_cents: number };
type OperationRow = { id: string; kind: "payment" | "no_payment" | "reversal"; invoice_id: string; account_id: string; created_by_user_id: string; amount_cents: number; occurred_on: string; reversed_payment_id: string | null; request_fingerprint: string };

export class InvoiceServiceError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "INVOICE_INVALID") { super(message); this.name = "InvoiceServiceError"; this.status = status; this.code = code; }
}

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const at = (context: InvoiceContext) => context.timestamp ?? new Date().toISOString();
const conflict = () => new InvoiceServiceError("A fatura ou o pagamento mudou. Atualize os dados e confirme novamente.", 409, "INVOICE_CONFLICT");

export function invoiceCivilDate(timestamp = new Date().toISOString()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isCivilDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value < "0001-01-01") return false;
  const year = Number(value.slice(0, 4)); const month = Number(value.slice(5, 7)); const day = Number(value.slice(8));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= lengths[month - 1];
}

function assertDate(value: string) {
  if (!isCivilDate(value)) throw new InvoiceServiceError("Data inválida.");
}

function assertIdentifier(value: string) {
  if (typeof value !== "string" || value.length > 200 || !value.replace(/[\p{White_Space}\p{Cc}\p{Cf}]/gu, "")) throw new InvoiceServiceError("Identificador inválido.");
}

export function invoiceClosesOn(referenceMonth: string, closingDay: number, dueDay: number) {
  // referenceMonth is the due month produced by the existing invoiceSchedule.
  const closingMonth = addMonths(referenceMonth, dueDay <= closingDay ? -1 : 0);
  return dateForDayOfMonth(closingMonth, closingDay);
}

export function canInvoiceReceivePurchase(invoice: { status: string; closesOn: string | null }, today: string) {
  return invoice.status !== "closed" && invoice.closesOn !== null && today <= invoice.closesOn;
}

export function conservativeLegacyInvoiceSnapshot(input: {
  referenceMonth: string;
  dueDate: string;
  status: string;
  targetReferenceMonth: string;
  targetDueDate: string;
  targetClosesOn: string;
  purchaseDate: string;
  today: string;
}) {
  const { referenceMonth, dueDate, status, targetReferenceMonth, targetDueDate, targetClosesOn, purchaseDate, today } = input;
  if (!/^\d{4}-\d{2}$/u.test(referenceMonth) || referenceMonth !== targetReferenceMonth || dueDate !== targetDueDate) return null;
  if ((status !== "open" && status !== "paid") || !isCivilDate(dueDate) || !isCivilDate(targetClosesOn) || !isCivilDate(purchaseDate) || !isCivilDate(today)) return null;
  if (dueDate.slice(0, 7) !== referenceMonth) return null;

  const persistedDueDay = Number(dueDate.slice(8));
  const monthLength = daysInMonth(referenceMonth);
  const compatibleDueDays = Array.from({ length: 31 }, (_, index) => index + 1)
    .filter((dueDay) => Math.min(dueDay, monthLength) === persistedDueDay);
  if (!compatibleDueDays.length) return null;

  let earliestCompatibleClosesOn: string | null = null;
  for (const dueDay of compatibleDueDays) {
    for (let closingDay = 1; closingDay <= 31; closingDay += 1) {
      const candidate = invoiceClosesOn(referenceMonth, closingDay, dueDay);
      if (earliestCompatibleClosesOn === null || candidate < earliestCompatibleClosesOn) earliestCompatibleClosesOn = candidate;
    }
  }

  const relevantDate = purchaseDate > today ? purchaseDate : today;
  if (earliestCompatibleClosesOn === null || earliestCompatibleClosesOn < relevantDate || targetClosesOn < relevantDate) return null;
  return { closesOn: targetClosesOn, earliestCompatibleClosesOn };
}

async function authorize(context: InvoiceContext) {
  const member = await context.d1.prepare("SELECT id FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'active' LIMIT 1").bind(context.householdId, context.userId).first();
  if (!member) throw new InvoiceServiceError("Usuário não pertence mais a esta família.", 403, "INVOICE_MEMBERSHIP");
}

// All decisive aggregates are scoped and repeated inside the write batch, not trusted from JS.
const INVOICE_TOTALS_SELECT = `SELECT i.*,
    COALESCE((SELECT SUM(s.amount_cents) FROM card_installments s WHERE s.household_id = i.household_id AND s.invoice_id = i.id AND s.status <> 'cancelled'), 0)
      + COALESCE((SELECT SUM(a.amount_cents) FROM card_invoice_adjustments a WHERE a.household_id = i.household_id AND a.invoice_id = i.id AND a.status = 'active'), 0)
      - COALESCE((SELECT SUM(o.amount_cents) FROM card_opening_balance_allocations o WHERE o.household_id = i.household_id AND o.invoice_id = i.id), 0) AS invoice_total_cents,
    COALESCE((SELECT SUM(p.amount_cents) FROM invoice_payments p WHERE p.household_id = i.household_id AND p.invoice_id = i.id AND NOT EXISTS
      (SELECT 1 FROM invoice_payment_operations r WHERE r.household_id = p.household_id AND r.reversed_payment_id = p.id AND r.kind = 'reversal')), 0) AS paid_cents
  FROM card_invoices i`;
const LEDGER_CTE = `WITH totals AS (
  ${INVOICE_TOTALS_SELECT} WHERE i.id = ? AND i.household_id = ?
), ledger AS (SELECT totals.*, MAX(invoice_total_cents - paid_cents, 0) AS remaining_cents FROM totals)`;

function state(row: InvoiceRow, today: string) {
  for (const value of [row.invoice_total_cents, row.paid_cents, row.remaining_cents]) if (!Number.isSafeInteger(value) || value < 0) throw conflict();
  return {
    invoiceId: row.id, cardId: row.card_id, referenceMonth: row.reference_month, dueDate: row.due_date, closesOn: row.closes_on,
    invoiceTotalCents: row.invoice_total_cents, paidCents: row.paid_cents, remainingCents: row.remaining_cents,
    cycleStatus: row.closes_on === null ? "unknown" as const : today <= row.closes_on ? "open" as const : "closed" as const,
    paymentStatus: row.remaining_cents === 0 ? "settled" as const : row.paid_cents === 0 ? "unpaid" as const : "partial" as const,
  };
}

export async function getInvoiceState(invoiceId: string, context: InvoiceContext) {
  assertIdentifier(invoiceId); await authorize(context);
  const row = await context.d1.prepare(`${LEDGER_CTE} SELECT * FROM ledger`).bind(invoiceId, context.householdId).first<InvoiceRow>();
  if (!row) throw new InvoiceServiceError("Fatura não encontrada.", 404, "INVOICE_NOT_FOUND");
  return state(row, invoiceCivilDate(at(context)));
}

// Authenticated/scoped aggregate read for API, limit, projections and notification consumers.
export async function getHouseholdInvoiceStates(context: InvoiceContext) {
  await authorize(context);
  const rows = await context.d1.prepare(`WITH totals AS (${INVOICE_TOTALS_SELECT} WHERE i.household_id = ?)
    SELECT totals.*, MAX(invoice_total_cents - paid_cents, 0) AS remaining_cents FROM totals`).bind(context.householdId).all<InvoiceRow>();
  const today = invoiceCivilDate(at(context));
  return rows.results.map((row) => state(row, today));
}

async function fingerprint(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function receipt(key: string, context: InvoiceContext) {
  return context.d1.prepare("SELECT id, kind, invoice_id, account_id, created_by_user_id, amount_cents, occurred_on, reversed_payment_id, request_fingerprint FROM invoice_payment_operations WHERE household_id = ? AND idempotency_key = ? LIMIT 1").bind(context.householdId, key).first<OperationRow>();
}

function result(row: OperationRow, replayed: boolean) {
  return { outcome: row.kind === "no_payment" ? "already_settled" as const : row.kind === "reversal" ? "reversed" as const : "paid" as const,
    operationId: row.id, invoiceId: row.invoice_id, accountId: row.account_id, amountCents: row.amount_cents, occurredOn: row.occurred_on,
    paymentId: row.kind === "payment" ? `invoice_payment:${row.id}` : row.reversed_payment_id, replayed };
}

function assertFingerprint(row: OperationRow, expected: string) {
  if (row.request_fingerprint !== expected) throw new InvoiceServiceError("Esta chave de operação já foi usada com outros dados.", 409, "INVOICE_IDEMPOTENCY_CONFLICT");
}

function auditStatement(context: InvoiceContext, key: string, fp: string, timestamp: string) {
  // A stable audit ID makes a racing retry safe too; no new audit on replay.
  return context.d1.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at)
    SELECT 'invoice_audit:' || o.id, o.household_id, o.created_by_user_id, o.kind, 'invoice_payment_operation', o.id, NULL,
      json_object('kind', o.kind, 'invoiceId', o.invoice_id, 'accountId', o.account_id, 'amountCents', o.amount_cents, 'occurredOn', o.occurred_on, 'reversedPaymentId', o.reversed_payment_id), ?
    FROM invoice_payment_operations o WHERE o.household_id = ? AND o.idempotency_key = ? AND o.request_fingerprint = ?
    ON CONFLICT(id) DO NOTHING`).bind(timestamp, context.householdId, key, fp);
}

async function runBatch(statements: D1PreparedStatement[], context: InvoiceContext) {
  try { return await context.d1.batch(statements); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/invoice_payment_operations.*(?:check|unique)|CHECK constraint failed: invoice_payment_operations|invoice operation does not match|UNIQUE constraint failed: invoice_payment_operations|FOREIGN KEY constraint failed/iu.test(message)) throw conflict();
    throw error; // transient failures remain retryable; never mask an uncertain commit as success.
  }
}

export async function payInvoiceResidual(input: PayInvoiceInput, context: InvoiceContext) {
  for (const value of [input.invoiceId, input.accountId, input.idempotencyKey, ...(input.operationId === undefined ? [] : [input.operationId])]) assertIdentifier(value);
  assertDate(input.paidAt);
  if (!Number.isSafeInteger(input.expectedRemainingCents) || input.expectedRemainingCents < 0) throw new InvoiceServiceError("Confirmação de valor inválida.");
  const timestamp = at(context); const today = invoiceCivilDate(timestamp);
  if (input.paidAt > today) throw new InvoiceServiceError("O pagamento não pode ter data futura.");
  await authorize(context);
  const fp = await fingerprint(["payment", context.householdId, context.userId, input.invoiceId, input.accountId, input.paidAt, input.expectedRemainingCents, input.operationId ?? null]);
  const existing = await receipt(input.idempotencyKey, context);
  if (existing) { assertFingerprint(existing, fp); return result(existing, true); }
  await getInvoiceState(input.invoiceId, context);
  const account = await context.d1.prepare("SELECT id FROM accounts WHERE id = ? AND household_id = ? AND is_active = 1").bind(input.accountId, context.householdId).first();
  if (!account) throw new InvoiceServiceError("Conta inválida.");
  // The pre-read is only validation/display. CASE below is the decisive guard.
  const operationId = input.operationId ?? uid("invoice_operation");
  const insert = context.d1.prepare(`${LEDGER_CTE}
    INSERT INTO invoice_payment_operations (id, household_id, idempotency_key, kind, invoice_id, account_id, created_by_user_id, amount_cents, occurred_on, reversed_payment_id, request_fingerprint, created_at)
    SELECT ?, ?, ?, CASE WHEN l.remaining_cents = 0 THEN 'no_payment' ELSE 'payment' END, ?, ?, ?,
      CASE WHEN l.id IS NOT NULL AND l.remaining_cents = ?
        AND EXISTS (SELECT 1 FROM household_members m WHERE m.household_id = ? AND m.user_id = ? AND m.status = 'active')
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.household_id = ? AND a.id = ? AND a.is_active = 1)
        AND EXISTS (SELECT 1 FROM credit_cards c WHERE c.household_id = l.household_id AND c.id = l.card_id)
      THEN l.remaining_cents ELSE -1 END, ?, NULL, ?, ?
    FROM (SELECT 1) seed LEFT JOIN ledger l ON 1 = 1
    WHERE NOT EXISTS (SELECT 1 FROM invoice_payment_operations done WHERE done.household_id = ? AND done.idempotency_key = ?)
    ON CONFLICT(household_id, idempotency_key) DO NOTHING`).bind(input.invoiceId, context.householdId,
      operationId, context.householdId, input.idempotencyKey, input.invoiceId, input.accountId, context.userId,
      input.expectedRemainingCents, context.householdId, context.userId, context.householdId, input.accountId, input.paidAt, fp, timestamp, context.householdId, input.idempotencyKey);
  const payment = context.d1.prepare(`INSERT INTO invoice_payments (id, household_id, invoice_id, account_id, amount_cents, paid_at, created_by_user_id, created_at, operation_id)
    SELECT 'invoice_payment:' || o.id, o.household_id, o.invoice_id, o.account_id, o.amount_cents, o.occurred_on, o.created_by_user_id, ?, o.id
    FROM invoice_payment_operations o WHERE o.household_id = ? AND o.idempotency_key = ? AND o.request_fingerprint = ? AND o.kind = 'payment'
    ON CONFLICT(operation_id) WHERE operation_id IS NOT NULL DO NOTHING`).bind(timestamp, context.householdId, input.idempotencyKey, fp);
  const results = await runBatch([insert, payment, auditStatement(context, input.idempotencyKey, fp, timestamp)], context);
  const completed = await receipt(input.idempotencyKey, context);
  if (!completed) throw conflict();
  assertFingerprint(completed, fp);
  return result(completed, (results[0]?.meta.changes ?? 0) === 0);
}

export async function reverseInvoicePayment(input: ReverseInvoicePaymentInput, context: InvoiceContext) {
  for (const value of [input.paymentId, input.idempotencyKey, ...(input.operationId === undefined ? [] : [input.operationId])]) assertIdentifier(value);
  assertDate(input.reversedAt);
  const timestamp = at(context);
  if (input.reversedAt > invoiceCivilDate(timestamp)) throw new InvoiceServiceError("A reversão não pode ter data futura.");
  await authorize(context);
  const fp = await fingerprint(["reversal", context.householdId, context.userId, input.paymentId, input.reversedAt, input.operationId ?? null]);
  const existing = await receipt(input.idempotencyKey, context);
  if (existing) { assertFingerprint(existing, fp); return result(existing, true); }
  const original = await context.d1.prepare("SELECT id, substr(paid_at, 1, 10) AS paidOn FROM invoice_payments WHERE id = ? AND household_id = ?").bind(input.paymentId, context.householdId).first<{ id: string; paidOn: string }>();
  if (!original) throw new InvoiceServiceError("Pagamento não encontrado.", 404);
  assertDate(original.paidOn);
  if (input.reversedAt < original.paidOn) throw new InvoiceServiceError("A reversão não pode ter data anterior ao pagamento original.");
  const insert = context.d1.prepare(`INSERT INTO invoice_payment_operations (id, household_id, idempotency_key, kind, invoice_id, account_id, created_by_user_id, amount_cents, occurred_on, reversed_payment_id, request_fingerprint, created_at)
    SELECT ?, ?, ?, 'reversal', p.invoice_id, p.account_id, ?, CASE WHEN
      EXISTS (SELECT 1 FROM household_members m WHERE m.household_id = ? AND m.user_id = ? AND m.status = 'active')
      AND ? >= substr(p.paid_at, 1, 10)
      AND NOT EXISTS (SELECT 1 FROM invoice_payment_operations r WHERE r.household_id = p.household_id AND r.reversed_payment_id = p.id AND r.kind = 'reversal')
      THEN p.amount_cents ELSE -1 END, ?, p.id, ?, ? FROM invoice_payments p WHERE p.id = ? AND p.household_id = ?
      AND NOT EXISTS (SELECT 1 FROM invoice_payment_operations done WHERE done.household_id = ? AND done.idempotency_key = ?)
    ON CONFLICT(household_id, idempotency_key) DO NOTHING`).bind(input.operationId ?? uid("invoice_reversal"), context.householdId, input.idempotencyKey, context.userId,
      context.householdId, context.userId, input.reversedAt, input.reversedAt, fp, timestamp, input.paymentId, context.householdId, context.householdId, input.idempotencyKey);
  const results = await runBatch([insert, auditStatement(context, input.idempotencyKey, fp, timestamp)], context);
  const completed = await receipt(input.idempotencyKey, context);
  if (!completed) throw conflict();
  assertFingerprint(completed, fp);
  return result(completed, (results[0]?.meta.changes ?? 0) === 0);
}

// Bank events are temporal: original outflow stays in September, reversal credit in October.
// Consumers must adopt these events in the next stage; no transaction expense is generated.
export async function getInvoiceBankEvents(invoiceId: string, context: InvoiceContext) {
  await getInvoiceState(invoiceId, context);
  const rows = await context.d1.prepare(`SELECT p.id, p.account_id AS accountId, substr(p.paid_at, 1, 10) AS occurredOn, -p.amount_cents AS signedCents, 'payment' AS kind
    FROM invoice_payments p WHERE p.household_id = ? AND p.invoice_id = ?
    UNION ALL SELECT r.id, r.account_id, r.occurred_on, r.amount_cents, 'reversal' FROM invoice_payment_operations r
    WHERE r.household_id = ? AND r.invoice_id = ? AND r.kind = 'reversal' ORDER BY occurredOn, id`).bind(context.householdId, invoiceId, context.householdId, invoiceId).all<{ id: string; accountId: string; occurredOn: string; signedCents: number; kind: "payment" | "reversal" }>();
  return rows.results;
}

export async function getInvoicePaymentHistory(invoiceId: string, context: InvoiceContext) {
  await getInvoiceState(invoiceId, context);
  const payments = await context.d1.prepare("SELECT id, account_id AS accountId, amount_cents AS amountCents, paid_at AS paidAt, created_by_user_id AS createdByUserId, operation_id AS operationId FROM invoice_payments WHERE household_id = ? AND invoice_id = ? ORDER BY paid_at, id").bind(context.householdId, invoiceId).all();
  const operations = await context.d1.prepare("SELECT id, kind, account_id AS accountId, amount_cents AS amountCents, occurred_on AS occurredOn, created_by_user_id AS createdByUserId, reversed_payment_id AS reversedPaymentId FROM invoice_payment_operations WHERE household_id = ? AND invoice_id = ? ORDER BY created_at, id").bind(context.householdId, invoiceId).all();
  return { payments: payments.results, operations: operations.results }; // no fingerprints or idempotency keys exposed.
}

export async function cancelCardPurchase(purchaseId: string, context: InvoiceContext) {
  assertIdentifier(purchaseId); await authorize(context);
  const purchase = await context.d1.prepare("SELECT id FROM card_purchases WHERE id = ? AND household_id = ? AND status = 'active'").bind(purchaseId, context.householdId).first();
  if (!purchase) throw new InvoiceServiceError("Compra não encontrada.", 404);
  const timestamp = at(context);
  // NULL violates the status NOT NULL constraint if the active-payment guard fails.
  // Thus no silent zero-row success and no gap between authorization and mutation.
  const update = context.d1.prepare(`UPDATE card_purchases SET status = CASE WHEN
    EXISTS (SELECT 1 FROM household_members m WHERE m.household_id = ? AND m.user_id = ? AND m.status = 'active')
    AND NOT EXISTS (SELECT 1 FROM card_installments s JOIN invoice_payments p ON p.household_id = s.household_id AND p.invoice_id = s.invoice_id
      WHERE s.household_id = ? AND s.purchase_id = ? AND s.status <> 'cancelled' AND NOT EXISTS
      (SELECT 1 FROM invoice_payment_operations r WHERE r.household_id = p.household_id AND r.reversed_payment_id = p.id AND r.kind = 'reversal'))
    AND status = 'active'
    THEN 'cancelled' ELSE NULL END, updated_at = ? WHERE id = ? AND household_id = ?`).bind(context.householdId, context.userId, context.householdId, purchaseId, timestamp, purchaseId, context.householdId);
  try {
    const results = await context.d1.batch([update,
      context.d1.prepare("UPDATE card_installments SET status = 'cancelled', updated_at = ? WHERE purchase_id = ? AND household_id = ? AND EXISTS (SELECT 1 FROM card_purchases p WHERE p.id = ? AND p.household_id = ? AND p.status = 'cancelled')").bind(timestamp, purchaseId, context.householdId, purchaseId, context.householdId),
      context.d1.prepare("INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, new_data, created_at) SELECT ?, ?, ?, 'cancel', 'card_purchase', ?, ?, ? WHERE EXISTS (SELECT 1 FROM card_purchases WHERE id = ? AND household_id = ? AND status = 'cancelled' AND updated_at = ?)").bind(uid("audit"), context.householdId, context.userId, purchaseId, JSON.stringify({ status: "cancelled" }), timestamp, purchaseId, context.householdId, timestamp),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) throw conflict();
  } catch (error) {
    if (/NOT NULL constraint failed: card_purchases.status/iu.test(error instanceof Error ? error.message : String(error))) throw new InvoiceServiceError("A compra possui pagamento ativo na fatura. Reverta o pagamento antes de cancelar.", 409, "INVOICE_ACTIVE_PAYMENT");
    throw error;
  }
  return { id: purchaseId, status: "cancelled" as const };
}

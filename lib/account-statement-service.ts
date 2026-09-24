import { ACCOUNT_BANK_EVENTS_CTE, dateInTimeZone } from "./finance-analytics.mjs";
import type {
  AccountStatementEntityType,
  AccountStatementEventFilter,
  AccountStatementEventType,
  AccountStatementInput,
  AccountStatementItem,
  AccountStatementResponse,
} from "./account-statement-types";

export const ACCOUNT_STATEMENT_DEFAULT_LIMIT = 50;
export const ACCOUNT_STATEMENT_MAX_LIMIT = 100;

export type AccountStatementContext = {
  d1: D1Database;
  householdId: string;
  now?: Date;
};

export class AccountStatementError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "AccountStatementError";
    this.status = status;
    this.code = code;
  }
}

type AccountRow = {
  id: string;
  name: string;
  initial_balance_cents: number;
  is_active: number;
};

type StatementRow = {
  pre_period_net_cents: number;
  period_credits_cents: number;
  period_debits_cents: number;
  source_type: AccountStatementEntityType | null;
  source_id: string | null;
  event_date: string | null;
  signed_amount_cents: number | null;
  event_type: AccountStatementEventType | null;
  amount_cents: number | null;
  transaction_description: string | null;
  payment_method: string | null;
  category_id: string | null;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  invoice_id: string | null;
  reference_month: string | null;
  card_id: string | null;
  card_name: string | null;
  original_payment_id: string | null;
};

type CursorPayload = {
  v: 1;
  accountId: string;
  from: string;
  to: string;
  filter: AccountStatementEventFilter;
  eventDate: string;
  eventType: AccountStatementEventType;
  sourceType: AccountStatementEntityType;
  sourceId: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const REFERENCE_MONTH_PATTERN = /^\d{4}-\d{2}$/u;
const EVENT_TYPES = new Set<AccountStatementEventType>(["income", "expense", "expected_income_receipt", "expected_income_reversal", "invoice_payment", "invoice_payment_reversal"]);
const FILTERS = new Set<AccountStatementEventFilter>(["all", ...EVENT_TYPES]);
const SOURCE_TYPES = new Set<AccountStatementEntityType>(["transaction", "expected_income_operation", "invoice_payment", "invoice_payment_operation"]);
const CURSOR_KEYS = ["accountId", "eventDate", "eventType", "filter", "from", "sourceId", "sourceType", "to", "v"];

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validIdentifier(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && Boolean(value.replace(/[\p{White_Space}\p{Cc}\p{Cf}]/gu, ""));
}

function safeInteger(value: unknown, minimum = Number.MIN_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function encodeBase64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeBase64Url(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function invalidCursor(): never {
  throw new AccountStatementError("Cursor do extrato inválido.", 400, "ACCOUNT_STATEMENT_INVALID_CURSOR");
}

function parseCursor(raw: string | null | undefined, scope: Omit<CursorPayload, "v" | "eventDate" | "eventType" | "sourceType" | "sourceId">) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(raw)) invalidCursor();
  try {
    const parsed = JSON.parse(decodeBase64Url(raw)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(CURSOR_KEYS)) invalidCursor();
    if (parsed.v !== 1 || parsed.accountId !== scope.accountId || parsed.from !== scope.from
      || parsed.to !== scope.to || parsed.filter !== scope.filter
      || !validDate(parsed.eventDate) || !EVENT_TYPES.has(parsed.eventType as AccountStatementEventType)
      || !SOURCE_TYPES.has(parsed.sourceType as AccountStatementEntityType) || !validIdentifier(parsed.sourceId)) invalidCursor();
    return parsed as CursorPayload;
  } catch (error) {
    if (error instanceof AccountStatementError) throw error;
    invalidCursor();
  }
}

function encodeCursor(item: AccountStatementItem, scope: Pick<CursorPayload, "accountId" | "from" | "to" | "filter">) {
  const payload: CursorPayload = {
    v: 1,
    ...scope,
    eventDate: item.eventDate,
    eventType: item.eventType,
    sourceType: item.entityType,
    sourceId: item.entityId,
  };
  return encodeBase64Url(JSON.stringify(payload));
}

function parseInput(input: AccountStatementInput, context: AccountStatementContext) {
  if (!validIdentifier(input.accountId, 100) || !validDate(input.from) || !validDate(input.to) || input.from > input.to) {
    throw new AccountStatementError("Parâmetros do extrato inválidos.", 400, "ACCOUNT_STATEMENT_INVALID_INPUT");
  }
  const today = dateInTimeZone(context.now ?? new Date());
  if (input.to > today) {
    throw new AccountStatementError("O período do extrato não pode incluir datas futuras.", 400, "ACCOUNT_STATEMENT_FUTURE_PERIOD");
  }
  const filter = input.eventType ?? "all";
  if (!FILTERS.has(filter)) {
    throw new AccountStatementError("Filtro do extrato inválido.", 400, "ACCOUNT_STATEMENT_INVALID_FILTER");
  }
  const limit = input.limit ?? ACCOUNT_STATEMENT_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ACCOUNT_STATEMENT_MAX_LIMIT) {
    throw new AccountStatementError("Limite do extrato inválido.", 400, "ACCOUNT_STATEMENT_INVALID_LIMIT");
  }
  const scope = { accountId: input.accountId, from: input.from, to: input.to, filter };
  return { ...scope, limit, cursor: parseCursor(input.cursor, scope) };
}

function formatReferenceMonth(value: string | null) {
  if (!value || !REFERENCE_MONTH_PATTERN.test(value)) return null;
  return `${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

function paymentDescription(prefix: string, cardName: string | null, referenceMonth: string | null) {
  const parts = [prefix];
  if (cardName) parts.push(cardName);
  const formattedMonth = formatReferenceMonth(referenceMonth);
  if (formattedMonth) parts.push(formattedMonth);
  return parts.join(" · ");
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapItem(row: StatementRow): AccountStatementItem {
  if (!row.source_type || !SOURCE_TYPES.has(row.source_type) || !validIdentifier(row.source_id)
    || !validDate(row.event_date) || !row.event_type || !EVENT_TYPES.has(row.event_type)
    || !safeInteger(row.amount_cents, 1) || !safeInteger(row.signed_amount_cents)) {
    throw new AccountStatementError("Os dados financeiros do extrato estão inconsistentes.", 409, "ACCOUNT_STATEMENT_INCONSISTENT");
  }
  const credit = row.event_type === "income" || row.event_type === "expected_income_receipt" || row.event_type === "invoice_payment_reversal";
  if ((credit && row.signed_amount_cents !== row.amount_cents)
    || (!credit && row.signed_amount_cents !== -row.amount_cents)) {
    throw new AccountStatementError("Os dados financeiros do extrato estão inconsistentes.", 409, "ACCOUNT_STATEMENT_INCONSISTENT");
  }
  const description = row.event_type === "expected_income_receipt"
    ? `Recebimento de entrada prevista · ${nullableString(row.transaction_description) ?? "Entrada prevista"}`
    : row.event_type === "expected_income_reversal"
      ? `Estorno de entrada prevista · ${nullableString(row.transaction_description) ?? "Entrada prevista"}`
      : row.event_type === "invoice_payment"
    ? paymentDescription("Pagamento de fatura", row.card_name, row.reference_month)
    : row.event_type === "invoice_payment_reversal"
      ? paymentDescription("Reversão de pagamento", row.card_name, row.reference_month)
      : nullableString(row.transaction_description);
  if (!description) {
    throw new AccountStatementError("Os dados financeiros do extrato estão inconsistentes.", 409, "ACCOUNT_STATEMENT_INCONSISTENT");
  }
  return {
    id: `${row.source_type}:${row.source_id}`,
    eventType: row.event_type,
    direction: credit ? "credit" : "debit",
    eventDate: row.event_date,
    description,
    amountCents: row.amount_cents,
    signedAmountCents: row.signed_amount_cents,
    entityType: row.source_type,
    entityId: row.source_id,
    categoryId: nullableString(row.category_id),
    categoryName: nullableString(row.category_name),
    subcategoryId: nullableString(row.subcategory_id),
    subcategoryName: nullableString(row.subcategory_name),
    paymentMethod: nullableString(row.payment_method),
    invoiceId: nullableString(row.invoice_id),
    referenceMonth: nullableString(row.reference_month),
    cardId: nullableString(row.card_id),
    cardName: nullableString(row.card_name),
    originalPaymentId: nullableString(row.original_payment_id),
  };
}

function statementSql(filter: AccountStatementEventFilter, withCursor: boolean) {
  const filterSql = filter === "all" ? "" : " AND e.event_type = ?";
  const cursorSql = withCursor
    ? " AND (e.event_date, e.event_type, e.source_type, e.source_id) < (?, ?, ?, ?)"
    : "";
  return `${ACCOUNT_BANK_EVENTS_CTE},
summary AS (
  SELECT
    COALESCE(SUM(CASE WHEN e.event_date < ? THEN e.signed_amount_cents ELSE 0 END), 0) AS pre_period_net_cents,
    COALESCE(SUM(CASE WHEN e.event_date >= ? AND e.signed_amount_cents > 0 THEN e.signed_amount_cents ELSE 0 END), 0) AS period_credits_cents,
    COALESCE(SUM(CASE WHEN e.event_date >= ? AND e.signed_amount_cents < 0 THEN -e.signed_amount_cents ELSE 0 END), 0) AS period_debits_cents
  FROM account_bank_events e
  WHERE e.household_id = ? AND e.account_id = ? AND e.event_date <= ?
),
eligible AS (
  SELECT e.*
  FROM account_bank_events e
  WHERE e.household_id = ? AND e.account_id = ? AND e.event_date BETWEEN ? AND ?${filterSql}${cursorSql}
  ORDER BY e.event_date DESC, e.event_type DESC, e.source_type DESC, e.source_id DESC
  LIMIT ?
),
items AS (
  SELECT
    e.source_type,
    e.source_id,
    e.event_date,
    e.signed_amount_cents,
    e.event_type,
    e.amount_cents,
    COALESCE(t.description, expected_transaction.description) AS transaction_description,
    COALESCE(t.payment_method, expected_transaction.payment_method) AS payment_method,
    COALESCE(t.category_id, expected_transaction.category_id) AS category_id,
    c.name AS category_name,
    COALESCE(t.subcategory_id, expected_transaction.subcategory_id) AS subcategory_id,
    sc.name AS subcategory_name,
    i.id AS invoice_id,
    i.reference_month,
    i.card_id,
    card.name AS card_name,
    original.id AS original_payment_id
  FROM eligible e
  LEFT JOIN transactions t
    ON e.source_type = 'transaction' AND t.household_id = e.household_id
      AND t.account_id = e.account_id AND t.id = e.source_id
  LEFT JOIN expected_income_operations expected_operation
    ON e.source_type = 'expected_income_operation' AND expected_operation.operation_type = 'reverse'
      AND expected_operation.household_id = e.household_id AND expected_operation.id = e.source_id
  LEFT JOIN transactions expected_transaction
    ON expected_transaction.household_id = expected_operation.household_id
      AND expected_transaction.account_id = e.account_id AND expected_transaction.id = expected_operation.transaction_id
  LEFT JOIN categories c
    ON c.household_id = e.household_id AND c.id = COALESCE(t.category_id, expected_transaction.category_id)
  LEFT JOIN subcategories sc
    ON sc.household_id = e.household_id AND sc.category_id = COALESCE(t.category_id, expected_transaction.category_id) AND sc.id = COALESCE(t.subcategory_id, expected_transaction.subcategory_id)
  LEFT JOIN invoice_payments p
    ON e.source_type = 'invoice_payment' AND p.household_id = e.household_id
      AND p.account_id = e.account_id AND p.id = e.source_id
  LEFT JOIN invoice_payment_operations o
    ON e.source_type = 'invoice_payment_operation' AND o.kind = 'reversal'
      AND o.household_id = e.household_id AND o.account_id = e.account_id AND o.id = e.source_id
  LEFT JOIN card_invoices i
    ON i.household_id = e.household_id AND i.id = COALESCE(p.invoice_id, o.invoice_id)
  LEFT JOIN credit_cards card
    ON card.household_id = i.household_id AND card.id = i.card_id
  LEFT JOIN invoice_payments original
    ON o.kind = 'reversal' AND original.household_id = o.household_id
      AND original.invoice_id = o.invoice_id AND original.account_id = o.account_id
      AND original.amount_cents = o.amount_cents AND original.id = o.reversed_payment_id
)
SELECT summary.*, items.*
FROM summary
LEFT JOIN items ON 1 = 1
ORDER BY items.event_date DESC, items.event_type DESC, items.source_type DESC, items.source_id DESC`;
}

export async function getAccountStatement(
  input: AccountStatementInput,
  context: AccountStatementContext,
): Promise<AccountStatementResponse> {
  const parsed = parseInput(input, context);
  const account = await context.d1.prepare(`SELECT id, name, initial_balance_cents, is_active
    FROM accounts WHERE id = ? AND household_id = ? LIMIT 1`)
    .bind(parsed.accountId, context.householdId).first<AccountRow>();
  if (!account) throw new AccountStatementError("Conta não encontrada.", 404, "ACCOUNT_STATEMENT_ACCOUNT_NOT_FOUND");
  if (!safeInteger(account.initial_balance_cents) || ![0, 1].includes(account.is_active)) {
    throw new AccountStatementError("Os dados financeiros da conta estão inconsistentes.", 409, "ACCOUNT_STATEMENT_INCONSISTENT");
  }

  const bindings: unknown[] = [
    context.householdId,
    context.householdId,
    parsed.from,
    parsed.from,
    parsed.from,
    context.householdId,
    parsed.accountId,
    parsed.to,
    context.householdId,
    parsed.accountId,
    parsed.from,
    parsed.to,
  ];
  if (parsed.filter !== "all") bindings.push(parsed.filter);
  if (parsed.cursor) bindings.push(parsed.cursor.eventDate, parsed.cursor.eventType, parsed.cursor.sourceType, parsed.cursor.sourceId);
  bindings.push(parsed.limit + 1);

  const result = await context.d1.prepare(statementSql(parsed.filter, parsed.cursor !== null))
    .bind(...bindings).all<StatementRow>();
  const rows = result.results;
  const summaryRow = rows[0];
  if (!summaryRow || !safeInteger(summaryRow.pre_period_net_cents)
    || !safeInteger(summaryRow.period_credits_cents, 0) || !safeInteger(summaryRow.period_debits_cents, 0)) {
    throw new AccountStatementError("Os dados financeiros do extrato estão inconsistentes.", 409, "ACCOUNT_STATEMENT_INCONSISTENT");
  }
  const mapped = rows.filter((row) => row.source_id !== null).map(mapItem);
  const hasMore = mapped.length > parsed.limit;
  const items = hasMore ? mapped.slice(0, parsed.limit) : mapped;
  const periodNetCents = summaryRow.period_credits_cents - summaryRow.period_debits_cents;
  const openingBalanceCents = account.initial_balance_cents + summaryRow.pre_period_net_cents;
  const closingBalanceCents = openingBalanceCents + periodNetCents;
  if (![periodNetCents, openingBalanceCents, closingBalanceCents].every((value) => Number.isSafeInteger(value))) {
    throw new AccountStatementError("Os dados financeiros do extrato estão inconsistentes.", 409, "ACCOUNT_STATEMENT_INCONSISTENT");
  }
  const cursorScope = { accountId: parsed.accountId, from: parsed.from, to: parsed.to, filter: parsed.filter };
  return {
    account: { id: account.id, name: account.name, isActive: account.is_active === 1 },
    period: { from: parsed.from, to: parsed.to },
    summary: {
      openingBalanceCents,
      periodCreditsCents: summaryRow.period_credits_cents,
      periodDebitsCents: summaryRow.period_debits_cents,
      periodNetCents,
      closingBalanceCents,
    },
    items,
    hasMore,
    nextCursor: hasMore && items.length ? encodeCursor(items.at(-1)!, cursorScope) : null,
  };
}

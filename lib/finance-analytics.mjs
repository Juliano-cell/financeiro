const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const PERIODS = new Set(["this_month", "previous_month", "last_3_months", "last_6_months", "last_12_months", "custom"]);
const MAX_CUSTOM_DAYS = 1_097;

export const FINANCIAL_EVENTS_CTE = `
WITH financial_events AS (
  SELECT
    t.household_id,
    t.id,
    'transaction' AS entity_type,
    t.transaction_date AS event_date,
    substr(t.transaction_date, 1, 7) AS competence_month,
    t.type,
    t.amount_cents,
    t.description,
    t.category_id,
    t.subcategory_id,
    t.account_id,
    NULL AS card_id,
    NULL AS card_name,
    t.responsible_user_id,
    t.payment_method,
    t.origin,
    NULL AS installment_number,
    NULL AS installment_count
  FROM transactions t
  WHERE t.household_id = ? AND t.status = 'confirmed'

  UNION ALL

  SELECT
    ci.household_id,
    ci.id,
    'card_installment' AS entity_type,
    inv.due_date AS event_date,
    inv.reference_month AS competence_month,
    'expense' AS type,
    ci.amount_cents,
    cp.description,
    cp.category_id,
    cp.subcategory_id,
    NULL AS account_id,
    cp.card_id,
    cc.name AS card_name,
    cp.created_by_user_id AS responsible_user_id,
    'credit_card' AS payment_method,
    cp.origin,
    ci.installment_number,
    ci.installment_count
  FROM card_installments ci
  INNER JOIN card_purchases cp
    ON cp.household_id = ci.household_id AND cp.id = ci.purchase_id
  INNER JOIN card_invoices inv
    ON inv.household_id = ci.household_id AND inv.id = ci.invoice_id
  INNER JOIN credit_cards cc
    ON cc.household_id = cp.household_id AND cc.id = cp.card_id
  WHERE ci.household_id = ?
    AND ci.status <> 'cancelled'
    AND cp.status = 'active'
)
`;

export const CURRENT_ACCOUNT_BALANCES_SQL = `
WITH transaction_totals AS (
  SELECT
    account_id,
    SUM(CASE WHEN type = 'income' THEN amount_cents ELSE -amount_cents END) AS net_cents
  FROM transactions
  WHERE household_id = ? AND status = 'confirmed' AND transaction_date <= ?
  GROUP BY account_id
), payment_totals AS (
  SELECT account_id, SUM(signed_cents) AS net_cents
  FROM (
    SELECT household_id, account_id, substr(paid_at, 1, 10) AS event_date, -amount_cents AS signed_cents
    FROM invoice_payments
    UNION ALL
    SELECT household_id, account_id, occurred_on, amount_cents
    FROM invoice_payment_operations WHERE kind = 'reversal'
  )
  WHERE household_id = ? AND event_date <= ?
  GROUP BY account_id
)
SELECT
  a.id AS account_id,
  a.is_active,
  a.initial_balance_cents
    + COALESCE(t.net_cents, 0)
    + COALESCE(p.net_cents, 0) AS current_balance_cents
FROM accounts a
LEFT JOIN transaction_totals t ON t.account_id = a.id
LEFT JOIN payment_totals p ON p.account_id = a.id
WHERE a.household_id = ?
ORDER BY a.id
`;

export const ACCOUNT_MOVEMENTS_CTE = `
WITH account_movements AS (
  SELECT
    t.household_id,
    t.account_id,
    t.transaction_date AS event_date,
    t.amount_cents,
    t.type,
    t.category_id,
    t.subcategory_id,
    t.responsible_user_id
  FROM transactions t
  WHERE t.household_id = ? AND t.status = 'confirmed'

  UNION ALL

  SELECT
    bank.household_id,
    bank.account_id,
    bank.event_date,
    bank.amount_cents,
    bank.type,
    NULL AS category_id,
    NULL AS subcategory_id,
    bank.created_by_user_id AS responsible_user_id
  FROM (
    SELECT household_id, account_id, substr(paid_at, 1, 10) AS event_date, amount_cents, 'settlement' AS type, created_by_user_id
    FROM invoice_payments
    UNION ALL
    SELECT household_id, account_id, occurred_on, amount_cents, 'settlement_reversal', created_by_user_id
    FROM invoice_payment_operations WHERE kind = 'reversal'
  ) bank
  WHERE bank.household_id = ?
)
`;

function parseDate(value) {
  if (!ISO_DATE.test(String(value ?? ""))) throw new Error("Data inválida.");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error("Data inválida.");
  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(value, amount) {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return formatDate(date);
}

export function addMonths(value, amount) {
  const date = parseDate(value);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + amount);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDay));
  return formatDate(date);
}

export function startOfMonth(value) {
  return `${parseDate(value).toISOString().slice(0, 7)}-01`;
}

export function endOfMonth(value) {
  const date = parseDate(startOfMonth(value));
  date.setUTCMonth(date.getUTCMonth() + 1);
  date.setUTCDate(0);
  return formatDate(date);
}

export function differenceInDays(start, end) {
  const difference = parseDate(end).getTime() - parseDate(start).getTime();
  return Math.floor(difference / 86_400_000) + 1;
}

export function dateInTimeZone(now = new Date(), timeZone = "America/Sao_Paulo") {
  const value = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(value.getTime())) throw new Error("Instante inválido.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function previousCalendarMonthRange(currentStart) {
  const previousMonth = addMonths(startOfMonth(currentStart), -1);
  return { start: startOfMonth(previousMonth), end: endOfMonth(previousMonth) };
}

function previousEqualRange(current) {
  const days = differenceInDays(current.start, current.end);
  const end = addDays(current.start, -1);
  return { start: addDays(end, -(days - 1)), end };
}

export function resolveAnalyticsPeriod(input = {}) {
  const period = input.period ?? "this_month";
  if (!PERIODS.has(period)) throw new Error("Período inválido.");
  const today = typeof input.today === "string" ? formatDate(parseDate(input.today)) : dateInTimeZone(input.now);
  let current;
  let previous;

  if (period === "this_month") {
    current = { start: startOfMonth(today), end: today };
    const previousMonth = addMonths(today, -1);
    previous = { start: startOfMonth(previousMonth), end: previousMonth };
  } else if (period === "previous_month") {
    current = previousCalendarMonthRange(startOfMonth(today));
    previous = previousCalendarMonthRange(current.start);
  } else if (period === "custom") {
    if (!input.from || !input.to) throw new Error("Informe as datas inicial e final.");
    current = { start: formatDate(parseDate(input.from)), end: formatDate(parseDate(input.to)) };
    if (current.end < current.start) throw new Error("A data final não pode ser anterior à inicial.");
    if (differenceInDays(current.start, current.end) > MAX_CUSTOM_DAYS) throw new Error("O período personalizado não pode ultrapassar 36 meses.");
    previous = previousEqualRange(current);
  } else {
    const months = Number(period.match(/\d+/u)?.[0]);
    current = { start: startOfMonth(addMonths(today, -(months - 1))), end: today };
    previous = previousEqualRange(current);
  }

  return { preset: period, today, current, previous, days: differenceInDays(current.start, current.end) };
}

export function listMonths(start, end) {
  parseDate(start);
  parseDate(end);
  if (end < start) return [];
  const result = [];
  let cursor = startOfMonth(start);
  const last = startOfMonth(end);
  while (cursor <= last) {
    result.push(cursor.slice(0, 7));
    cursor = startOfMonth(addMonths(cursor, 1));
  }
  return result;
}

export function previousCompleteMonths(beforeDate, count = 3) {
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error("Quantidade de meses inválida.");
  const firstCurrentMonth = startOfMonth(beforeDate);
  return Array.from({ length: count }, (_, index) => startOfMonth(addMonths(firstCurrentMonth, index - count)).slice(0, 7));
}

export function calculateComparison(currentCents, previousCents) {
  const current = Number.isFinite(currentCents) ? Math.round(currentCents) : 0;
  const previous = Number.isFinite(previousCents) ? Math.round(previousCents) : 0;
  const absoluteChangeCents = current - previous;
  if (previous === 0) {
    return {
      currentCents: current,
      previousCents: previous,
      absoluteChangeCents,
      percentChange: null,
      direction: current === 0 ? "stable" : "new",
      hasComparableHistory: false,
    };
  }
  const percentChange = Math.round((absoluteChangeCents * 10_000) / Math.abs(previous)) / 100;
  return {
    currentCents: current,
    previousCents: previous,
    absoluteChangeCents,
    percentChange: Number.isFinite(percentChange) ? percentChange : null,
    direction: absoluteChangeCents > 0 ? "increase" : absoluteChangeCents < 0 ? "decrease" : "stable",
    hasComparableHistory: true,
  };
}

export function calculateHistoricalAverage(values, minimumSamples = 2) {
  const samples = values.filter(Number.isFinite).map((value) => Math.round(value));
  if (samples.length < minimumSamples) return { averageCents: null, samples: samples.length, sufficientHistory: false };
  const averageCents = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  return { averageCents, samples: samples.length, sufficientHistory: true };
}

export function detectDeterministicTrend(values) {
  const samples = values.filter(Number.isFinite).map((value) => Math.round(value));
  if (samples.length < 3) return { direction: "insufficient", samples: samples.length };
  const last = samples.slice(-3);
  if (last[0] < last[1] && last[1] < last[2]) return { direction: "increasing", samples: 3 };
  if (last[0] > last[1] && last[1] > last[2]) return { direction: "decreasing", samples: 3 };
  if (last[0] === last[1] && last[1] === last[2]) return { direction: "stable", samples: 3 };
  return { direction: "mixed", samples: 3 };
}

export function safeShare(amountCents, totalCents) {
  if (!Number.isFinite(amountCents) || !Number.isFinite(totalCents) || totalCents <= 0) return 0;
  const value = Math.round((amountCents * 10_000) / totalCents) / 100;
  return Number.isFinite(value) ? value : 0;
}

/**
 * @param {{ expenseComparison: Record<string, any>, categories?: Array<Record<string, any>>, subcategories?: Array<Record<string, any>> }} input
 * @returns {Array<{ key: string, tone: "positive" | "warning" | "neutral", message: string }>}
 */
export function buildDeterministicInsights({ expenseComparison, categories = [], subcategories = [] }) {
  const insights = [];
  if (expenseComparison.currentCents > 0) {
    if (expenseComparison.hasComparableHistory && Math.abs(expenseComparison.percentChange ?? 0) >= 5) {
      insights.push({
        key: "expense_change",
        tone: expenseComparison.absoluteChangeCents > 0 ? "warning" : "positive",
        message: `As despesas ${expenseComparison.absoluteChangeCents > 0 ? "aumentaram" : "diminuíram"} ${Math.abs(expenseComparison.percentChange)}% em relação ao período anterior.`,
      });
    } else if (!expenseComparison.hasComparableHistory) {
      insights.push({ key: "expense_no_base", tone: "neutral", message: "Ainda não há uma base anterior suficiente para comparar as despesas deste período." });
    }
  }

  const topCategory = categories.filter((item) => item.currentCents > 0).sort((a, b) => b.currentCents - a.currentCents)[0];
  if (topCategory) insights.push({ key: "top_category", tone: topCategory.sharePercent >= 40 ? "warning" : "neutral", message: `${topCategory.name} foi a maior categoria, com ${topCategory.sharePercent}% das despesas.` });
  const topSubcategory = subcategories.filter((item) => item.currentCents > 0 && item.id !== null).sort((a, b) => b.currentCents - a.currentCents)[0];
  if (topSubcategory) insights.push({ key: "top_subcategory", tone: "neutral", message: `${topSubcategory.name} foi a subcategoria com maior gasto no período.` });

  const rising = categories.find((item) => item.trend?.direction === "increasing");
  if (rising) insights.push({ key: `trend:${rising.id ?? "none"}`, tone: "warning", message: `${rising.name} aumentou por três meses consecutivos.` });
  return insights.slice(0, 5);
}

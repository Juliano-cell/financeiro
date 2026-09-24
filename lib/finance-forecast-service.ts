import {
  addMonths,
  CURRENT_ACCOUNT_BALANCES_SQL,
  dateInTimeZone,
  endOfMonth,
  startOfMonth,
} from "./finance-analytics.mjs";
import type {
  FinanceForecastResponse,
  ForecastDetail,
  ForecastMonth,
  ForecastWarning,
} from "./finance-forecast-types";

export const FORECAST_DEFAULT_MONTHS = 6;
export const FORECAST_MAX_MONTHS = 24;
export const FORECAST_TIMEZONE = "America/Sao_Paulo" as const;

type ForecastContext = { d1: D1Database; householdId: string; now?: Date };
type SqlRow = Record<string, unknown>;

export class FinanceForecastIntegrityError extends Error {}

export const FUTURE_TRANSACTIONS_SQL = `
SELECT
  t.id,
  t.type,
  t.amount_cents,
  t.description,
  t.transaction_date,
  t.account_id
FROM transactions t
INNER JOIN accounts a
  ON a.household_id = t.household_id
 AND a.id = t.account_id
 AND a.is_active = 1
WHERE t.household_id = ?
  AND t.status = 'confirmed'
  AND t.transaction_date > ?
  AND t.transaction_date <= ?
ORDER BY t.transaction_date, t.id`;

export const PENDING_EXPECTED_INCOME_SQL = `
SELECT
  o.id,
  o.series_id,
  o.description,
  o.expected_amount_cents,
  o.expected_date,
  o.planned_account_id
FROM expected_income_occurrences o
WHERE o.household_id = ?
  AND o.status = 'pending'
  AND o.expected_date <= ?
ORDER BY o.expected_date, o.id`;

export const EXPECTED_INCOME_COVERAGE_SQL = `
SELECT
  s.id,
  s.ends_on,
  s.materialized_through_month
FROM expected_income_series s
WHERE s.household_id = ?
  AND s.is_active = 1
  AND s.starts_on <= ?
ORDER BY s.id`;

export const PENDING_BILLS_SQL = `
SELECT
  b.id,
  b.description,
  b.amount_cents,
  b.due_date,
  b.recurrence,
  b.recurrence_series_id,
  o.series_id AS installment_series_id,
  o.installment_number,
  s.installment_count
FROM bills b
LEFT JOIN bill_installment_occurrences o
  ON o.household_id = b.household_id
 AND o.bill_id = b.id
LEFT JOIN bill_installment_series s
  ON s.household_id = o.household_id
 AND s.id = o.series_id
WHERE b.household_id = ?
  AND b.status = 'pending'
  AND b.due_date <= ?
ORDER BY b.due_date, b.id`;

// This intentionally mirrors the invoice ledger used by invoice-service. The
// forecast consumes only the remaining invoice balance; purchases and
// installments are never added again as cash obligations.
export const FORECAST_INVOICES_SQL = `
WITH invoice_totals AS (
  SELECT
    i.id,
    i.card_id,
    i.due_date,
    c.name AS card_name,
    COALESCE((
      SELECT SUM(s.amount_cents)
      FROM card_installments s
      WHERE s.household_id = i.household_id
        AND s.invoice_id = i.id
        AND s.status <> 'cancelled'
    ), 0)
    + COALESCE((
      SELECT SUM(a.amount_cents)
      FROM card_invoice_adjustments a
      WHERE a.household_id = i.household_id
        AND a.invoice_id = i.id
        AND a.status = 'active'
    ), 0)
    - COALESCE((
      SELECT SUM(o.amount_cents)
      FROM card_opening_balance_allocations o
      WHERE o.household_id = i.household_id
        AND o.invoice_id = i.id
    ), 0) AS invoice_total_cents,
    COALESCE((
      SELECT SUM(p.amount_cents)
      FROM invoice_payments p
      WHERE p.household_id = i.household_id
        AND p.invoice_id = i.id
        AND NOT EXISTS (
          SELECT 1
          FROM invoice_payment_operations r
          WHERE r.household_id = p.household_id
            AND r.reversed_payment_id = p.id
            AND r.kind = 'reversal'
        )
    ), 0) AS paid_cents
  FROM card_invoices i
  INNER JOIN credit_cards c
    ON c.household_id = i.household_id
   AND c.id = i.card_id
  WHERE i.household_id = ?
    AND i.due_date <= ?
)
SELECT
  id,
  card_id,
  card_name,
  due_date,
  invoice_total_cents,
  paid_cents,
  MAX(invoice_total_cents - paid_cents, 0) AS remaining_cents
FROM invoice_totals
WHERE invoice_total_cents > paid_cents
ORDER BY due_date, id`;

export const RECURRENCE_COVERAGE_SQL = `
SELECT
  r.id,
  r.description,
  r.starts_on,
  r.ends_on,
  MAX(b.due_date) AS max_due_date
FROM recurring_bill_series r
LEFT JOIN bills b
  ON b.household_id = r.household_id
 AND b.recurrence_series_id = r.id
WHERE r.household_id = ?
  AND r.is_active = 1
  AND r.starts_on <= ?
GROUP BY r.id, r.description, r.starts_on, r.ends_on
ORDER BY r.id`;

function rows(result: D1Result<unknown> | undefined): SqlRow[] {
  return (result?.results ?? []) as SqlRow[];
}

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new FinanceForecastIntegrityError(`Campo inválido na previsão: ${key}.`);
  return value;
}

function nullableText(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw new FinanceForecastIntegrityError(`Campo inválido na previsão: ${key}.`);
  return value;
}

function money(row: SqlRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new FinanceForecastIntegrityError(`Valor monetário inválido na previsão: ${key}.`);
  return value;
}

function signedMoney(row: SqlRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new FinanceForecastIntegrityError(`Valor monetário inválido na previsão: ${key}.`);
  return value;
}

function positiveInteger(row: SqlRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 1) throw new FinanceForecastIntegrityError(`Número inválido na previsão: ${key}.`);
  return value;
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new FinanceForecastIntegrityError("A projeção excedeu o limite monetário seguro.");
  return value;
}

function monthOf(date: string) {
  return date.slice(0, 7);
}

function allocationMonth(date: string, today: string, firstMonth: string) {
  return date < today ? firstMonth : monthOf(date);
}

function emptyMonth(month: string): ForecastMonth {
  return {
    month,
    openingBalanceCents: 0,
    knownFutureIncomeCents: 0,
    futureIncomeCents: 0,
    expectedIncomeCents: 0,
    overdueExpectedIncomeCents: 0,
    futureTransactionExpenseCents: 0,
    overdueBillsCents: 0,
    dueBillsCents: 0,
    cardInvoiceRemainingCents: 0,
    knownOutflowCents: 0,
    projectedNetCashFlowCents: 0,
    closingBalanceCents: 0,
    details: {
      futureTransactions: [], expectedIncome: [], overdueExpectedIncome: [],
      overdueBills: [], dueBills: [], cardInvoices: [],
    },
  };
}

function detail(input: Omit<ForecastDetail, "allocationMonth"> & { allocationMonth: string }): ForecastDetail {
  return input;
}

export function resolveForecastWindow(now: Date, months = FORECAST_DEFAULT_MONTHS) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("Data de corte inválida.");
  if (!Number.isInteger(months) || months < 1 || months > FORECAST_MAX_MONTHS) throw new RangeError(`O horizonte deve ter entre 1 e ${FORECAST_MAX_MONTHS} meses.`);
  const today = dateInTimeZone(now, FORECAST_TIMEZONE);
  const firstMonth = monthOf(startOfMonth(today));
  const throughMonth = monthOf(addMonths(`${firstMonth}-01`, months - 1));
  return {
    asOf: now.toISOString(),
    today,
    firstMonth,
    throughMonth,
    horizonEnd: endOfMonth(`${throughMonth}-01`),
    monthKeys: Array.from({ length: months }, (_, index) => monthOf(addMonths(`${firstMonth}-01`, index))),
  };
}

export async function getFinanceForecast(context: ForecastContext, months = FORECAST_DEFAULT_MONTHS): Promise<FinanceForecastResponse> {
  const now = context.now ?? new Date();
  const window = resolveForecastWindow(now, months);
  const statements = [
    context.d1.prepare(CURRENT_ACCOUNT_BALANCES_SQL).bind(context.householdId, window.today, context.householdId, window.today, context.householdId),
    context.d1.prepare(FUTURE_TRANSACTIONS_SQL).bind(context.householdId, window.today, window.horizonEnd),
    context.d1.prepare(PENDING_EXPECTED_INCOME_SQL).bind(context.householdId, window.horizonEnd),
    context.d1.prepare(PENDING_BILLS_SQL).bind(context.householdId, window.horizonEnd),
    context.d1.prepare(FORECAST_INVOICES_SQL).bind(context.householdId, window.horizonEnd),
    context.d1.prepare(RECURRENCE_COVERAGE_SQL).bind(context.householdId, window.horizonEnd),
    context.d1.prepare(EXPECTED_INCOME_COVERAGE_SQL).bind(context.householdId, window.horizonEnd),
  ];
  const [
    balanceResult, transactionResult, expectedIncomeResult, billResult, invoiceResult,
    recurrenceResult, expectedIncomeCoverageResult,
  ] = await context.d1.batch<unknown>(statements);
  const balanceRows = rows(balanceResult);
  let currentBalanceCents = 0;
  for (const row of balanceRows) {
    if (Number(row.is_active) !== 1) continue;
    currentBalanceCents = checkedAdd(currentBalanceCents, signedMoney(row, "current_balance_cents"));
  }

  const monthsByKey = new Map(window.monthKeys.map((month) => [month, emptyMonth(month)]));

  const transactionRows = rows(transactionResult);
  for (const row of transactionRows) {
    const originalDate = text(row, "transaction_date");
    const allocated = monthOf(originalDate);
    const target = monthsByKey.get(allocated);
    if (!target) throw new FinanceForecastIntegrityError("Movimento futuro fora do horizonte consultado.");
    const amountCents = money(row, "amount_cents");
    const direction = row.type === "income" ? "income" : row.type === "expense" ? "outflow" : null;
    if (!direction) throw new FinanceForecastIntegrityError("Tipo de movimento futuro inválido.");
    const item = detail({
      id: text(row, "id"), source: "transaction", direction, description: text(row, "description"), amountCents,
      originalDate, allocationMonth: allocated, status: "confirmed", qualification: "registered", overdue: false,
      installment: null, recurrenceSeriesId: null,
    });
    target.details.futureTransactions.push(item);
    if (direction === "income") {
      target.futureIncomeCents = checkedAdd(target.futureIncomeCents, amountCents);
      target.knownFutureIncomeCents = checkedAdd(target.knownFutureIncomeCents, amountCents);
    }
    else target.futureTransactionExpenseCents = checkedAdd(target.futureTransactionExpenseCents, amountCents);
  }

  const expectedIncomeRows = rows(expectedIncomeResult);
  for (const row of expectedIncomeRows) {
    const originalDate = text(row, "expected_date");
    const allocated = allocationMonth(originalDate, window.today, window.firstMonth);
    const target = monthsByKey.get(allocated);
    if (!target) throw new FinanceForecastIntegrityError("Receita prevista fora do horizonte consultado.");
    const amountCents = money(row, "expected_amount_cents");
    const overdue = originalDate < window.today;
    const item = detail({
      id: text(row, "id"), source: "expected_income", direction: "income",
      description: text(row, "description"), amountCents, originalDate, allocationMonth: allocated,
      status: "pending", qualification: nullableText(row, "series_id") ? "materialized_recurring" : "registered",
      overdue, installment: null, recurrenceSeriesId: nullableText(row, "series_id"),
    });
    if (overdue) {
      target.overdueExpectedIncomeCents = checkedAdd(target.overdueExpectedIncomeCents, amountCents);
      target.details.overdueExpectedIncome.push(item);
    } else {
      target.expectedIncomeCents = checkedAdd(target.expectedIncomeCents, amountCents);
      target.details.expectedIncome.push(item);
    }
  }

  for (const row of rows(billResult)) {
    const originalDate = text(row, "due_date");
    const allocated = allocationMonth(originalDate, window.today, window.firstMonth);
    const target = monthsByKey.get(allocated);
    if (!target) throw new FinanceForecastIntegrityError("Vencimento fora do horizonte consultado.");
    const amountCents = money(row, "amount_cents");
    const installmentSeriesId = nullableText(row, "installment_series_id");
    const recurrenceSeriesId = nullableText(row, "recurrence_series_id");
    const isInstallment = installmentSeriesId !== null;
    const isRecurring = !isInstallment && row.recurrence === "monthly" && recurrenceSeriesId !== null;
    const overdue = originalDate < window.today;
    const item = detail({
      id: text(row, "id"),
      source: isInstallment ? "bill_installment" : isRecurring ? "recurring_bill" : "bill",
      direction: "outflow",
      description: text(row, "description"),
      amountCents,
      originalDate,
      allocationMonth: allocated,
      status: "pending",
      qualification: isRecurring ? "materialized_recurring" : "registered",
      overdue,
      installment: isInstallment ? {
        seriesId: installmentSeriesId,
        number: positiveInteger(row, "installment_number"),
        count: positiveInteger(row, "installment_count"),
      } : null,
      recurrenceSeriesId: isRecurring ? recurrenceSeriesId : null,
    });
    if (overdue) {
      target.overdueBillsCents = checkedAdd(target.overdueBillsCents, amountCents);
      target.details.overdueBills.push(item);
    } else {
      target.dueBillsCents = checkedAdd(target.dueBillsCents, amountCents);
      target.details.dueBills.push(item);
    }
  }

  for (const row of rows(invoiceResult)) {
    const invoiceTotalCents = money(row, "invoice_total_cents");
    const paidCents = money(row, "paid_cents");
    const remainingCents = money(row, "remaining_cents");
    if (paidCents > invoiceTotalCents || remainingCents !== invoiceTotalCents - paidCents || remainingCents === 0) {
      throw new FinanceForecastIntegrityError("Saldo restante de fatura inconsistente.");
    }
    const originalDate = text(row, "due_date");
    const allocated = allocationMonth(originalDate, window.today, window.firstMonth);
    const target = monthsByKey.get(allocated);
    if (!target) throw new FinanceForecastIntegrityError("Fatura fora do horizonte consultado.");
    target.cardInvoiceRemainingCents = checkedAdd(target.cardInvoiceRemainingCents, remainingCents);
    target.details.cardInvoices.push(detail({
      id: text(row, "id"), source: "card_invoice", direction: "outflow",
      description: `Fatura · ${text(row, "card_name")}`, amountCents: remainingCents,
      originalDate, allocationMonth: allocated, status: paidCents === 0 ? "unpaid" : "partial",
      qualification: "registered", overdue: originalDate < window.today,
      installment: null, recurrenceSeriesId: null,
    }));
  }

  const warnings: ForecastWarning[] = [{
    code: "UNREGISTERED_INCOME_NOT_INCLUDED",
    message: "Receitas futuras não cadastradas não fazem parte desta projeção.",
  }];
  for (const row of rows(recurrenceResult)) {
    const endsOn = nullableText(row, "ends_on");
    const coverageRequiredThrough = endsOn && endsOn < window.horizonEnd ? endsOn : window.horizonEnd;
    const maxDueDate = nullableText(row, "max_due_date");
    if (maxDueDate && monthOf(maxDueDate) >= monthOf(coverageRequiredThrough)) continue;
    warnings.push({
      code: "RECURRENCE_COVERAGE_LIMITED",
      seriesId: text(row, "id"),
      message: `A recorrência “${text(row, "description")}” não possui ocorrências materializadas em todo o horizonte.`,
    });
  }
  let limitedExpectedIncomeSeries = 0;
  for (const row of rows(expectedIncomeCoverageResult)) {
    const endsOn = nullableText(row, "ends_on");
    const requiredThroughMonth = monthOf(endsOn && endsOn < window.horizonEnd ? endsOn : window.horizonEnd);
    if (text(row, "materialized_through_month") < requiredThroughMonth) limitedExpectedIncomeSeries += 1;
  }
  if (limitedExpectedIncomeSeries > 0) {
    warnings.push({
      code: "EXPECTED_INCOME_COVERAGE_LIMITED",
      count: limitedExpectedIncomeSeries,
      message: "Há séries de receitas previstas sem ocorrências materializadas em todo o horizonte.",
    });
  }
  const futureIncomeTransactions = transactionRows.filter((row) => row.type === "income");
  let possibleOverlapCount = 0;
  for (const occurrence of expectedIncomeRows) {
    const plannedAccountId = nullableText(occurrence, "planned_account_id");
    const amountCents = money(occurrence, "expected_amount_cents");
    const expectedDate = text(occurrence, "expected_date");
    if (futureIncomeTransactions.some((transaction) =>
      money(transaction, "amount_cents") === amountCents
      && text(transaction, "transaction_date") === expectedDate
      && (plannedAccountId === null || text(transaction, "account_id") === plannedAccountId))) {
      possibleOverlapCount += 1;
    }
  }
  if (possibleOverlapCount > 0) {
    warnings.push({
      code: "POSSIBLE_FUTURE_INCOME_OVERLAP",
      count: possibleOverlapCount,
      message: "Há possíveis sobreposições entre receitas futuras confirmadas e receitas previstas pendentes.",
    });
  }

  let openingBalanceCents = currentBalanceCents;
  let knownFutureIncomeCents = 0;
  let expectedIncomeCents = 0;
  let overdueExpectedIncomeCents = 0;
  let knownFutureOutflowCents = 0;
  const monthValues = window.monthKeys.map((key) => {
    const month = monthsByKey.get(key)!;
    month.openingBalanceCents = openingBalanceCents;
    month.knownOutflowCents = checkedAdd(
      checkedAdd(month.futureTransactionExpenseCents, month.overdueBillsCents),
      checkedAdd(month.dueBillsCents, month.cardInvoiceRemainingCents),
    );
    const totalIncomeCents = checkedAdd(
      checkedAdd(month.knownFutureIncomeCents, month.expectedIncomeCents),
      month.overdueExpectedIncomeCents,
    );
    month.projectedNetCashFlowCents = totalIncomeCents - month.knownOutflowCents;
    if (!Number.isSafeInteger(month.projectedNetCashFlowCents)) throw new FinanceForecastIntegrityError("Fluxo mensal fora do limite seguro.");
    month.closingBalanceCents = checkedAdd(month.openingBalanceCents, month.projectedNetCashFlowCents);
    openingBalanceCents = month.closingBalanceCents;
    knownFutureIncomeCents = checkedAdd(knownFutureIncomeCents, month.knownFutureIncomeCents);
    expectedIncomeCents = checkedAdd(expectedIncomeCents, month.expectedIncomeCents);
    overdueExpectedIncomeCents = checkedAdd(overdueExpectedIncomeCents, month.overdueExpectedIncomeCents);
    knownFutureOutflowCents = checkedAdd(knownFutureOutflowCents, month.knownOutflowCents);
    return month;
  });

  return {
    asOf: window.asOf,
    asOfDate: window.today,
    timezone: FORECAST_TIMEZONE,
    basis: "known_cash_only",
    horizon: { months, fromMonth: window.firstMonth, throughMonth: window.throughMonth },
    currentBalanceCents,
    knownFutureIncomeCents,
    expectedIncomeCents,
    overdueExpectedIncomeCents,
    knownFutureOutflowCents,
    projectedEndingBalanceCents: openingBalanceCents,
    months: monthValues,
    warnings,
  };
}

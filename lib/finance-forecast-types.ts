export type ForecastQualification = "registered" | "materialized_recurring";

export type ForecastDetail = {
  id: string;
  source: "transaction" | "expected_income" | "bill" | "bill_installment" | "recurring_bill" | "card_invoice";
  direction: "income" | "outflow";
  description: string;
  amountCents: number;
  originalDate: string;
  allocationMonth: string;
  status: "confirmed" | "pending" | "unpaid" | "partial";
  qualification: ForecastQualification;
  overdue: boolean;
  installment: null | { seriesId: string; number: number; count: number };
  recurrenceSeriesId: string | null;
};

export type ForecastMonth = {
  month: string;
  openingBalanceCents: number;
  knownFutureIncomeCents: number;
  futureIncomeCents: number;
  expectedIncomeCents: number;
  overdueExpectedIncomeCents: number;
  futureTransactionExpenseCents: number;
  overdueBillsCents: number;
  dueBillsCents: number;
  cardInvoiceRemainingCents: number;
  knownOutflowCents: number;
  projectedNetCashFlowCents: number;
  closingBalanceCents: number;
  details: {
    futureTransactions: ForecastDetail[];
    expectedIncome: ForecastDetail[];
    overdueExpectedIncome: ForecastDetail[];
    overdueBills: ForecastDetail[];
    dueBills: ForecastDetail[];
    cardInvoices: ForecastDetail[];
  };
};

export type ForecastWarning = {
  code:
    | "UNREGISTERED_INCOME_NOT_INCLUDED"
    | "RECURRENCE_COVERAGE_LIMITED"
    | "EXPECTED_INCOME_COVERAGE_LIMITED"
    | "POSSIBLE_FUTURE_INCOME_OVERLAP";
  message: string;
  seriesId?: string;
  count?: number;
};

export type FinanceForecastResponse = {
  asOf: string;
  asOfDate: string;
  timezone: "America/Sao_Paulo";
  basis: "known_cash_only";
  horizon: { months: number; fromMonth: string; throughMonth: string };
  currentBalanceCents: number;
  knownFutureIncomeCents: number;
  expectedIncomeCents: number;
  overdueExpectedIncomeCents: number;
  knownFutureOutflowCents: number;
  projectedEndingBalanceCents: number;
  months: ForecastMonth[];
  warnings: ForecastWarning[];
};

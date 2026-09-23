export type ForecastQualification = "registered" | "materialized_recurring";

export type ForecastDetail = {
  id: string;
  source: "transaction" | "bill" | "bill_installment" | "recurring_bill" | "card_invoice";
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
  futureIncomeCents: number;
  futureTransactionExpenseCents: number;
  overdueBillsCents: number;
  dueBillsCents: number;
  cardInvoiceRemainingCents: number;
  knownOutflowCents: number;
  projectedNetCashFlowCents: number;
  closingBalanceCents: number;
  details: {
    futureTransactions: ForecastDetail[];
    overdueBills: ForecastDetail[];
    dueBills: ForecastDetail[];
    cardInvoices: ForecastDetail[];
  };
};

export type ForecastWarning = {
  code: "UNREGISTERED_INCOME_NOT_INCLUDED" | "RECURRENCE_COVERAGE_LIMITED";
  message: string;
  seriesId?: string;
};

export type FinanceForecastResponse = {
  asOf: string;
  asOfDate: string;
  timezone: "America/Sao_Paulo";
  basis: "known_cash_only";
  horizon: { months: number; fromMonth: string; throughMonth: string };
  currentBalanceCents: number;
  knownFutureIncomeCents: number;
  knownFutureOutflowCents: number;
  projectedEndingBalanceCents: number;
  months: ForecastMonth[];
  warnings: ForecastWarning[];
};

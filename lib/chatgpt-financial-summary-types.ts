export type FinancialSummaryWarning = { code: string; message: string };

export type FinancialSummaryAccount = {
  name: string;
  type: "bank" | "cash" | "savings" | "wallet" | "other";
  currentBalanceCents: number;
};

export type FinancialSummaryRealizedItem = {
  date: string;
  competenceMonth: string;
  type: "income" | "expense";
  amountCents: number;
  description: string;
  categoryName: string;
  subcategoryName: string;
  accountName: string;
  paymentMethod: string | null;
  installment: null | { number: number; count: number };
};

export type FinancialSummaryExpectedIncome = {
  description: string;
  expectedAmountCents: number;
  expectedDate: string;
  status: "pending" | "received";
  timing: "pending" | "overdue" | "received";
  plannedAccountName: string | null;
  categoryName: string | null;
  subcategoryName: string | null;
  receivedAmountCents: number | null;
  receivedDate: string | null;
  actualAccountName: string | null;
  recurrence: null | { type: "monthly"; configuredDay: number };
};

export type FinancialSummaryBill = {
  description: string;
  scheduledAmountCents: number;
  dueDate: string;
  status: "pending" | "overdue" | "paid";
  categoryName: string | null;
  subcategoryName: string | null;
  plannedAccountName: string | null;
  actualPaidAmountCents: number | null;
  paidDate: string | null;
  paymentAdjustment: null | { type: "normal" | "surcharge" | "discount"; amountCents: number };
  recurrence: null | { type: "monthly"; configuredDay: number };
  installment: null | { number: number; count: number; originalTotalCents: number };
};

export type FinancialSummaryCardPurchase = {
  purchaseDate: string;
  description: string;
  installmentAmountCents: number;
  installmentNumber: number;
  installmentCount: number;
  purchaseTotalCents: number;
  categoryName: string | null;
  subcategoryName: string | null;
};

export type FinancialSummaryCardInvoice = {
  referenceMonth: string;
  dueDate: string;
  closesOn: string | null;
  invoiceTotalCents: number;
  paidCents: number;
  remainingCents: number;
  cycleStatus: "open" | "closed" | "unknown";
  paymentStatus: "unpaid" | "partial" | "settled";
  openingBalance: null | {
    originalCents: number;
    openingCents: number;
    initialStateInstallmentsCents: number;
    allocatedCents: number;
    residualCents: number;
    identifiedCents: number;
  };
  purchases: FinancialSummaryCardPurchase[];
};

export type FinancialSummaryCard = {
  name: string;
  institution: string;
  isActive: boolean;
  limitCents: number;
  closingDay: number;
  dueDay: number;
  invoices: FinancialSummaryCardInvoice[];
};

export type FinancialSummaryCommitment = {
  source: "transaction" | "expected_income" | "bill" | "bill_installment" | "recurring_bill" | "card_invoice";
  direction: "income" | "outflow";
  description: string;
  amountCents: number;
  originalDate: string;
  allocationMonth: string;
  status: "confirmed" | "pending" | "unpaid" | "partial";
  overdue: boolean;
  installment: null | { number: number; count: number };
};

export type ChatGptFinancialSummaryDto = {
  period: { month: string; generatedAt: string; asOfDate: string; timezone: "America/Sao_Paulo"; isFutureMonth: boolean };
  balances: { basis: "current_as_of_date"; totalAvailableCents: number; accounts: FinancialSummaryAccount[] };
  realized: { basis: "realized_by_competence"; incomeCents: number; expenseCents: number; resultCents: number; items: FinancialSummaryRealizedItem[] };
  expectedIncome: { basis: "planned"; pendingCents: number; overdueCents: number; receivedCents: number; items: FinancialSummaryExpectedIncome[] };
  bills: { basis: "planned_due_date"; pendingCents: number; overdueCents: number; paidScheduledCents: number; paidActualCents: number; items: FinancialSummaryBill[] };
  cards: FinancialSummaryCard[];
  commitments: FinancialSummaryCommitment[];
  projection: {
    basis: "known_cash_only";
    month: string;
    openingBalanceCents: number;
    knownFutureIncomeCents: number;
    expectedIncomeCents: number;
    overdueExpectedIncomeCents: number;
    futureTransactionExpenseCents: number;
    overdueBillsCents: number;
    dueBillsCents: number;
    cardInvoiceRemainingCents: number;
    knownOutflowCents: number;
    projectedNetCashFlowCents: number;
    closingBalanceCents: number;
  };
  warnings: FinancialSummaryWarning[];
};

export type ChatGptFinancialSummaryResponse = {
  month: string;
  generatedAt: string;
  asOfDate: string;
  summaryText: string;
  warnings: FinancialSummaryWarning[];
};

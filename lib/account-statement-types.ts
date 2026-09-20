export type AccountStatementEventType =
  | "income"
  | "expense"
  | "invoice_payment"
  | "invoice_payment_reversal";

export type AccountStatementEventFilter = "all" | AccountStatementEventType;
export type AccountStatementDirection = "credit" | "debit";
export type AccountStatementEntityType = "transaction" | "invoice_payment" | "invoice_payment_operation";

export type AccountStatementItem = {
  id: string;
  eventType: AccountStatementEventType;
  direction: AccountStatementDirection;
  eventDate: string;
  description: string;
  amountCents: number;
  signedAmountCents: number;
  entityType: AccountStatementEntityType;
  entityId: string;
  categoryId: string | null;
  categoryName: string | null;
  subcategoryId: string | null;
  subcategoryName: string | null;
  paymentMethod: string | null;
  invoiceId: string | null;
  referenceMonth: string | null;
  cardId: string | null;
  cardName: string | null;
  originalPaymentId: string | null;
};

export type AccountStatementInput = {
  accountId: string;
  from: string;
  to: string;
  eventType?: AccountStatementEventFilter;
  limit?: number;
  cursor?: string | null;
};

export type AccountStatementResponse = {
  account: {
    id: string;
    name: string;
    isActive: boolean;
  };
  period: {
    from: string;
    to: string;
  };
  summary: {
    openingBalanceCents: number;
    periodCreditsCents: number;
    periodDebitsCents: number;
    periodNetCents: number;
    closingBalanceCents: number;
  };
  items: AccountStatementItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

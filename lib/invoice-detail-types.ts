export type InvoiceDetailItemStatus = "pending" | "paid" | "cancelled";
export type InvoiceDetailOrigin = "web" | "telegram" | "system";

export type InvoiceDetailItem = {
  installmentId: string;
  purchaseId: string;
  purchaseDate: string;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  subcategoryId: string | null;
  subcategoryName: string | null;
  installmentAmountCents: number;
  installmentNumber: number;
  installmentCount: number;
  purchaseTotalCents: number;
  origin: InvoiceDetailOrigin;
  status: InvoiceDetailItemStatus;
  includedInTotal: boolean;
};

export type InvoiceDetailPage = {
  items: InvoiceDetailItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
};

export type InvoiceDetailResponse = {
  invoice: {
    id: string;
    cardId: string;
    cardName: string;
    referenceMonth: string;
    dueDate: string;
    closesOn: string | null;
    invoiceTotalCents: number;
    paidCents: number;
    remainingCents: number;
    cycleStatus: "open" | "closed" | "unknown";
    paymentStatus: "unpaid" | "partial" | "settled";
  };
  active: InvoiceDetailPage;
  cancelled: InvoiceDetailPage;
};

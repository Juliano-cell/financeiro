import { getInvoiceState, InvoiceServiceError, type InvoiceContext } from "./invoice-service";
import type { InvoiceDetailItem, InvoiceDetailPage, InvoiceDetailResponse } from "./invoice-detail-types";

export const INVOICE_DETAIL_DEFAULT_PAGE_SIZE = 20;
export const INVOICE_DETAIL_MAX_PAGE_SIZE = 50;
const MAX_PAGE = 10_000;

export type InvoiceDetailInput = {
  invoiceId: string;
  activePage?: number;
  cancelledPage?: number;
  pageSize?: number;
};

type DetailRow = {
  installment_id: string;
  purchase_id: string;
  purchase_date: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  installment_amount_cents: number;
  installment_number: number;
  installment_count: number;
  purchase_total_cents: number;
  origin: "web" | "telegram" | "system";
  status: "pending" | "paid" | "cancelled";
};

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && Boolean(value.replace(/[\p{White_Space}\p{Cc}\p{Cf}]/gu, ""));
}

function positiveInteger(value: unknown, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function parseInput(input: InvoiceDetailInput) {
  const activePage = input.activePage ?? 1;
  const cancelledPage = input.cancelledPage ?? 1;
  const pageSize = input.pageSize ?? INVOICE_DETAIL_DEFAULT_PAGE_SIZE;
  if (!validIdentifier(input.invoiceId) || !positiveInteger(activePage, MAX_PAGE) || !positiveInteger(cancelledPage, MAX_PAGE) || !positiveInteger(pageSize, INVOICE_DETAIL_MAX_PAGE_SIZE)) {
    throw new InvoiceServiceError("Parâmetros de paginação inválidos.", 400, "INVOICE_DETAIL_INVALID");
  }
  return { invoiceId: input.invoiceId, activePage, cancelledPage, pageSize };
}

function item(row: DetailRow): InvoiceDetailItem {
  const includedInTotal = row.status !== "cancelled";
  return {
    installmentId: row.installment_id,
    purchaseId: row.purchase_id,
    purchaseDate: row.purchase_date,
    description: row.description,
    categoryId: row.category_id,
    categoryName: row.category_name,
    subcategoryId: row.subcategory_id,
    subcategoryName: row.subcategory_name,
    installmentAmountCents: row.installment_amount_cents,
    installmentNumber: row.installment_number,
    installmentCount: row.installment_count,
    purchaseTotalCents: row.purchase_total_cents,
    origin: row.origin,
    status: row.status,
    includedInTotal,
  };
}

function page(rows: DetailRow[], currentPage: number, pageSize: number, totalItems: number): InvoiceDetailPage {
  const totalPages = Math.ceil(totalItems / pageSize);
  return {
    items: rows.map(item),
    page: currentPage,
    pageSize,
    totalItems,
    totalPages,
    hasPreviousPage: currentPage > 1,
    hasNextPage: currentPage < totalPages,
  };
}

const ITEM_SELECT = `SELECT
  s.id AS installment_id,
  p.id AS purchase_id,
  p.purchase_date,
  p.description,
  p.category_id,
  c.name AS category_name,
  p.subcategory_id,
  sc.name AS subcategory_name,
  s.amount_cents AS installment_amount_cents,
  s.installment_number,
  s.installment_count,
  p.total_cents AS purchase_total_cents,
  p.origin,
  s.status
FROM card_installments s
INNER JOIN card_purchases p
  ON p.household_id = s.household_id AND p.id = s.purchase_id
INNER JOIN card_invoices i
  ON i.household_id = s.household_id AND i.id = s.invoice_id
INNER JOIN credit_cards cc
  ON cc.household_id = i.household_id AND cc.id = i.card_id
LEFT JOIN categories c
  ON c.household_id = p.household_id AND c.id = p.category_id
LEFT JOIN subcategories sc
  ON sc.household_id = p.household_id AND sc.id = p.subcategory_id
WHERE s.household_id = ? AND s.invoice_id = ?`;

const ITEM_ORDER = " ORDER BY p.purchase_date, p.created_at, s.installment_number, s.id LIMIT ? OFFSET ?";

export async function getInvoiceDetail(input: InvoiceDetailInput, context: InvoiceContext): Promise<InvoiceDetailResponse> {
  const parsed = parseInput(input);
  // This canonical read performs the active-membership and household-scoped invoice check.
  const state = await getInvoiceState(parsed.invoiceId, context);
  const invoice = await context.d1.prepare(`SELECT i.id, c.name AS card_name
    FROM card_invoices i INNER JOIN credit_cards c ON c.household_id = i.household_id AND c.id = i.card_id
    WHERE i.id = ? AND i.household_id = ? LIMIT 1`).bind(parsed.invoiceId, context.householdId).first<{ id: string; card_name: string }>();
  if (!invoice) throw new InvoiceServiceError("Fatura não encontrada.", 404, "INVOICE_NOT_FOUND");

  const counts = await context.d1.prepare(`SELECT
      SUM(CASE WHEN status <> 'cancelled' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count
    FROM card_installments WHERE household_id = ? AND invoice_id = ?`).bind(context.householdId, parsed.invoiceId).first<{ active_count: number | null; cancelled_count: number | null }>();
  const activeCount = counts?.active_count ?? 0;
  const cancelledCount = counts?.cancelled_count ?? 0;
  const activeOffset = (parsed.activePage - 1) * parsed.pageSize;
  const cancelledOffset = (parsed.cancelledPage - 1) * parsed.pageSize;

  const [activeRows, cancelledRows] = await Promise.all([
    context.d1.prepare(`${ITEM_SELECT} AND s.status <> 'cancelled'${ITEM_ORDER}`).bind(context.householdId, parsed.invoiceId, parsed.pageSize, activeOffset).all<DetailRow>(),
    context.d1.prepare(`${ITEM_SELECT} AND s.status = 'cancelled'${ITEM_ORDER}`).bind(context.householdId, parsed.invoiceId, parsed.pageSize, cancelledOffset).all<DetailRow>(),
  ]);

  return {
    invoice: {
      id: state.invoiceId,
      cardId: state.cardId,
      cardName: invoice.card_name,
      referenceMonth: state.referenceMonth,
      dueDate: state.dueDate,
      closesOn: state.closesOn,
      invoiceTotalCents: state.invoiceTotalCents,
      paidCents: state.paidCents,
      remainingCents: state.remainingCents,
      cycleStatus: state.cycleStatus,
      paymentStatus: state.paymentStatus,
    },
    active: page(activeRows.results, parsed.activePage, parsed.pageSize, activeCount),
    cancelled: page(cancelledRows.results, parsed.cancelledPage, parsed.pageSize, cancelledCount),
  };
}

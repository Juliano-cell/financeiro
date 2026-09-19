import { getInvoiceState, InvoiceServiceError, type InvoiceContext } from "./invoice-service";
import type { InvoiceDetailAdjustment, InvoiceDetailItem, InvoiceDetailPage, InvoiceDetailResponse } from "./invoice-detail-types";
import { resolveInstallmentDisplay } from "./card-onboarding-ui-rules.mjs";

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
  first_original_installment_number: number | null;
  original_installment_count: number | null;
  original_total_cents: number | null;
  valid_import_batch_id: string | null;
  purchase_total_cents: number;
  origin: "web" | "telegram" | "system";
  status: "pending" | "paid" | "cancelled";
};

type AdjustmentRow = {
  adjustment_id: string;
  kind: "opening_balance";
  amount_cents: number;
  status: "active";
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
  const display = resolveInstallmentDisplay({
    physicalNumber: row.installment_number,
    physicalCount: row.installment_count,
    origin: row.origin,
    metadataValid: row.valid_import_batch_id !== null,
    firstOriginalNumber: row.first_original_installment_number,
    originalCount: row.original_installment_count,
  });
  if (!display) throw new InvoiceServiceError("Não foi possível exibir esta fatura porque os dados financeiros estão inconsistentes.", 409, "INVOICE_DETAIL_INCONSISTENT");
  const purchaseTotalCents = row.origin === "system" ? row.original_total_cents : row.purchase_total_cents;
  if (!Number.isSafeInteger(purchaseTotalCents) || purchaseTotalCents === null || purchaseTotalCents <= 0) {
    throw new InvoiceServiceError("Não foi possível exibir esta fatura porque os dados financeiros estão inconsistentes.", 409, "INVOICE_DETAIL_INCONSISTENT");
  }
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
    installmentNumber: display.installmentNumber,
    installmentCount: display.installmentCount,
    purchaseTotalCents,
    origin: row.origin,
    status: row.status,
    includedInTotal,
  };
}

function adjustment(row: AdjustmentRow): InvoiceDetailAdjustment {
  if (!validIdentifier(row.adjustment_id) || row.kind !== "opening_balance" || row.status !== "active"
    || !Number.isSafeInteger(row.amount_cents) || row.amount_cents <= 0) {
    throw new InvoiceServiceError("Não foi possível exibir esta fatura porque os dados financeiros estão inconsistentes.", 409, "INVOICE_DETAIL_INCONSISTENT");
  }
  return {
    adjustmentId: row.adjustment_id,
    itemType: "opening_balance",
    description: "Saldo anterior à implantação",
    amountCents: row.amount_cents,
    status: "active",
    includedInTotal: true,
  };
}

function page(rows: DetailRow[], currentPage: number, pageSize: number, totalItems: number): InvoiceDetailPage {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
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

function assertPageExists(currentPage: number, pageSize: number, totalItems: number) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (currentPage > totalPages) throw new InvoiceServiceError("A página solicitada não existe.", 400, "INVOICE_DETAIL_PAGE_OUT_OF_RANGE");
}

function expectedPageItems(currentPage: number, pageSize: number, totalItems: number) {
  return Math.min(pageSize, Math.max(0, totalItems - (currentPage - 1) * pageSize));
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
  m.first_original_installment_number,
  m.original_installment_count,
  m.original_total_cents,
  ib.id AS valid_import_batch_id,
  p.total_cents AS purchase_total_cents,
  p.origin,
  s.status
FROM card_installments s
INNER JOIN card_purchases p
  ON p.household_id = s.household_id AND p.id = s.purchase_id
INNER JOIN card_invoices i
  ON i.household_id = s.household_id AND i.id = s.invoice_id AND i.card_id = p.card_id
INNER JOIN credit_cards cc
  ON cc.household_id = i.household_id AND cc.id = i.card_id
LEFT JOIN categories c
  ON c.household_id = p.household_id AND c.id = p.category_id
LEFT JOIN subcategories sc
  ON sc.household_id = p.household_id AND sc.id = p.subcategory_id
LEFT JOIN card_purchase_import_metadata m
  ON m.household_id = p.household_id AND m.purchase_id = p.id
LEFT JOIN card_import_batches ib
  ON ib.household_id = m.household_id AND ib.id = m.import_batch_id
  AND ib.card_id = p.card_id AND ib.status = 'completed'
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
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
      SUM(CASE WHEN status <> 'cancelled' THEN amount_cents ELSE 0 END) AS active_total_cents,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM card_purchases p INNER JOIN card_invoices i
          ON i.household_id = card_installments.household_id AND i.id = card_installments.invoice_id
        WHERE p.household_id = card_installments.household_id AND p.id = card_installments.purchase_id
          AND p.card_id = i.card_id
      ) THEN 0 ELSE 1 END) AS invalid_relation_count
    FROM card_installments WHERE household_id = ? AND invoice_id = ?`).bind(context.householdId, parsed.invoiceId).first<{ active_count: number | null; cancelled_count: number | null; active_total_cents: number | null; invalid_relation_count: number | null }>();
  if ((counts?.invalid_relation_count ?? 0) > 0) {
    throw new InvoiceServiceError("Não foi possível exibir esta fatura porque os dados financeiros estão inconsistentes.", 409, "INVOICE_DETAIL_INCONSISTENT");
  }
  const activeCount = counts?.active_count ?? 0;
  const cancelledCount = counts?.cancelled_count ?? 0;
  assertPageExists(parsed.activePage, parsed.pageSize, activeCount);
  assertPageExists(parsed.cancelledPage, parsed.pageSize, cancelledCount);
  const activeOffset = (parsed.activePage - 1) * parsed.pageSize;
  const cancelledOffset = (parsed.cancelledPage - 1) * parsed.pageSize;

  const [activeRows, cancelledRows, adjustmentRows] = await Promise.all([
    context.d1.prepare(`${ITEM_SELECT} AND s.status <> 'cancelled'${ITEM_ORDER}`).bind(context.householdId, parsed.invoiceId, parsed.pageSize, activeOffset).all<DetailRow>(),
    context.d1.prepare(`${ITEM_SELECT} AND s.status = 'cancelled'${ITEM_ORDER}`).bind(context.householdId, parsed.invoiceId, parsed.pageSize, cancelledOffset).all<DetailRow>(),
    context.d1.prepare(`SELECT id AS adjustment_id, kind, amount_cents, status
      FROM card_invoice_adjustments
      WHERE household_id = ? AND invoice_id = ? AND status = 'active'
      ORDER BY created_at, id`).bind(context.householdId, parsed.invoiceId).all<AdjustmentRow>(),
  ]);
  if (activeRows.results.length !== expectedPageItems(parsed.activePage, parsed.pageSize, activeCount)
    || cancelledRows.results.length !== expectedPageItems(parsed.cancelledPage, parsed.pageSize, cancelledCount)) {
    throw new InvoiceServiceError("Não foi possível exibir esta fatura porque os dados financeiros estão inconsistentes.", 409, "INVOICE_DETAIL_INCONSISTENT");
  }
  const adjustments = adjustmentRows.results.map(adjustment);
  const componentTotalCents = (counts?.active_total_cents ?? 0)
    + adjustments.reduce((sum, row) => sum + row.amountCents, 0);
  if (!Number.isSafeInteger(componentTotalCents) || componentTotalCents !== state.invoiceTotalCents) {
    throw new InvoiceServiceError("Não foi possível exibir esta fatura porque os dados financeiros estão inconsistentes.", 409, "INVOICE_DETAIL_INCONSISTENT");
  }

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
    adjustments,
    active: page(activeRows.results, parsed.activePage, parsed.pageSize, activeCount),
    cancelled: page(cancelledRows.results, parsed.cancelledPage, parsed.pageSize, cancelledCount),
  };
}

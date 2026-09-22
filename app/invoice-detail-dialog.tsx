"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cycleStatusLabel, paymentStatusLabel } from "@/lib/invoice-ui-rules.mjs";
import type { InvoiceDetailAdjustment, InvoiceDetailItem, InvoiceDetailPage, InvoiceDetailResponse } from "@/lib/invoice-detail-types";

const PAGE_SIZE = 10;
const money = (value: number) => Number.isSafeInteger(value) ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value / 100) : "Valor indisponível";
const dateLabel = (value: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const monthLabel = (value: string) => value.split("-").reverse().join("/");
const originLabel = (value: InvoiceDetailItem["origin"]) => value === "telegram" ? "Telegram" : value === "system" ? "Sistema" : "Aplicação";

class InvoiceDetailApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "InvoiceDetailApiError"; }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const safeInteger = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
const civilDate = (value: unknown): value is string => {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};
const referenceMonth = (value: unknown): value is string => text(value) && /^\d{4}-(0[1-9]|1[0-2])$/u.test(value);

function validItem(value: unknown, cancelled: boolean): value is InvoiceDetailItem {
  if (!record(value)) return false;
  const count = value.installmentCount;
  const number = value.installmentNumber;
  return text(value.installmentId) && text(value.purchaseId) && civilDate(value.purchaseDate) && text(value.description)
    && nullableText(value.categoryId) && nullableText(value.categoryName) && nullableText(value.subcategoryId) && nullableText(value.subcategoryName)
    && safeInteger(value.installmentAmountCents, 1) && safeInteger(value.purchaseTotalCents, 1)
    && safeInteger(count, 1) && Number(count) <= 120 && safeInteger(number, 1) && Number(number) <= Number(count)
    && (value.origin === "web" || value.origin === "telegram" || value.origin === "system")
    && (value.status === "pending" || value.status === "paid" || value.status === "cancelled")
    && typeof value.includedInTotal === "boolean"
    && (cancelled ? value.status === "cancelled" && value.includedInTotal === false : value.status !== "cancelled" && value.includedInTotal === true);
}

function validPage(value: unknown, cancelled: boolean): value is InvoiceDetailPage {
  if (!record(value) || !Array.isArray(value.items) || !safeInteger(value.page, 1) || !safeInteger(value.pageSize, 1) || Number(value.pageSize) > 50
    || !safeInteger(value.totalItems) || !safeInteger(value.totalPages, 1) || typeof value.hasPreviousPage !== "boolean" || typeof value.hasNextPage !== "boolean") return false;
  const expectedPages = Math.max(1, Math.ceil(Number(value.totalItems) / Number(value.pageSize)));
  const expectedItems = Math.min(Number(value.pageSize), Math.max(0, Number(value.totalItems) - (Number(value.page) - 1) * Number(value.pageSize)));
  return Number(value.page) <= expectedPages && Number(value.totalPages) === expectedPages && value.items.length === expectedItems
    && value.hasPreviousPage === (Number(value.page) > 1) && value.hasNextPage === (Number(value.page) < expectedPages)
    && value.items.every((item) => validItem(item, cancelled));
}

function validAdjustment(value: unknown): value is InvoiceDetailAdjustment {
  return record(value) && text(value.adjustmentId) && value.itemType === "opening_balance"
    && value.description === "Saldo inicial ainda não identificado" && safeInteger(value.amountCents, 1)
    && value.status === "active" && value.includedInTotal === true;
}

function validOpeningBalance(value: unknown) {
  if (value === null || value === undefined) return true;
  if (!record(value) || !safeInteger(value.originalCents) || !safeInteger(value.openingCents)
    || !safeInteger(value.initialStateInstallmentsCents) || !safeInteger(value.allocatedCents)
    || !safeInteger(value.residualCents) || !safeInteger(value.identifiedCents)) return false;
  return Number(value.initialStateInstallmentsCents) + Number(value.openingCents) === Number(value.originalCents)
    && Number(value.allocatedCents) + Number(value.residualCents) === Number(value.openingCents)
    && Number(value.initialStateInstallmentsCents) + Number(value.allocatedCents) === Number(value.identifiedCents)
    && Number(value.identifiedCents) + Number(value.residualCents) === Number(value.originalCents);
}

export function parseInvoiceDetailPayload(value: unknown): InvoiceDetailResponse | null {
  if (!record(value) || !record(value.invoice) || !validOpeningBalance(value.openingBalance) || !Array.isArray(value.adjustments)
    || !value.adjustments.every(validAdjustment) || !validPage(value.active, false) || !validPage(value.cancelled, true)) return null;
  const invoice = value.invoice;
  if (!text(invoice.id) || !text(invoice.cardId) || !text(invoice.cardName) || !referenceMonth(invoice.referenceMonth)
    || !civilDate(invoice.dueDate) || !(invoice.closesOn === null || civilDate(invoice.closesOn))
    || !safeInteger(invoice.invoiceTotalCents) || !safeInteger(invoice.paidCents) || !safeInteger(invoice.remainingCents)
    || !(invoice.cycleStatus === "open" || invoice.cycleStatus === "closed" || invoice.cycleStatus === "unknown")
    || !(invoice.paymentStatus === "unpaid" || invoice.paymentStatus === "partial" || invoice.paymentStatus === "settled")) return null;
  const remaining = Math.max(Number(invoice.invoiceTotalCents) - Number(invoice.paidCents), 0);
  const paymentStatus = remaining === 0 ? "settled" : Number(invoice.paidCents) === 0 ? "unpaid" : "partial";
  if (Number(invoice.remainingCents) !== remaining || invoice.paymentStatus !== paymentStatus) return null;
  return value as unknown as InvoiceDetailResponse;
}

export async function loadInvoiceDetail(invoiceId: string, activePage: number, cancelledPage: number, signal: AbortSignal) {
  const query = new URLSearchParams({ invoiceId, activePage: String(activePage), cancelledPage: String(cancelledPage), pageSize: String(PAGE_SIZE) });
  const response = await fetch(`/api/finance/invoice-details?${query}`, { cache: "no-store", signal });
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new InvoiceDetailApiError("Não foi possível interpretar o detalhamento da fatura.", response.status); }
  if (!response.ok) throw new InvoiceDetailApiError(record(body) && text(body.error) && body.error ? body.error : "Não foi possível carregar o detalhamento da fatura.", response.status);
  const detail = parseInvoiceDetailPayload(body);
  if (!detail || detail.invoice.id !== invoiceId) throw new InvoiceDetailApiError("O detalhamento recebido é inválido. Tente novamente.", 502);
  return detail;
}

function Item({ item }: { item: InvoiceDetailItem }) {
  const classification = [item.categoryName ?? "Sem categoria", item.subcategoryName].filter(Boolean).join(" / ");
  return <li className="min-w-0 rounded-xl border bg-white p-3">
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="break-words font-medium">{item.description}</p>
        <p className="mt-1 text-sm text-[#52645f]">{dateLabel(item.purchaseDate)} · {classification}</p>
        <p className="mt-1 text-xs text-[#71837e]">Parcela {item.installmentNumber}/{item.installmentCount} · Origem: {originLabel(item.origin)}</p>
        {item.installmentCount > 1 && <p className="mt-1 text-xs text-[#71837e]">Valor original da compra: {money(item.purchaseTotalCents)}</p>}
        {!item.includedInTotal && <p className="mt-2 text-xs font-medium text-[#8c3434]">Não incluído no total da fatura</p>}
      </div>
      <strong className="shrink-0 text-base">{money(item.installmentAmountCents)}</strong>
    </div>
  </li>;
}

function Adjustment({ adjustment }: { adjustment: InvoiceDetailAdjustment }) {
  return <li className="min-w-0 rounded-xl border border-[#d8e5e1] bg-[#f6faf8] p-3">
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="break-words font-medium">{adjustment.description}</p>
        <p className="mt-1 text-xs text-[#52645f]">Saldo inicial da fatura</p>
      </div>
      <strong className="shrink-0 text-base">{money(adjustment.amountCents)}</strong>
    </div>
  </li>;
}

function PageControls({ value, onChange }: { value: InvoiceDetailPage; onChange: (page: number) => void }) {
  if (value.totalPages <= 1) return null;
  return <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
    <span>Página {value.page} de {value.totalPages}</span>
    <div className="flex gap-2"><Button variant="outline" disabled={!value.hasPreviousPage} onClick={() => onChange(value.page - 1)}>Anterior</Button><Button variant="outline" disabled={!value.hasNextPage} onClick={() => onChange(value.page + 1)}>Próxima</Button></div>
  </div>;
}

export function InvoiceDetailItems({ detail, onActivePage, onCancelledPage }: { detail: InvoiceDetailResponse; onActivePage: (page: number) => void; onCancelledPage: (page: number) => void }) {
  const activeComponentCount = detail.active.totalItems + detail.adjustments.length;
  return <div className="grid gap-5">
    {detail.openingBalance && detail.openingBalance.residualCents > 0 && <section className="grid gap-2 rounded-xl border bg-[#f7faf9] p-4" aria-label="Composição do saldo inicial"><ReviewValue label="Lançamentos identificados" value={money(detail.openingBalance.identifiedCents)} /><ReviewValue label="Saldo inicial ainda não identificado" value={money(detail.openingBalance.residualCents)} /></section>}
    <section aria-labelledby="active-invoice-items"><div className="flex flex-wrap items-center justify-between gap-2"><h3 id="active-invoice-items" className="font-semibold">Itens da fatura</h3><span className="text-sm text-[#71837e]">{activeComponentCount} item(ns)</span></div>
      {detail.adjustments.length > 0 && <ul className="mt-3 grid gap-3">{detail.adjustments.map((adjustment) => <Adjustment key={adjustment.adjustmentId} adjustment={adjustment} />)}</ul>}
      {detail.active.items.length ? <ul className="mt-3 grid gap-3">{detail.active.items.map((item) => <Item key={item.installmentId} item={item} />)}</ul> : detail.adjustments.length === 0 ? <p className="mt-3 rounded-xl bg-[#f6f8f7] p-4 text-sm text-[#71837e]">Nenhum item ativo nesta fatura.</p> : null}
      <PageControls value={detail.active} onChange={onActivePage} />
    </section>
    {detail.cancelled.totalItems > 0 && <section aria-labelledby="cancelled-invoice-items" className="border-t pt-5"><div className="flex flex-wrap items-center justify-between gap-2"><h3 id="cancelled-invoice-items" className="font-semibold">Itens cancelados</h3><Badge variant="outline">Fora do total</Badge></div>
      <ul className="mt-3 grid gap-3 opacity-80">{detail.cancelled.items.map((item) => <Item key={item.installmentId} item={item} />)}</ul>
      <PageControls value={detail.cancelled} onChange={onCancelledPage} />
    </section>}
  </div>;
}

function ReviewValue({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-wrap justify-between gap-2 text-sm"><span className="text-[#52645f]">{label}</span><strong>{value}</strong></div>;
}

type InvoiceSummary = {
  id: string;
  referenceMonth: string;
  dueDate: string;
  closesOn: string | null;
  invoiceTotalCents: number;
  paidCents: number;
  remainingCents: number;
  cycleStatus: "open" | "closed" | "unknown";
  paymentStatus: "unpaid" | "partial" | "settled";
};

export function InvoiceDetailDialog({ invoice, onClose }: { invoice: InvoiceSummary; onClose: () => void }) {
  const [activePage, setActivePage] = useState(1);
  const [cancelledPage, setCancelledPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; detail: InvoiceDetailResponse } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const key = `${invoice.id}:${activePage}:${cancelledPage}:${invoice.invoiceTotalCents}:${invoice.paidCents}:${retry}`;
  const detail = result?.key === key ? result.detail : null;
  const error = failure?.key === key ? failure.message : "";

  useEffect(() => {
    const controller = new AbortController();
    void loadInvoiceDetail(invoice.id, activePage, cancelledPage, controller.signal).then(
      (value) => { if (!controller.signal.aborted) { setResult({ key, detail: value }); setFailure(null); } },
      (cause: unknown) => { if (!controller.signal.aborted) setFailure({ key, message: cause instanceof InvoiceDetailApiError ? cause.message : "Não foi possível carregar o detalhamento da fatura." }); },
    );
    return () => controller.abort();
  }, [invoice.id, activePage, cancelledPage, key]);

  const summary = detail?.invoice ?? invoice;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>Fatura {monthLabel(summary.referenceMonth)}</DialogTitle><DialogDescription>Confira as compras e parcelas que compõem esta competência.</DialogDescription></DialogHeader>
    <div className="flex flex-wrap gap-2"><Badge variant="outline">{cycleStatusLabel(summary.cycleStatus)}</Badge><Badge variant="secondary">{paymentStatusLabel(summary.paymentStatus)}</Badge></div>
    <div className="grid gap-2 rounded-xl bg-[#f6f8f7] p-4 text-sm sm:grid-cols-2"><p>Fechamento: {summary.closesOn ? dateLabel(summary.closesOn) : "Não identificado"}</p><p>Vencimento: {dateLabel(summary.dueDate)}</p></div>
    <dl className="grid gap-3 sm:grid-cols-3"><div><dt className="text-xs text-[#71837e]">Total da fatura</dt><dd>{money(summary.invoiceTotalCents)}</dd></div><div><dt className="text-xs text-[#71837e]">Já pago</dt><dd>{money(summary.paidCents)}</dd></div><div><dt className="text-xs text-[#71837e]">Restante</dt><dd className="text-lg font-semibold">{money(summary.remainingCents)}</dd></div></dl>
    {error ? <div role="alert" className="rounded-xl border border-[#e2baba] bg-[#fff7f7] p-4"><p className="text-sm text-[#8c3434]">{error}</p><Button className="mt-3" variant="outline" onClick={() => setRetry((value) => value + 1)}>Tentar novamente</Button></div> : !detail ? <p role="status" className="rounded-xl bg-[#f6f8f7] p-4 text-sm">Carregando itens da fatura…</p> : <InvoiceDetailItems detail={detail} onActivePage={setActivePage} onCancelledPage={setCancelledPage} />}
  </DialogContent></Dialog>;
}

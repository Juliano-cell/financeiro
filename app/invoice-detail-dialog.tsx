"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cycleStatusLabel, paymentStatusLabel } from "@/lib/invoice-ui-rules.mjs";
import type { InvoiceDetailItem, InvoiceDetailPage, InvoiceDetailResponse } from "@/lib/invoice-detail-types";

const PAGE_SIZE = 10;
const money = (value: number) => Number.isSafeInteger(value) ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value / 100) : "Valor indisponível";
const dateLabel = (value: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const monthLabel = (value: string) => value.split("-").reverse().join("/");
const originLabel = (value: InvoiceDetailItem["origin"]) => value === "telegram" ? "Telegram" : value === "system" ? "Sistema" : "Aplicação";

class InvoiceDetailApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "InvoiceDetailApiError"; }
}

async function loadInvoiceDetail(invoiceId: string, activePage: number, cancelledPage: number, signal: AbortSignal) {
  const query = new URLSearchParams({ invoiceId, activePage: String(activePage), cancelledPage: String(cancelledPage), pageSize: String(PAGE_SIZE) });
  const response = await fetch(`/api/finance/invoice-details?${query}`, { cache: "no-store", signal });
  let body: InvoiceDetailResponse | { error?: string };
  try { body = await response.json() as InvoiceDetailResponse | { error?: string }; }
  catch { throw new InvoiceDetailApiError("Não foi possível interpretar o detalhamento da fatura.", response.status); }
  if (!response.ok) throw new InvoiceDetailApiError("error" in body && body.error ? body.error : "Não foi possível carregar o detalhamento da fatura.", response.status);
  return body as InvoiceDetailResponse;
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

function PageControls({ value, onChange }: { value: InvoiceDetailPage; onChange: (page: number) => void }) {
  if (value.totalPages <= 1) return null;
  return <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
    <span>Página {value.page} de {value.totalPages}</span>
    <div className="flex gap-2"><Button variant="outline" disabled={!value.hasPreviousPage} onClick={() => onChange(value.page - 1)}>Anterior</Button><Button variant="outline" disabled={!value.hasNextPage} onClick={() => onChange(value.page + 1)}>Próxima</Button></div>
  </div>;
}

export function InvoiceDetailItems({ detail, onActivePage, onCancelledPage }: { detail: InvoiceDetailResponse; onActivePage: (page: number) => void; onCancelledPage: (page: number) => void }) {
  return <div className="grid gap-5">
    <section aria-labelledby="active-invoice-items"><div className="flex flex-wrap items-center justify-between gap-2"><h3 id="active-invoice-items" className="font-semibold">Itens da fatura</h3><span className="text-sm text-[#71837e]">{detail.active.totalItems} item(ns)</span></div>
      {detail.active.items.length ? <ul className="mt-3 grid gap-3">{detail.active.items.map((item) => <Item key={item.installmentId} item={item} />)}</ul> : <p className="mt-3 rounded-xl bg-[#f6f8f7] p-4 text-sm text-[#71837e]">Nenhum item ativo nesta fatura.</p>}
      <PageControls value={detail.active} onChange={onActivePage} />
    </section>
    {detail.cancelled.totalItems > 0 && <section aria-labelledby="cancelled-invoice-items" className="border-t pt-5"><div className="flex flex-wrap items-center justify-between gap-2"><h3 id="cancelled-invoice-items" className="font-semibold">Itens cancelados</h3><Badge variant="outline">Fora do total</Badge></div>
      <ul className="mt-3 grid gap-3 opacity-80">{detail.cancelled.items.map((item) => <Item key={item.installmentId} item={item} />)}</ul>
      <PageControls value={detail.cancelled} onChange={onCancelledPage} />
    </section>}
  </div>;
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

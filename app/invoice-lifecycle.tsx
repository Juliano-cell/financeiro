"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { buildInvoicePayment, buildInvoiceReversal, createFinancialRefreshController, cycleStatusLabel, invoiceErrorMessage, invoiceHistoryEvents, invoiceToday, paymentStatusLabel, submitInvoiceOperation } from "@/lib/invoice-ui-rules.mjs";
import { advancedApi, AdvancedApiError } from "@/app/advanced-finance";
import { InvoiceDetailDialog } from "@/app/invoice-detail-dialog";

export type CanonicalInvoice = { id: string; cardId: string; referenceMonth: string; dueDate: string; invoiceTotalCents: number; paidCents: number; remainingCents: number; paymentStatus: "unpaid" | "partial" | "settled"; cycleStatus: "open" | "closed" | "unknown"; closesOn: string | null; installments: Array<{ id: string }> };
type Account = { id: string; name: string; currentBalanceCents: number; isActive: boolean };
type History = { payments: Array<{ id: string; accountId: string; amountCents: number; paidAt: string }>; operations: Array<{ id: string; kind: string; accountId: string; amountCents: number; occurredOn: string; reversedPaymentId: string | null }> };
type Event = ReturnType<typeof invoiceHistoryEvents>[number];
const money = (value: number) => Number.isSafeInteger(value) ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value / 100) : "Valor indisponível";
const dateLabel = (value: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
export type FinancialController = ReturnType<typeof createFinancialRefreshController>;
export type FinancialRefresh = () => Promise<{ success: boolean; generation?: number; startedAt?: number }>;

export function InvoiceLifecycle({ invoice, accounts, onChanged, financial, onFinancialRefresh }: { invoice: CanonicalInvoice; accounts: Account[]; onChanged: () => Promise<void>; financial?: FinancialController; onFinancialRefresh?: FinancialRefresh }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyResult, setHistory] = useState<{ key: string; data: History } | null>(null);
  const [historyFailure, setHistoryFailure] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<{ kind: "payment" } | { kind: "reversal"; event: Event } | null>(null);
  const awaitingSnapshot = financial?.isLocked(invoice.id) ?? false;
  const historyKey = `${invoice.id}:${financial?.generation ?? 0}:${retry}`;
  const historyError = historyFailure?.key === historyKey ? historyFailure.message : "";
  const setHistoryError = (message: string) => setHistoryFailure(message ? { key: historyKey, message } : null);
  const live = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const history = historyResult?.key === historyKey ? historyResult.data : null;
  useEffect(() => {
    if (!historyOpen) return;
    const controller = new AbortController();
    void advancedApi({ action: "get_invoice_payment_history", invoiceId: invoice.id }, undefined, controller.signal).then(
      (result) => { if (!controller.signal.aborted) { setHistory({ key: historyKey, data: result as unknown as History }); setHistoryFailure(null); } },
      (error: unknown) => { if (!controller.signal.aborted) setHistoryFailure({ key: historyKey, message: invoiceErrorMessage(error instanceof AdvancedApiError ? error.status : 0) }); },
    );
    return () => controller.abort();
  }, [historyOpen, invoice.id, historyKey]);
  const changed = async () => {
    const result = onFinancialRefresh ? await onFinancialRefresh() : (await onChanged(), { success: true });
    if (!result?.success) { if (live.current) toast.info("A operação foi processada, mas os dados ainda não foram atualizados. Use Atualizar dados antes de outra operação."); return; }
    // Generation is the history dependency; do not issue a duplicate shared refresh.
    if (live.current) setHistoryFailure(null);
  };
  const events = history ? invoiceHistoryEvents(history, accounts) : [];
  return <><article className="min-w-0 rounded-2xl bg-[#f6f8f7] p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-medium">{invoice.referenceMonth.split("-").reverse().join("/")}</h4><p className="mt-1 text-xs text-[#71837e]">Vence {dateLabel(invoice.dueDate)} · {invoice.installments.length} parcela(s)</p>{invoice.closesOn !== null && <p className="mt-1 text-xs text-[#71837e]">Fechamento: {dateLabel(invoice.closesOn)}</p>}</div><div className="flex flex-wrap gap-2"><Badge variant="outline">{cycleStatusLabel(invoice.cycleStatus)}</Badge><Badge variant="secondary">{paymentStatusLabel(invoice.paymentStatus)}</Badge></div></div>
    <dl className="mt-4 grid gap-3 sm:grid-cols-3"><div><dt className="text-xs text-[#71837e]">Total da fatura</dt><dd>{money(invoice.invoiceTotalCents)}</dd></div><div><dt className="text-xs text-[#71837e]">Já pago</dt><dd>{money(invoice.paidCents)}</dd></div><div><dt className="text-xs text-[#71837e]">Restante</dt><dd className="text-lg font-semibold">{money(invoice.remainingCents)}</dd></div></dl>
    <div className="mt-4 flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" onClick={() => setDetailOpen(true)}>Ver fatura</Button>{invoice.remainingCents > 0 && <Button className="min-h-11" disabled={awaitingSnapshot || !accounts.some((account) => account.isActive)} onClick={() => setEditing({ kind: "payment" })}>Pagar restante</Button>}<Button variant="outline" className="min-h-11" aria-haspopup="dialog" onClick={() => { setHistoryOpen(true); setHistory(null); setHistoryError(""); }}>Histórico de pagamentos</Button></div>
    {awaitingSnapshot && <div className="mt-2 text-sm" role="status"><p>Aguarde os dados atualizados antes de confirmar outra operação.</p><Button variant="outline" onClick={() => void changed()}>Atualizar dados</Button>{financial?.attempt(invoice.id) && <Button variant="outline" onClick={() => { const previous = financial.presentation(invoice.id); if (previous) setEditing(previous); }}>Retomar a mesma operação</Button>}</div>}
    {invoice.remainingCents > 0 && !accounts.some((account) => account.isActive) && <p className="mt-2 text-sm">Cadastre ou ative uma conta para pagar.</p>}
    {detailOpen && <InvoiceDetailDialog key={invoice.id} invoice={invoice} onClose={() => setDetailOpen(false)} />}
    {editing && <InvoiceOperationDialog key={`${invoice.id}:${editing.kind}`} invoice={invoice} accounts={accounts} editing={editing} financial={financial} onInvalidate={() => financial?.settle(invoice.id)} onClose={() => setEditing(null)} onChanged={changed} />}
  </article>
  <Dialog open={historyOpen} onOpenChange={setHistoryOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>Histórico de pagamentos</DialogTitle><DialogDescription>Fatura {invoice.referenceMonth.split("-").reverse().join("/")}. Consulte os pagamentos e reversões desta fatura.</DialogDescription></DialogHeader><div aria-live="polite">{historyError ? <div role="alert" className="rounded-xl border border-[#e7b9b9] bg-[#fff4f4] p-4"><p className="text-sm">{historyError}</p><Button className="mt-3" variant="outline" onClick={() => setRetry((value) => value + 1)}>Tentar novamente</Button></div> : !history ? <p className="py-8 text-center text-sm text-[#71837e]">Carregando histórico…</p> : events.length ? <ul className="grid gap-3">{events.map((event) => <li key={event.key} className="min-w-0 rounded-xl border bg-white p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-medium">{event.label}</p><p className="mt-1 break-words text-sm text-[#526b65]">{dateLabel(event.date)} · {event.accountName}</p></div><strong>{money(event.amountCents)}</strong></div>{event.canReverse ? <Button className="mt-3 min-h-11" variant="outline" disabled={awaitingSnapshot} onClick={() => { setHistoryOpen(false); setEditing({ kind: "reversal", event }); }}>Reverter pagamento</Button> : event.paymentId && <p className="mt-3 text-xs font-medium text-[#71837e]">Pagamento revertido</p>}</li>)}</ul> : <p className="py-8 text-center text-sm text-[#71837e]">Nenhum pagamento registrado.</p>}</div><DialogFooter><Button type="button" variant="outline" onClick={() => setHistoryOpen(false)}>Fechar histórico</Button></DialogFooter></DialogContent></Dialog>
  </>;
}

export function InvoiceOperationDialog({ invoice, accounts, editing, onClose, onChanged, onInvalidate, financial }: { invoice: CanonicalInvoice; accounts: Account[]; editing: { kind: "payment" } | { kind: "reversal"; event: Event }; onClose: () => void; onChanged: () => Promise<void>; onInvalidate: () => void; financial?: FinancialController }) {
  const [savedAttempt] = useState(() => financial?.attempt(invoice.id) as Record<string, unknown> | null ?? null);
  const [accountId, setAccountId] = useState(String(savedAttempt?.accountId ?? ""));
  const [date, setDate] = useState(String(savedAttempt?.paidAt ?? savedAttempt?.reversedAt ?? invoiceToday()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState<Record<string, unknown> | null>(savedAttempt);
  const pending = useRef<Record<string, unknown> | null>(savedAttempt);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reversal = editing.kind === "reversal";
  const confirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    let started = false;
    try {
      pending.current ??= editing.kind === "payment" ? buildInvoicePayment(invoice, accountId, accounts, date) : buildInvoiceReversal(editing.event.paymentId!, date);
      setAttempt(pending.current);
      financial?.start(invoice.id, pending.current, editing);
      started = true;
      await submitInvoiceOperation(pending.current, {
        api: advancedApi,
        refresh: onChanged,
        onConflict: () => { onInvalidate(); if (mounted.current) { toast.info(invoiceErrorMessage(409)); onClose(); } },
        onSuccess: (outcome: string) => { onInvalidate(); if (mounted.current) { toast.success(outcome === "already_settled" ? "Esta fatura já está quitada." : outcome === "reversed" ? "Pagamento revertido. O valor retornou à conta utilizada." : "Pagamento confirmado."); onClose(); } },
      });
    } catch (cause) {
      const status = cause instanceof AdvancedApiError ? cause.status ?? 0 : 0;
      // Validation failures are definitive; uncertain failures keep the exact operation.
      if (started && status >= 400 && status < 500 && status !== 409) { financial?.reject(invoice.id); pending.current = null; if (mounted.current) setAttempt(null); }
      else if (started && status !== 409) financial?.uncertain(invoice.id);
      if (mounted.current) setError(cause instanceof AdvancedApiError ? invoiceErrorMessage(status, cause.message) : cause instanceof Error && !pending.current ? cause.message : invoiceErrorMessage(0));
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[85dvh] overflow-y-auto" onOpenAutoFocus={(event) => { event.preventDefault(); cancelButton.current?.focus(); }}><DialogHeader><DialogTitle>{reversal ? `Reverter pagamento de ${money(editing.event.amountCents)}?` : "Pagar fatura"}</DialogTitle><DialogDescription>{reversal ? "O valor retornará para a conta utilizada e a fatura voltará a possuir saldo pendente. O pagamento original será preservado." : "Confira o valor restante e escolha a conta usada para o pagamento."}</DialogDescription></DialogHeader>
    <div className="grid gap-3 rounded-xl bg-[#f4f7f5] p-4 text-sm sm:grid-cols-2"><div><p className="text-xs text-[#71837e]">Valor</p><strong className="mt-1 block text-xl">{money(reversal ? editing.event.amountCents : Number(attempt?.expectedRemainingCents ?? invoice.remainingCents))}</strong></div>{reversal && <><div><p className="text-xs text-[#71837e]">Conta utilizada</p><p className="mt-1 font-medium">{editing.event.accountName}</p></div><div><p className="text-xs text-[#71837e]">Fatura</p><p className="mt-1 font-medium">{invoice.referenceMonth.split("-").reverse().join("/")}</p></div><div><p className="text-xs text-[#71837e]">Pagamento original</p><p className="mt-1 font-medium">{dateLabel(editing.event.date)}</p></div></>}</div>
    {!reversal && <div><Label htmlFor="invoice-account">Conta que pagará a fatura *</Label><Select value={accountId || "none"} disabled={busy || Boolean(attempt)} onValueChange={(value) => setAccountId(value === "none" ? "" : value)}><SelectTrigger id="invoice-account" className="mt-2 min-h-11 w-full"><SelectValue placeholder="Selecione uma conta" /></SelectTrigger><SelectContent><SelectItem value="none" disabled>Selecione uma conta</SelectItem>{accounts.filter((account) => account.isActive).map((account) => <SelectItem key={account.id} value={account.id}>{account.name} · {money(account.currentBalanceCents)}</SelectItem>)}</SelectContent></Select></div>}
    <div><Label htmlFor="invoice-operation-date">{reversal ? "Data da reversão" : "Data do pagamento"}</Label><Input id="invoice-operation-date" className="mt-2 w-full min-w-0" type="date" value={date} min={reversal ? editing.event.date : undefined} max={invoiceToday()} disabled={busy || Boolean(attempt)} onChange={(event) => setDate(event.target.value)} required /></div>
    {error && <p role="alert" className="text-sm text-[#8c3434]">{error}</p>}
    <DialogFooter><Button ref={cancelButton} variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button disabled={busy || !date || (!reversal && !accountId)} onClick={() => void confirm()}>{busy ? "Confirmando…" : attempt ? "Tentar novamente a mesma operação" : reversal ? "Reverter pagamento" : "Confirmar pagamento"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

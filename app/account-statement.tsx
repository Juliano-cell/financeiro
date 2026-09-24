"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, CalendarDays, Landmark, LoaderCircle, ReceiptText, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AccountStatementEventFilter, AccountStatementItem, AccountStatementResponse } from "@/lib/account-statement-types";
import {
  buildAccountStatementQuery,
  formatStatementDate,
  formatStatementMoney,
  formatStatementReferenceMonth,
  mergeStatementItems,
  statementEmptyMessage,
  statementErrorMessage,
  statementEventPresentation,
  statementPaymentMethodLabel,
  validateStatementCustomPeriod,
} from "@/lib/account-statement-ui.mjs";

type PeriodFilter = "this_month" | "last_30_days" | "custom";
type StatementAccount = { id: string; name: string; currentBalanceCents: number; isActive: boolean };

class StatementRequestError extends Error {
  constructor(readonly status: number) {
    super(statementErrorMessage(status));
  }
}

function localIsoDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function firstDayOfMonth(today: string) {
  return `${today.slice(0, 7)}-01`;
}

function isStatementResponse(value: unknown): value is AccountStatementResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AccountStatementResponse>;
  return Boolean(candidate.account && candidate.period && candidate.summary && Array.isArray(candidate.items)
    && typeof candidate.hasMore === "boolean" && (candidate.nextCursor === null || typeof candidate.nextCursor === "string"));
}

async function fetchStatement(query: string, signal: AbortSignal) {
  const response = await fetch(`/api/finance/account-statement?${query}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new StatementRequestError(response.status);
  const body: unknown = await response.json();
  if (!isStatementResponse(body)) throw new StatementRequestError(500);
  return body;
}

function SummaryCard({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "credit" | "debit" }) {
  const color = tone === "credit" ? "text-[#39742c]" : tone === "debit" ? "text-[#a14435]" : "text-[#17342d]";
  return <div className="min-w-0 rounded-2xl border border-[#dce4e1] bg-white p-4"><p className="text-xs font-semibold uppercase tracking-[.1em] text-[#71837e]">{label}</p><p className={`mt-2 break-words text-lg font-semibold leading-tight tabular-nums [overflow-wrap:anywhere] sm:text-xl ${color}`}>{formatStatementMoney(value)}</p></div>;
}

function ItemMetadata({ item }: { item: AccountStatementItem }) {
  const reference = formatStatementReferenceMonth(item.referenceMonth);
  const paymentMethod = statementPaymentMethodLabel(item.paymentMethod);
  const values = [
    item.categoryName && item.subcategoryName ? `${item.categoryName} · ${item.subcategoryName}` : item.categoryName ?? item.subcategoryName,
    paymentMethod,
    item.cardName ? `${item.cardName}${reference ? ` · Fatura ${reference}` : ""}` : reference ? `Fatura ${reference}` : null,
  ].filter((value): value is string => Boolean(value));
  if (!values.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5">{values.map((value) => <span key={value} className="rounded-full bg-[#f1f5f3] px-2.5 py-1 text-xs text-[#627670]">{value}</span>)}</div>;
}

function StatementItem({ item }: { item: AccountStatementItem }) {
  const presentation = statementEventPresentation(item.eventType);
  const credit = item.direction === "credit";
  return <li className="flex flex-col gap-3 border-b border-[#e6ece9] px-4 py-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:px-5">
    <div className="flex min-w-0 gap-3">
      <div className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl ${credit ? "bg-[#eaf5e7] text-[#39742c]" : "bg-[#faece9] text-[#a14435]"}`} aria-hidden="true">{credit ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}</div>
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-[#17342d]">{item.description}</p><Badge variant="outline" className="font-normal">{presentation.label}</Badge></div><p className="mt-1 text-sm text-[#71837e]">{formatStatementDate(item.eventDate)}</p><ItemMetadata item={item} /></div>
    </div>
    <p className={`shrink-0 pl-12 text-base font-semibold sm:pl-0 ${credit ? "text-[#39742c]" : "text-[#a14435]"}`} aria-label={`${credit ? "Crédito" : "Débito"} de ${formatStatementMoney(item.amountCents)}`}>{credit ? "+" : "−"} {formatStatementMoney(item.amountCents)}</p>
  </li>;
}

export function AccountStatementView({ account, onBack }: { account: StatementAccount; onBack: () => void }) {
  const today = localIsoDate();
  const [period, setPeriod] = useState<PeriodFilter>("this_month");
  const [eventType, setEventType] = useState<AccountStatementEventFilter>("all");
  const [from, setFrom] = useState(firstDayOfMonth(today));
  const [to, setTo] = useState(today);
  const [snapshot, setSnapshot] = useState<AccountStatementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const requestGeneration = useRef(0);
  const pageController = useRef<AbortController | null>(null);
  const paginationCursor = useRef<string | null>(null);
  const validationError = validateStatementCustomPeriod({ period, from, to, today });

  useEffect(() => {
    const generation = ++requestGeneration.current;
    pageController.current?.abort();
    pageController.current = null;
    paginationCursor.current = null;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      setSnapshot(null);
      setError(null);
      setErrorStatus(null);
      setLoadingMore(false);
      if (validationError) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const query = buildAccountStatementQuery({ accountId: account.id, period, from, to, eventType });
      try {
        const result = await fetchStatement(query, controller.signal);
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setSnapshot(result);
      } catch (reason) {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        const status = reason instanceof StatementRequestError ? reason.status : 500;
        setError(statementErrorMessage(status));
        setErrorStatus(status);
      } finally {
        if (!controller.signal.aborted && generation === requestGeneration.current) setLoading(false);
      }
    });
    return () => controller.abort();
  }, [account.id, eventType, from, period, retry, to, validationError]);

  useEffect(() => () => pageController.current?.abort(), []);

  const loadMore = useCallback(async () => {
    const cursor = snapshot?.nextCursor;
    if (!snapshot?.hasMore || !cursor || loadingMore || paginationCursor.current === cursor) return;
    const generation = requestGeneration.current;
    const controller = new AbortController();
    pageController.current?.abort();
    pageController.current = controller;
    paginationCursor.current = cursor;
    setLoadingMore(true);
    setError(null);
    try {
      const query = buildAccountStatementQuery({ accountId: account.id, period, from, to, eventType, cursor });
      const next = await fetchStatement(query, controller.signal);
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      setSnapshot((current) => current ? { ...current, items: mergeStatementItems(current.items, next.items), hasMore: next.hasMore, nextCursor: next.nextCursor } : current);
    } catch (reason) {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      const status = reason instanceof StatementRequestError ? reason.status : 500;
      setError(statementErrorMessage(status));
      setErrorStatus(status);
    } finally {
      if (!controller.signal.aborted && generation === requestGeneration.current) {
        setLoadingMore(false);
        paginationCursor.current = null;
      }
    }
  }, [account.id, eventType, from, loadingMore, period, snapshot, to]);

  return <section className="min-w-0 pb-[var(--mobile-nav-offset)] lg:pb-0">
    <Button type="button" variant="ghost" className="-ml-3 mb-4 text-[#48645e]" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Voltar para contas</Button>
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-3xl font-semibold tracking-[-.04em]">Extrato da conta</h2>{!account.isActive && <Badge variant="outline">Conta inativa</Badge>}</div><p className="mt-2 text-[#71837e]">{account.name}</p></div>
      <div className="rounded-2xl border border-[#dce4e1] bg-white px-5 py-4 sm:text-right"><p className="text-xs font-semibold uppercase tracking-[.1em] text-[#71837e]">Saldo atual</p><p className="mt-1 text-2xl font-semibold text-[#17342d]">{formatStatementMoney(account.currentBalanceCents)}</p></div>
    </div>

    <div className="mt-6 rounded-[24px] border border-[#dce4e1] bg-white p-4 sm:p-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div><Label htmlFor="statement-period">Período</Label><Select value={period} onValueChange={(value) => setPeriod(value as PeriodFilter)}><SelectTrigger id="statement-period" className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="this_month">Este mês</SelectItem><SelectItem value="last_30_days">Últimos 30 dias</SelectItem><SelectItem value="custom">Personalizado</SelectItem></SelectContent></Select></div>
        <div><Label htmlFor="statement-event-type">Tipo de movimentação</Label><Select value={eventType} onValueChange={(value) => setEventType(value as AccountStatementEventFilter)}><SelectTrigger id="statement-event-type" className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todas</SelectItem><SelectItem value="income">Entradas</SelectItem><SelectItem value="expense">Despesas</SelectItem><SelectItem value="expected_income_receipt">Recebimentos previstos</SelectItem><SelectItem value="expected_income_reversal">Estornos de entradas previstas</SelectItem><SelectItem value="invoice_payment">Pagamentos de fatura</SelectItem><SelectItem value="invoice_payment_reversal">Reversões de pagamento</SelectItem></SelectContent></Select></div>
        {period === "custom" && <><div><Label htmlFor="statement-from">Data inicial</Label><Input id="statement-from" className="mt-2" type="date" value={from} max={today} onChange={(event) => setFrom(event.target.value)} /></div><div><Label htmlFor="statement-to">Data final</Label><Input id="statement-to" className="mt-2" type="date" value={to} max={today} onChange={(event) => setTo(event.target.value)} /></div></>}
      </div>
      {validationError && <p className="mt-3 text-sm text-[#a14435]" role="alert">{validationError}</p>}
    </div>

    {loading && <div className="mt-6 grid min-h-64 place-items-center rounded-[24px] border border-[#dce4e1] bg-white" aria-live="polite"><div className="text-center text-[#71837e]"><LoaderCircle className="mx-auto h-6 w-6 animate-spin" /><p className="mt-3">Carregando extrato...</p></div></div>}

    {!loading && error && !snapshot && <div className="mt-6 rounded-[24px] border border-[#ead6d1] bg-white p-8 text-center" role="alert"><RefreshCw className="mx-auto h-6 w-6 text-[#a14435]" /><p className="mt-4 font-medium">{error}</p><Button className="mt-5" variant="outline" onClick={() => errorStatus === 401 ? window.location.assign("/entrar") : setRetry((value) => value + 1)}>{errorStatus === 401 ? "Ir para o login" : "Tentar novamente"}</Button></div>}

    {!loading && snapshot && <>
      <div className="mt-6 grid min-w-0 grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Reconciliação do período"><SummaryCard label="Saldo anterior" value={snapshot.summary.openingBalanceCents} /><SummaryCard label="Entradas" value={snapshot.summary.periodCreditsCents} tone="credit" /><SummaryCard label="Saídas" value={snapshot.summary.periodDebitsCents} tone="debit" /><SummaryCard label="Saldo final" value={snapshot.summary.closingBalanceCents} /></div>
      <div className="mt-6 overflow-hidden rounded-[24px] border border-[#dce4e1] bg-white">
        <div className="flex flex-col gap-2 border-b border-[#e6ece9] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"><div><h3 className="font-semibold">Movimentações</h3><p className="mt-1 text-sm text-[#71837e]">{formatStatementDate(snapshot.period.from)} a {formatStatementDate(snapshot.period.to)}</p></div><div className="flex items-center gap-2 text-xs text-[#71837e]"><CalendarDays className="h-4 w-4" /> Ordem mais recente primeiro</div></div>
        {snapshot.items.length ? <ul><>{snapshot.items.map((item) => <StatementItem key={item.id} item={item} />)}</></ul> : <div className="grid min-h-52 place-items-center p-6 text-center"><div><Landmark className="mx-auto h-7 w-7 text-[#78908a]" /><p className="mt-3 font-medium">{statementEmptyMessage(eventType, snapshot.summary)}</p><p className="mt-1 text-sm text-[#71837e]">A reconciliação acima permanece referente ao período completo.</p></div></div>}
        {snapshot.hasMore && <div className="border-t border-[#e6ece9] p-4 text-center"><Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? <><LoaderCircle className="h-4 w-4 animate-spin" /> Carregando...</> : "Carregar mais"}</Button></div>}
        {error && snapshot && <div className="border-t border-[#ead6d1] bg-[#fff8f6] px-4 py-3 text-center text-sm text-[#8e3c31]" role="alert">{error} <button type="button" className="font-semibold underline" onClick={() => setRetry((value) => value + 1)}>Recarregar extrato</button></div>}
      </div>
    </>}
    <p className="mt-4 flex items-center gap-2 text-xs text-[#71837e]"><ReceiptText className="h-4 w-4" /> Compras no cartão aparecem aqui somente quando a fatura movimenta esta conta.</p>
  </section>;
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, CalendarRange, ChevronDown, CircleDollarSign, Landmark, ReceiptText, TrendingDown, TrendingUp } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { FinanceForecastResponse, ForecastMonth } from "@/lib/finance-forecast-types";
import {
  FORECAST_HORIZONS,
  forecastMonthLabel,
  forecastMonthPresentation,
  forecastSummary,
  forecastWarningPresentation,
} from "@/lib/finance-forecast-ui.mjs";
import { formatFinancialCents } from "@/lib/ui-preferences.mjs";

type ForecastNavigation = "expected-income" | "bills";

async function fetchForecast(months: number, signal: AbortSignal) {
  const response = await fetch(`/api/finance/forecast?months=${months}`, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("Não foi possível carregar a previsão.");
  const value = await response.json() as FinanceForecastResponse;
  if (!value || !Array.isArray(value.months)) throw new Error("Não foi possível carregar a previsão.");
  return value;
}

export function FinanceForecast({ valuesHidden, onNavigate }: {
  valuesHidden: boolean;
  onNavigate: (view: ForecastNavigation) => void;
}) {
  const [horizon, setHorizon] = useState(6);
  const [retryKey, setRetryKey] = useState(0);
  const [forecast, setForecast] = useState<FinanceForecastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const controller = new AbortController();
    void fetchForecast(horizon, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setForecast(value);
        setExpandedMonths(new Set());
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setForecast(null);
        setError("Não foi possível carregar a previsão.");
      });
    return () => controller.abort();
  }, [horizon, retryKey]);

  const summary = useMemo(() => forecast ? forecastSummary(forecast) : null, [forecast]);
  const warnings = useMemo(() => {
    const uniqueCodes = new Set(forecast?.warnings.map((warning) => warning.code) ?? []);
    return Array.from(uniqueCodes, forecastWarningPresentation);
  }, [forecast]);

  const toggleMonth = (month: string) => setExpandedMonths((current) => {
    const next = new Set(current);
    if (next.has(month)) next.delete(month); else next.add(month);
    return next;
  });

  const changeHorizon = (months: number) => {
    if (months === horizon) return;
    setForecast(null);
    setError(null);
    setHorizon(months);
  };

  const retry = () => {
    setForecast(null);
    setError(null);
    setRetryKey((value) => value + 1);
  };

  if (!forecast && !error) return <ForecastSkeleton horizon={horizon} onHorizon={changeHorizon} />;
  if (error || !forecast || !summary) return <ForecastError onRetry={retry} />;

  return <section className="min-w-0 space-y-6" aria-labelledby="finance-forecast-title">
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h2 id="finance-forecast-title" className="text-3xl font-semibold tracking-[-.04em]">Previsão financeira</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">Veja como seu saldo pode evoluir com as entradas e contas já previstas.</p>
      </div>
      <HorizonControl value={horizon} onChange={changeHorizon} />
    </header>

    {summary.hasNegativeMonth && <Alert className="border-destructive/40" aria-live="polite">
      <AlertTriangle />
      <AlertTitle>Atenção à projeção</AlertTitle>
      <AlertDescription>Com os lançamentos atuais, a projeção fica negativa em pelo menos um mês.</AlertDescription>
    </Alert>}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumo da previsão selecionada">
      <SummaryCard label="Saldo hoje" value={summary.currentBalanceCents} valuesHidden={valuesHidden} icon={<Landmark />} note="Saldo real e canônico atual" />
      <SummaryCard label="Entradas previstas" value={summary.projectedIncomeCents} valuesHidden={valuesHidden} icon={<TrendingUp />} note={`Estimativa para ${horizon} meses`} />
      <SummaryCard label="Saídas previstas" value={summary.projectedOutflowCents} valuesHidden={valuesHidden} icon={<TrendingDown />} note={`Estimativa para ${horizon} meses`} />
      <SummaryCard label="Saldo projetado" value={summary.projectedEndingBalanceCents} valuesHidden={valuesHidden} icon={<CircleDollarSign />} note="Estimativa ao fim do horizonte" negative={summary.projectedEndingBalanceCents < 0} />
    </div>

    {summary.lowestMonth && <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-card-foreground sm:flex-row sm:items-center sm:justify-between">
      <span className="text-muted-foreground">Menor saldo projetado · <span className="capitalize">{forecastMonthLabel(summary.lowestMonth.month)}</span></span>
      <Money cents={summary.lowestMonth.closingBalanceCents} hidden={valuesHidden} className="font-semibold tabular-nums" />
    </div>}

    {warnings.length > 0 && <div className="space-y-3" aria-label="Avisos da previsão">
      {warnings.map((warning) => <Alert key={warning.title}>
        <CalendarRange />
        <AlertTitle>{warning.title}</AlertTitle>
        <AlertDescription>
          <p>{warning.description}</p>
          {warning.action === "expected-income" && <Button type="button" variant="link" className="h-auto px-0 py-1" onClick={() => onNavigate("expected-income")}>Adicionar entrada prevista</Button>}
        </AlertDescription>
      </Alert>)}
    </div>}

    {!summary.hasFutureActivity && <div className="rounded-3xl border border-dashed border-border bg-card p-6 text-card-foreground">
      <h3 className="font-semibold">Poucos lançamentos futuros</h3>
      <p className="mt-1 text-sm text-muted-foreground">Você ainda não possui muitos lançamentos futuros cadastrados. O saldo projetado continua sendo exibido mês a mês.</p>
      <div className="mt-4 flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => onNavigate("expected-income")}>Adicionar entrada prevista</Button><Button type="button" variant="outline" onClick={() => onNavigate("bills")}>Ver contas</Button></div>
    </div>}

    <div className="space-y-3" aria-label={`Projeção mensal para ${horizon} meses`}>
      {forecast.months.map((month, index) => <div key={month.month}>
        {index > 0 && <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"><ArrowDown className="h-4 w-4" aria-hidden="true" /> <span>O saldo projetado anterior vira o saldo inicial.</span></div>}
        <ForecastMonthCard month={month} valuesHidden={valuesHidden} expanded={expandedMonths.has(month.month)} onToggle={() => toggleMonth(month.month)} />
      </div>)}
    </div>
  </section>;
}

function HorizonControl({ value, onChange, disabled = false }: { value: number; onChange: (months: number) => void; disabled?: boolean }) {
  return <div role="group" aria-label="Horizonte da previsão" className="grid w-full grid-cols-3 rounded-xl border border-border bg-card p-1 sm:w-auto">
    {FORECAST_HORIZONS.map((months) => <button key={months} type="button" disabled={disabled} aria-pressed={value === months} onClick={() => onChange(months)} className="min-h-10 rounded-lg px-4 text-sm font-medium outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-pressed:bg-primary aria-pressed:text-primary-foreground">{months} meses</button>)}
  </div>;
}

function SummaryCard({ label, value, valuesHidden, icon, note, negative = false }: { label: string; value: number; valuesHidden: boolean; icon: React.ReactNode; note: string; negative?: boolean }) {
  return <article className={`min-w-0 rounded-3xl border bg-card p-5 text-card-foreground ${negative ? "border-destructive/50" : "border-border"}`}>
    <div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold uppercase tracking-[.1em] text-muted-foreground">{label}</p><span className="text-primary [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">{icon}</span></div>
    <Money cents={value} hidden={valuesHidden} className={`mt-4 block break-words text-2xl font-semibold tabular-nums ${negative ? "text-destructive" : ""}`} />
    <p className="mt-2 text-xs text-muted-foreground">{note}</p>
  </article>;
}

function ForecastMonthCard({ month, valuesHidden, expanded, onToggle }: { month: ForecastMonth; valuesHidden: boolean; expanded: boolean; onToggle: () => void }) {
  const view = forecastMonthPresentation(month);
  const panelId = `forecast-details-${month.month}`;
  return <article className={`min-w-0 overflow-hidden rounded-3xl border bg-card text-card-foreground ${view.isNegative ? "border-destructive/60" : "border-border"}`}>
    <div className="p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div><h3 className="text-lg font-semibold capitalize">{forecastMonthLabel(month.month)}</h3>{view.isNegative && <p className="mt-1 text-sm font-medium text-destructive">Saldo projetado negativo</p>}</div>
        <p className="text-xs text-muted-foreground">Valores projetados do mês</p>
      </div>
      <dl className="mt-5 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Saldo inicial" cents={view.openingBalanceCents} hidden={valuesHidden} />
        <Metric label="Entradas" cents={view.projectedIncomeCents} hidden={valuesHidden} prefix="+" />
        <Metric label="Saídas" cents={view.projectedOutflowCents} hidden={valuesHidden} prefix="−" />
        <Metric label="Saldo projetado" cents={view.closingBalanceCents} hidden={valuesHidden} negative={view.isNegative} />
      </dl>
      <Button type="button" variant="ghost" className="mt-4 w-full justify-between sm:w-auto" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}>Ver composição <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} /></Button>
    </div>
    {expanded && <div id={panelId} className="grid gap-5 border-t border-border bg-muted/35 p-4 sm:p-5 lg:grid-cols-2">
      <Composition title="Entradas" icon={<TrendingUp />} rows={[
        ["Entradas previstas", view.income.expectedIncomeCents],
        ["Entradas previstas atrasadas", view.income.overdueExpectedIncomeCents],
        ["Entradas futuras já lançadas", view.income.knownFutureIncomeCents],
      ]} hidden={valuesHidden} prefix="+" />
      <Composition title="Saídas" icon={<ReceiptText />} rows={[
        ["Contas", view.outflow.pendingBillsCents],
        ["Faturas de cartão", view.outflow.cardInvoiceCents],
        ["Outras saídas futuras já lançadas", view.outflow.futureTransactionExpenseCents],
      ]} hidden={valuesHidden} prefix="−" />
    </div>}
  </article>;
}

function Metric({ label, cents, hidden, prefix, negative = false }: { label: string; cents: number; hidden: boolean; prefix?: "+" | "−"; negative?: boolean }) {
  return <div className="min-w-0 rounded-2xl bg-muted p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd><Money cents={cents} hidden={hidden} prefix={prefix} className={`mt-1 block break-words font-semibold tabular-nums ${negative ? "text-destructive" : ""}`} /></dd></div>;
}

function Composition({ title, icon, rows, hidden, prefix }: { title: string; icon: React.ReactNode; rows: Array<[string, number]>; hidden: boolean; prefix: "+" | "−" }) {
  return <section aria-label={`Composição de ${title.toLowerCase()}`}><h4 className="flex items-center gap-2 font-semibold"><span className="text-primary [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">{icon}</span>{title}</h4><dl className="mt-3 space-y-2">{rows.map(([label, cents]) => <div key={label} className="flex min-w-0 items-start justify-between gap-3 text-sm"><dt className="min-w-0 text-muted-foreground">{label}</dt><dd><Money cents={cents} hidden={hidden} prefix={prefix} className="whitespace-nowrap font-medium tabular-nums" /></dd></div>)}</dl></section>;
}

function Money({ cents, hidden, prefix, className }: { cents: number; hidden: boolean; prefix?: "+" | "−"; className?: string }) {
  const value = formatFinancialCents(Math.abs(cents), { hidden });
  const sign = hidden ? "" : prefix ?? (cents < 0 ? "−" : "");
  return <span className={className} aria-label={hidden ? "Valor financeiro oculto" : undefined}>{sign ? `${sign} ` : ""}{value}</span>;
}

function ForecastSkeleton({ horizon, onHorizon }: { horizon: number; onHorizon: (months: number) => void }) {
  return <section className="space-y-6" aria-busy="true" aria-label="Carregando previsão financeira"><div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div className="space-y-3"><Skeleton className="h-9 w-72 max-w-full" /><Skeleton className="h-5 w-[34rem] max-w-full" /></div><HorizonControl value={horizon} onChange={onHorizon} disabled /></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-36 rounded-3xl" />)}</div>{Array.from({ length: Math.min(horizon, 3) }, (_, index) => <Skeleton key={index} className="h-56 rounded-3xl" />)}</section>;
}

function ForecastError({ onRetry }: { onRetry: () => void }) {
  return <section className="rounded-3xl border border-border bg-card p-6 text-card-foreground" role="alert"><h2 className="text-xl font-semibold">Não foi possível carregar a previsão.</h2><p className="mt-2 text-sm text-muted-foreground">Tente novamente para consultar os lançamentos previstos.</p><Button type="button" className="mt-4" onClick={onRetry}>Tentar novamente</Button></section>;
}

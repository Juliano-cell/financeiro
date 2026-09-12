"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowDownLeft, ArrowRight, ArrowUp, ArrowUpRight, ChartNoAxesCombined, ChevronLeft, ChevronRight, CircleDollarSign, Lightbulb, Minus, ReceiptText, RefreshCw, Sparkles, Tags, Wallet } from "lucide-react";
import { CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { FinancePeriodFilter, type FinancePeriodSelection } from "@/app/finance-period-filter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AnalyticsBreakdown, AnalyticsComparison, AnalyticsDetail, AnalyticsResponse } from "@/lib/finance-analytics-types";

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const compactCurrency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const dateFormatter = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const monthFormatter = new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit", timeZone: "UTC" });
const categoryPalette = ["#5d8f45", "#e08b3e", "#4b7d73", "#8866b3", "#cf6f63", "#4c78a8"];

const brl = (cents: number) => currency.format(cents / 100);
const compactBrl = (cents: number) => compactCurrency.format(cents / 100);
const safePercent = (value: number | null) => value === null || !Number.isFinite(value) ? null : `${percent.format(Math.abs(value))}%`;
const dateLabel = (value: string) => dateFormatter.format(new Date(`${value}T00:00:00Z`));
const monthLabel = (value: string) => monthFormatter.format(new Date(`${value}-01T00:00:00Z`)).replace(" de ", " ");

type Drilldown = {
  title: string;
  categoryId?: string;
  subcategoryId?: string;
  page: number;
};

function analyticsUrl(selection: FinancePeriodSelection, extra?: Record<string, string | number | undefined>) {
  const params = new URLSearchParams({ view: "dashboard", period: selection.period });
  if (selection.period === "custom" && selection.from && selection.to) {
    params.set("from", selection.from);
    params.set("to", selection.to);
  }
  for (const [key, value] of Object.entries(extra ?? {})) if (value !== undefined) params.set(key, String(value));
  return `/api/finance/analytics?${params.toString()}`;
}

async function requestAnalytics(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, credentials: "same-origin" });
  const payload = await response.json() as AnalyticsResponse & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Não foi possível carregar os indicadores.");
  return payload;
}

export function FinanceDashboard() {
  const [selection, setSelection] = useState<FinancePeriodSelection>({ period: "this_month" });
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [drilldown, setDrilldown] = useState<Drilldown | null>(null);
  const [detail, setDetail] = useState<AnalyticsResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void requestAnalytics(analyticsUrl(selection), controller.signal)
      .then(setData)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Não foi possível carregar os indicadores.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selection, reload]);

  useEffect(() => {
    if (!drilldown) return;
    const controller = new AbortController();
    const url = analyticsUrl(selection, { view: "report", type: "expense", categoryId: drilldown.categoryId, subcategoryId: drilldown.subcategoryId, page: drilldown.page, limit: 20 });
    void requestAnalytics(url, controller.signal)
      .then(setDetail)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setDetailError(cause instanceof Error ? cause.message : "Não foi possível carregar os detalhes.");
      })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [drilldown, selection]);

  const updateSelection = (next: FinancePeriodSelection) => {
    setLoading(true);
    setError("");
    setDrilldown(null);
    setDetail(null);
    setSelection(next);
  };

  if (loading && !data) return <DashboardSkeleton selection={selection} onSelection={updateSelection} />;
  if (!data) return <DashboardFailure selection={selection} onSelection={updateSelection} message={error} onRetry={() => { setLoading(true); setError(""); setReload((value) => value + 1); }} />;

  const categories = data.rankings.categories.slice(0, 6);
  const subcategories = data.rankings.subcategories.slice(0, 6);
  const variations = data.rankings.subcategoryVariations.filter((item) => item.comparison.hasComparableHistory).slice(0, 5);
  const averages = data.rankings.subcategories.filter((item) => item.historicalAverage.sufficientHistory && item.historicalAverage.comparison).slice(0, 3);
  const hasTimeline = data.timeline.length > 1;
  const periodText = `${dateLabel(data.period.current.start)} a ${dateLabel(data.period.current.end)}`;

  const openCategory = (item: AnalyticsBreakdown) => {
    if (!item.id) return;
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    setDrilldown({ title: item.name, categoryId: item.id, page: 1 });
  };
  const openSubcategory = (item: AnalyticsBreakdown) => {
    if (!item.id) return;
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    setDrilldown({ title: item.name, subcategoryId: item.id, page: 1 });
  };

  return (
    <section className="min-w-0 space-y-5 sm:space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-sm font-medium text-[#668079]">Visão financeira da família</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">Dinheiro claro, decisões tranquilas.</h2>
          <p className="mt-2 text-sm text-[#71837e]">{periodText}</p>
        </div>
        <div className="w-full xl:max-w-3xl"><FinancePeriodFilter value={selection} onChange={updateSelection} disabled={loading} /></div>
      </div>

      {error && <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-[#e9c98e] bg-[#fff8e9] p-4 text-sm text-[#7d5618] sm:flex-row sm:items-center sm:justify-between"><span>Os dados anteriores continuam visíveis, mas a atualização falhou: {error}</span><Button size="sm" variant="outline" onClick={() => { setLoading(true); setError(""); setReload((value) => value + 1); }}><RefreshCw className="h-4 w-4" /> Tentar novamente</Button></div>}

      <div className={`grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
        <KpiCard label="Saldo atual" value={data.balance.currentCents} icon={<Wallet className="h-5 w-5" />} tone="dark" note="Disponível nas contas ativas" />
        <KpiCard label="Entradas" value={data.totals.income.currentCents} comparison={data.totals.income} icon={<ArrowDownLeft className="h-5 w-5" />} tone="green" />
        <KpiCard label="Despesas" value={data.totals.expense.currentCents} comparison={data.totals.expense} icon={<ArrowUpRight className="h-5 w-5" />} tone="orange" onClick={() => { setDetail(null); setDetailLoading(true); setDetailError(""); setDrilldown({ title: "Despesas do período", page: 1 }); }} />
        <KpiCard label="Resultado" value={data.totals.result.currentCents} comparison={data.totals.result} icon={<CircleDollarSign className="h-5 w-5" />} tone="blue" />
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[1.35fr_.85fr]">
        <article className="min-w-0 rounded-[24px] border bg-white p-4 sm:p-6">
          <SectionHeading title="Evolução financeira" description="Entradas, despesas e resultado ao longo do período" />
          {hasTimeline ? <div className="mt-5 h-72 min-w-0 sm:h-80"><ResponsiveContainer width="100%" height="100%"><LineChart data={data.timeline} margin={{ top: 8, right: 6, left: -10, bottom: 0 }}><CartesianGrid stroke="#e8eeeb" strokeDasharray="4 4" vertical={false} /><XAxis dataKey="month" tickFormatter={monthLabel} axisLine={false} tickLine={false} fontSize={11} /><YAxis tickFormatter={(value) => compactBrl(Number(value))} axisLine={false} tickLine={false} fontSize={11} width={72} /><Tooltip labelFormatter={(value) => monthLabel(String(value))} formatter={(value, name) => [brl(Number(value)), String(name)]} contentStyle={{ borderRadius: 14, borderColor: "#dfe7e4" }} /><Line type="monotone" dataKey="incomeCents" name="Entradas" stroke="#6b9d48" strokeWidth={2.5} dot={{ r: 3 }} /><Line type="monotone" dataKey="expenseCents" name="Despesas" stroke="#dc8335" strokeWidth={2.5} dot={{ r: 3 }} /><Line type="monotone" dataKey="resultCents" name="Resultado" stroke="#4d766e" strokeWidth={2.5} dot={{ r: 3 }} /></LineChart></ResponsiveContainer></div> : <EmptyBlock icon={ChartNoAxesCombined} title="Ainda não há evolução suficiente" text="Precisamos de mais de um ponto no tempo para desenhar esta comparação." />}
        </article>

        <article className="min-w-0 rounded-[24px] border bg-white p-4 sm:p-6">
          <SectionHeading title="Resumo do período" description="Leituras objetivas dos seus dados" />
          {data.insights.length ? <div className="mt-5 space-y-3">{data.insights.slice(0, 5).map((insight) => <div key={insight.key} className={`flex gap-3 rounded-2xl p-4 ${insight.tone === "positive" ? "bg-[#eff8e9] text-[#365c29]" : insight.tone === "warning" ? "bg-[#fff5e7] text-[#82521a]" : "bg-[#f1f5f3] text-[#49635d]"}`}><Lightbulb className="mt-0.5 h-4 w-4 shrink-0" /><p className="text-sm leading-6">{insight.message}</p></div>)}</div> : <EmptyBlock icon={Lightbulb} title="Sem insights por enquanto" text="Registre algumas movimentações para começar a enxergar padrões." compact />}
        </article>
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[1.15fr_.85fr]">
        <article className="min-w-0 rounded-[24px] border bg-white p-4 sm:p-6">
          <SectionHeading title="Para onde foi o dinheiro?" description="Categorias que mais pesaram no período" />
          {categories.length ? <div className="mt-4 grid min-w-0 gap-4 md:grid-cols-[220px_1fr] md:items-center"><div className="h-52 min-w-0"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={categories} dataKey="currentCents" nameKey="name" innerRadius={52} outerRadius={82} paddingAngle={3}>{categories.map((item, index) => <Cell key={`${item.id ?? "none"}-${item.name}`} fill={item.color || categoryPalette[index % categoryPalette.length]} />)}</Pie><Tooltip formatter={(value) => brl(Number(value))} contentStyle={{ borderRadius: 14, borderColor: "#dfe7e4" }} /></PieChart></ResponsiveContainer></div><div className="space-y-1">{categories.map((item, index) => <BreakdownRow key={`${item.id ?? "none"}-${item.name}`} item={item} color={item.color || categoryPalette[index % categoryPalette.length]} onClick={item.id ? () => openCategory(item) : undefined} />)}</div></div> : <EmptyBlock icon={Tags} title="Ainda não há despesas neste período" text="Registre uma despesa para visualizar como o dinheiro está distribuído." />}
        </article>

        <article className="min-w-0 rounded-[24px] border bg-white p-4 sm:p-6">
          <SectionHeading title="Principais gastos" description="Subcategorias em destaque" />
          {subcategories.length ? <ol className="mt-4 space-y-2">{subcategories.map((item, index) => <li key={`${item.id ?? "none"}-${item.name}`}><button type="button" disabled={!item.id} onClick={() => openSubcategory(item)} className="group flex w-full min-w-0 items-center gap-3 rounded-2xl px-2 py-3 text-left transition enabled:hover:bg-[#f4f7f5] disabled:cursor-default"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#edf3f0] text-sm font-semibold text-[#58706a]">{index + 1}</span><span className="min-w-0 flex-1"><span className="block truncate font-medium">{item.name}</span><span className="mt-1 block text-xs text-[#768984]">{percent.format(item.sharePercent)}% do total · <ComparisonInline comparison={item.comparison} /></span></span><strong className="shrink-0 text-sm sm:text-base">{brl(item.currentCents)}</strong>{item.id && <ChevronRight className="h-4 w-4 shrink-0 text-[#9aa9a5] transition group-hover:translate-x-0.5" />}</button></li>)}</ol> : <EmptyBlock icon={ReceiptText} title="Sem subcategorias no período" text="Os gastos detalhados, como Mercado e Combustível, aparecerão aqui." />}
        </article>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <article className="rounded-[24px] border bg-white p-4 sm:p-6">
          <SectionHeading title="Maiores variações" description="Mudanças em relação ao período anterior" />
          {variations.length ? <div className="mt-4 divide-y">{variations.map((item) => <button key={item.id ?? item.name} type="button" disabled={!item.id} onClick={() => openSubcategory(item)} className="flex w-full items-center gap-3 py-3 text-left disabled:cursor-default"><span className="min-w-0 flex-1 truncate font-medium">{item.name}</span><ComparisonPill comparison={item.comparison} /></button>)}</div> : <EmptyBlock icon={Sparkles} title="Precisamos de mais histórico" text="As maiores altas e quedas aparecerão quando houver uma base comparável." compact />}
        </article>

        <article className="rounded-[24px] border bg-white p-4 sm:p-6">
          <SectionHeading title="Média histórica" description="Como os principais gastos se comportam" />
          {averages.length ? <div className="mt-4 space-y-3">{averages.map((item) => <button key={item.id ?? item.name} type="button" disabled={!item.id} onClick={() => openSubcategory(item)} className="w-full rounded-2xl bg-[#f5f8f6] p-4 text-left disabled:cursor-default"><div className="flex items-center justify-between gap-3"><span className="truncate font-medium">{item.name}</span><strong>{brl(item.currentCents)}</strong></div><div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[#6d807b]"><span>Média: {brl(item.historicalAverage.averageCents ?? 0)}</span>{item.historicalAverage.comparison && <ComparisonInline comparison={item.historicalAverage.comparison} suffix=" da média" />}</div></button>)}</div> : <EmptyBlock icon={ChartNoAxesCombined} title="Histórico ainda insuficiente" text="Com mais meses registrados, você verá a comparação com a média familiar." compact />}
        </article>
      </div>

      <DrilldownDialog drilldown={drilldown} data={detail} loading={detailLoading} error={detailError} periodText={periodText} onClose={() => { setDrilldown(null); setDetail(null); }} onPage={(page) => { setDetailLoading(true); setDetailError(""); setDrilldown((current) => current ? { ...current, page } : current); }} />
    </section>
  );
}

function KpiCard({ label, value, comparison, icon, tone, note, onClick }: { label: string; value: number; comparison?: AnalyticsComparison; icon: React.ReactNode; tone: "dark" | "green" | "orange" | "blue"; note?: string; onClick?: () => void }) {
  const colors = { dark: "bg-[#123a33] text-white", green: "bg-[#eff8e9] text-[#315f29]", orange: "bg-[#fff3e2] text-[#89521b]", blue: "bg-[#eaf3f1] text-[#355f58]" };
  const content = <><span className={`grid h-10 w-10 place-items-center rounded-xl ${tone === "dark" ? "bg-white/10" : "bg-white/70"}`}>{icon}</span><span className={`mt-5 block text-xs font-semibold uppercase tracking-[0.1em] ${tone === "dark" ? "text-white/60" : "opacity-70"}`}>{label}</span><strong className="mt-2 block break-words text-2xl tracking-[-0.04em] sm:text-3xl">{brl(value)}</strong><span className={`mt-3 block min-h-5 text-xs ${tone === "dark" ? "text-white/60" : "opacity-75"}`}>{comparison ? <ComparisonInline comparison={comparison} /> : note}</span></>;
  return onClick ? <button type="button" onClick={onClick} className={`min-w-0 rounded-[22px] p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${colors[tone]}`}>{content}<span className="mt-4 flex items-center gap-1 text-xs font-semibold">Ver detalhes <ArrowRight className="h-3.5 w-3.5" /></span></button> : <article className={`min-w-0 rounded-[22px] p-5 shadow-sm ${colors[tone]}`}>{content}</article>;
}

function ComparisonInline({ comparison, suffix = " vs. período anterior" }: { comparison: AnalyticsComparison; suffix?: string }) {
  if (!comparison.hasComparableHistory) return <>Sem histórico para comparar</>;
  const formatted = safePercent(comparison.percentChange);
  if (!formatted) return <>Sem base percentual no período anterior</>;
  if (comparison.direction === "stable") return <><Minus className="mr-1 inline h-3.5 w-3.5" />Estável{suffix}</>;
  const rising = comparison.direction === "increase" || comparison.direction === "new";
  return <>{rising ? <ArrowUp className="mr-1 inline h-3.5 w-3.5" /> : <ArrowDown className="mr-1 inline h-3.5 w-3.5" />}{formatted}{suffix}</>;
}

function ComparisonPill({ comparison }: { comparison: AnalyticsComparison }) {
  const formatted = safePercent(comparison.percentChange);
  if (!comparison.hasComparableHistory || !formatted) return <Badge variant="outline">Sem base</Badge>;
  const rising = comparison.direction === "increase" || comparison.direction === "new";
  if (comparison.direction === "stable") return <Badge variant="outline"><Minus className="h-3 w-3" /> Estável</Badge>;
  return <Badge className={rising ? "bg-[#fff0dd] text-[#935718]" : "bg-[#eaf7e3] text-[#3e702c]"}>{rising ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />} {formatted}</Badge>;
}

function BreakdownRow({ item, color, onClick }: { item: AnalyticsBreakdown; color: string; onClick?: () => void }) {
  const content = <><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} /><span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span><span className="shrink-0 text-right"><strong className="block text-sm">{brl(item.currentCents)}</strong><span className="text-xs text-[#778985]">{percent.format(item.sharePercent)}%</span></span>{onClick && <ChevronRight className="h-4 w-4 shrink-0 text-[#9aa9a5]" />}</>;
  return onClick ? <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-[#f4f7f5]">{content}</button> : <div className="flex items-center gap-3 rounded-xl px-2 py-2.5">{content}</div>;
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return <div><h3 className="text-lg font-semibold tracking-[-0.02em]">{title}</h3><p className="mt-1 text-sm text-[#71837e]">{description}</p></div>;
}

function EmptyBlock({ icon: Icon, title, text, compact = false }: { icon: typeof Tags; title: string; text: string; compact?: boolean }) {
  return <div className={`grid place-items-center text-center ${compact ? "min-h-36 pt-4" : "min-h-56 pt-5"}`}><div><span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-[#edf3f0] text-[#6a807a]"><Icon className="h-5 w-5" /></span><p className="mt-3 font-medium">{title}</p><p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-[#7a8c87]">{text}</p></div></div>;
}

function DashboardSkeleton({ selection, onSelection }: { selection: FinancePeriodSelection; onSelection: (value: FinancePeriodSelection) => void }) {
  return <section className="space-y-5"><div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><div className="h-4 w-40 animate-pulse rounded bg-[#dfe7e4]" /><div className="mt-3 h-8 w-72 max-w-full animate-pulse rounded bg-[#dfe7e4]" /></div><div className="w-full xl:max-w-3xl"><FinancePeriodFilter value={selection} onChange={onSelection} disabled /></div></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-44 animate-pulse rounded-[22px] bg-[#dfe7e4]" />)}</div><div className="grid gap-5 xl:grid-cols-[1.35fr_.85fr]"><div className="h-96 animate-pulse rounded-[24px] bg-[#dfe7e4]" /><div className="h-96 animate-pulse rounded-[24px] bg-[#dfe7e4]" /></div></section>;
}

function DashboardFailure({ selection, onSelection, message, onRetry }: { selection: FinancePeriodSelection; onSelection: (value: FinancePeriodSelection) => void; message: string; onRetry: () => void }) {
  return <section className="space-y-5"><div className="flex justify-end"><div className="w-full xl:max-w-3xl"><FinancePeriodFilter value={selection} onChange={onSelection} /></div></div><div className="grid min-h-[420px] place-items-center rounded-[24px] border bg-white p-6 text-center"><div><span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#fff0dd] text-[#925619]"><RefreshCw className="h-5 w-5" /></span><h2 className="mt-4 text-xl font-semibold">Não foi possível carregar o dashboard</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#71837e]">{message || "Ocorreu uma falha temporária ao buscar os indicadores."}</p><Button className="mt-5" onClick={onRetry}><RefreshCw className="h-4 w-4" /> Tentar novamente</Button></div></div></section>;
}

function DrilldownDialog({ drilldown, data, loading, error, periodText, onClose, onPage }: { drilldown: Drilldown | null; data: AnalyticsResponse | null; loading: boolean; error: string; periodText: string; onClose: () => void; onPage: (page: number) => void }) {
  const details = data?.details;
  return <Dialog open={Boolean(drilldown)} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[92vh] overflow-y-auto p-4 sm:max-w-3xl sm:p-6"><DialogHeader><DialogTitle>{drilldown?.title ?? "Detalhes"}</DialogTitle><DialogDescription>{periodText}</DialogDescription></DialogHeader>{loading ? <div className="space-y-3 py-5">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-20 animate-pulse rounded-2xl bg-[#edf2f0]" />)}</div> : error ? <div role="alert" className="rounded-2xl bg-[#fff0ed] p-4 text-sm text-[#963d33]">{error}</div> : details ? <><div className="rounded-2xl bg-[#123a33] p-4 text-white"><p className="text-xs uppercase tracking-[0.1em] text-white/60">Total encontrado</p><p className="mt-1 text-2xl font-semibold">{brl(data?.totals.expense.currentCents ?? 0)}</p><p className="mt-1 text-xs text-white/60">{details.totalItems} {details.totalItems === 1 ? "movimentação" : "movimentações"}</p></div>{details.items.length ? <div className="divide-y">{details.items.map((item) => <DetailRow key={`${item.entityType}-${item.id}`} item={item} />)}</div> : <EmptyBlock icon={ReceiptText} title="Nenhuma movimentação encontrada" text="Não há detalhes para este filtro no período selecionado." compact />}{details.totalPages > 1 && <DialogFooter className="flex-row items-center justify-between sm:justify-between"><Button variant="outline" size="sm" disabled={details.page <= 1} onClick={() => onPage(details.page - 1)}><ChevronLeft className="h-4 w-4" /> Anterior</Button><span className="text-xs text-[#71837e]">Página {details.page} de {details.totalPages}</span><Button variant="outline" size="sm" disabled={details.page >= details.totalPages} onClick={() => onPage(details.page + 1)}>Próxima <ChevronRight className="h-4 w-4" /></Button></DialogFooter>}</> : null}</DialogContent></Dialog>;
}

function DetailRow({ item }: { item: AnalyticsDetail }) {
  return <article className="flex min-w-0 gap-3 py-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#fff1df] text-[#95591d]"><ReceiptText className="h-4 w-4" /></span><div className="min-w-0 flex-1"><div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-medium">{item.description}</p><p className="mt-1 text-xs text-[#748681]">{dateLabel(item.date)} · {item.categoryName} / {item.subcategoryName}</p></div><strong className="shrink-0 text-[#965a1d]">− {brl(item.amountCents)}</strong></div><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#80908c]"><span>{item.accountName}</span>{item.responsibleName && <span>Responsável: {item.responsibleName}</span>}{item.installmentNumber && <span>Parcela {item.installmentNumber}/{item.installmentCount}</span>}</div></div></article>;
}

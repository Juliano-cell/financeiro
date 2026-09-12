"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowDownLeft, ArrowUp, ArrowUpRight, BarChart3, ChevronLeft, ChevronRight, CircleDollarSign, CreditCard, Lightbulb, Minus, RefreshCw, RotateCcw, Tags, UserRound, Wallet, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { FinancePeriodFilter, type FinancePeriodSelection } from "@/app/finance-period-filter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AnalyticsBreakdown, AnalyticsComparison, AnalyticsDetail, AnalyticsResponse, AnalyticsTrend } from "@/lib/finance-analytics-types";

type ReportAccount = { id: string; name: string; isActive: boolean };
type ReportSubcategory = { id: string; name: string; categoryId: string };
type ReportCategory = { id: string; name: string; type: "income" | "expense" | "both"; isActive: boolean; subcategories: ReportSubcategory[] };
type ReportMember = { userId: string | null; status: "active" | "invited" | "inactive"; name: string | null };
type ReportType = "all" | "income" | "expense";
type ReportFilters = { type: ReportType; accountId: string; categoryId: string; subcategoryId: string; responsibleUserId: string };

const emptyFilters: ReportFilters = { type: "all", accountId: "", categoryId: "", subcategoryId: "", responsibleUserId: "" };
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const compactCurrency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const dateFormatter = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const monthFormatter = new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit", timeZone: "UTC" });

const finite = (value: number) => Number.isFinite(value) ? value : 0;
const brl = (cents: number) => currency.format(finite(cents) / 100);
const compactBrl = (cents: number) => compactCurrency.format(finite(cents) / 100);
const formatPercent = (value: number | null) => value === null || !Number.isFinite(value) ? null : `${percent.format(Math.abs(value))}%`;
const dateLabel = (value: string) => dateFormatter.format(new Date(`${value}T00:00:00Z`));
const monthLabel = (value: string) => monthFormatter.format(new Date(`${value}-01T00:00:00Z`)).replace(" de ", " ");

function reportUrl(selection: FinancePeriodSelection, filters: ReportFilters, page: number) {
  const params = new URLSearchParams({ view: "report", period: selection.period, page: String(page), limit: "20" });
  if (selection.period === "custom" && selection.from && selection.to) {
    params.set("from", selection.from);
    params.set("to", selection.to);
  }
  if (filters.type !== "all") params.set("type", filters.type);
  if (filters.accountId) params.set("accountId", filters.accountId);
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.subcategoryId) params.set("subcategoryId", filters.subcategoryId);
  if (filters.responsibleUserId) params.set("responsibleUserId", filters.responsibleUserId);
  return `/api/finance/analytics?${params.toString()}`;
}

async function requestReport(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, credentials: "same-origin" });
  const payload = await response.json() as AnalyticsResponse & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Não foi possível carregar o relatório.");
  return payload;
}

export function FinanceReports({ accounts, categories, members }: { accounts: ReportAccount[]; categories: ReportCategory[]; members: ReportMember[] }) {
  const [selection, setSelection] = useState<FinancePeriodSelection>({ period: "this_month" });
  const [filters, setFilters] = useState<ReportFilters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    void requestReport(reportUrl(selection, filters, page), controller.signal)
      .then((payload) => { if (!controller.signal.aborted && currentRequest === requestId.current) setData(payload); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || currentRequest !== requestId.current) return;
        setError(cause instanceof Error ? cause.message : "Não foi possível carregar o relatório.");
      })
      .finally(() => { if (!controller.signal.aborted && currentRequest === requestId.current) setLoading(false); });
    return () => controller.abort();
  }, [filters, page, reload, selection]);

  const refresh = () => {
    setLoading(true);
    setError("");
    setReload((value) => value + 1);
  };
  const updateSelection = (next: FinancePeriodSelection) => {
    setLoading(true);
    setError("");
    setPage(1);
    setSelection(next);
  };
  const updateFilters = (update: (current: ReportFilters) => ReportFilters) => {
    setLoading(true);
    setError("");
    setPage(1);
    setFilters(update);
  };
  const updateType = (type: ReportType) => updateFilters((current) => {
    const selectedCategory = categories.find((item) => item.id === current.categoryId);
    if (selectedCategory && type !== "all" && selectedCategory.type !== "both" && selectedCategory.type !== type) return { ...current, type, categoryId: "", subcategoryId: "" };
    return { ...current, type };
  });
  const updateCategory = (categoryId: string) => updateFilters((current) => {
    const keepsSubcategory = categories.find((item) => item.id === categoryId)?.subcategories.some((item) => item.id === current.subcategoryId);
    return { ...current, categoryId, subcategoryId: keepsSubcategory ? current.subcategoryId : "" };
  });
  const applyCategory = (categoryId: string) => updateCategory(categoryId);
  const applySubcategory = (subcategoryId: string) => {
    const category = categories.find((item) => item.subcategories.some((subcategory) => subcategory.id === subcategoryId));
    updateFilters((current) => ({ ...current, categoryId: category?.id ?? "", subcategoryId }));
  };

  const availableCategories = categories.filter((item) => filters.type === "all" || item.type === "both" || item.type === filters.type);
  const availableSubcategories = categories.find((item) => item.id === filters.categoryId)?.subcategories ?? [];
  const availableMembers = members.filter((item): item is ReportMember & { userId: string } => Boolean(item.userId));
  const activeFilters = buildActiveFilters(filters, accounts, categories, availableMembers);

  if (loading && !data) return <ReportsSkeleton selection={selection} onSelection={updateSelection} />;
  if (!data) return <ReportsFailure selection={selection} onSelection={updateSelection} message={error} onRetry={refresh} />;

  const details = data.details;
  const periodText = `${dateLabel(data.period.current.start)} a ${dateLabel(data.period.current.end)}`;
  const topCategory = data.rankings.categories[0];
  const topIncrease = data.rankings.categoryVariations.find((item) => item.comparison.direction === "increase");
  const topReduction = data.rankings.categoryVariations.find((item) => item.comparison.direction === "decrease");

  return (
    <section className="min-w-0 space-y-5 sm:space-y-6" aria-busy={loading}>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-sm font-medium text-[#668079]">Análise detalhada da família</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">Relatórios financeiros</h2>
          <p className="mt-2 text-sm text-[#71837e]">{periodText}</p>
        </div>
        <div className="w-full xl:max-w-3xl"><FinancePeriodFilter value={selection} onChange={updateSelection} /></div>
      </div>

      <article className="rounded-[24px] border bg-white p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-semibold">Filtros do relatório</h3><p className="mt-1 text-sm text-[#71837e]">Refine os números e as movimentações sem sair desta tela.</p></div><Button type="button" variant="outline" size="sm" disabled={!activeFilters.length} onClick={() => updateFilters(() => emptyFilters)}><RotateCcw className="h-4 w-4" /> Limpar filtros</Button></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <FilterSelect label="Tipo" value={filters.type} onChange={(value) => updateType(value as ReportType)} options={[{ value: "all", label: "Todos" }, { value: "income", label: "Entradas" }, { value: "expense", label: "Despesas" }]} />
          <FilterSelect label="Conta" value={filters.accountId || "all"} onChange={(value) => updateFilters((current) => ({ ...current, accountId: value === "all" ? "" : value }))} options={[{ value: "all", label: "Todas" }, ...accounts.map((item) => ({ value: item.id, label: `${item.name}${item.isActive ? "" : " · inativa"}` }))]} />
          <FilterSelect label="Categoria" value={filters.categoryId || "all"} onChange={(value) => updateCategory(value === "all" ? "" : value)} options={[{ value: "all", label: "Todas" }, ...availableCategories.map((item) => ({ value: item.id, label: `${item.name}${item.isActive ? "" : " · inativa"}` }))]} />
          <FilterSelect label="Subcategoria" value={filters.subcategoryId || "all"} disabled={!filters.categoryId} onChange={(value) => updateFilters((current) => ({ ...current, subcategoryId: value === "all" ? "" : value }))} options={[{ value: "all", label: filters.categoryId ? "Todas" : "Escolha uma categoria" }, ...availableSubcategories.map((item) => ({ value: item.id, label: item.name }))]} />
          <FilterSelect label="Responsável" value={filters.responsibleUserId || "all"} onChange={(value) => updateFilters((current) => ({ ...current, responsibleUserId: value === "all" ? "" : value }))} options={[{ value: "all", label: "Todos" }, ...availableMembers.map((item) => ({ value: item.userId, label: `${item.name ?? "Usuário"}${item.status === "active" ? "" : " · histórico"}` }))]} />
        </div>
        {activeFilters.length > 0 && <div className="mt-4 flex flex-wrap gap-2" aria-label="Filtros ativos">{activeFilters.map((filter) => <button key={filter.key} type="button" onClick={() => filter.remove(updateFilters)} className="flex min-h-9 items-center gap-2 rounded-full bg-[#eaf2ef] px-3 text-xs font-medium text-[#365f57]">{filter.label}<X className="h-3.5 w-3.5" /></button>)}</div>}
      </article>

      {error && <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-[#e9c98e] bg-[#fff8e9] p-4 text-sm text-[#7d5618] sm:flex-row sm:items-center sm:justify-between"><span>Os dados anteriores continuam visíveis, mas a atualização falhou: {error}</span><Button size="sm" variant="outline" onClick={refresh}><RefreshCw className="h-4 w-4" /> Tentar novamente</Button></div>}

      <div className={`grid gap-3 md:grid-cols-3 ${loading ? "opacity-60" : ""}`}>
        <SummaryCard label="Entradas" icon={<ArrowDownLeft className="h-5 w-5" />} comparison={data.totals.income} tone="green" />
        <SummaryCard label="Despesas" icon={<ArrowUpRight className="h-5 w-5" />} comparison={data.totals.expense} tone="orange" />
        <SummaryCard label="Resultado" icon={<CircleDollarSign className="h-5 w-5" />} comparison={data.totals.result} tone="blue" />
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[1.35fr_.65fr]">
        <article className="min-w-0 rounded-[24px] border bg-white p-4 sm:p-6">
          <SectionHeading title="Evolução financeira" description="Entradas, despesas e resultado no período filtrado" />
          {data.timeline.length > 1 ? <div className="mt-5 h-72 min-w-0 sm:h-80"><ResponsiveContainer width="100%" height="100%"><LineChart data={data.timeline} margin={{ top: 8, right: 6, left: -10, bottom: 0 }}><CartesianGrid stroke="#e8eeeb" strokeDasharray="4 4" vertical={false} /><XAxis dataKey="month" tickFormatter={monthLabel} axisLine={false} tickLine={false} fontSize={11} minTickGap={18} /><YAxis tickFormatter={(value) => compactBrl(Number(value))} axisLine={false} tickLine={false} fontSize={11} width={72} /><Tooltip labelFormatter={(value) => monthLabel(String(value))} formatter={(value, name) => [brl(Number(value)), String(name)]} contentStyle={{ borderRadius: 14, borderColor: "#dfe7e4" }} /><Line type="monotone" dataKey="incomeCents" name="Entradas" stroke="#6b9d48" strokeWidth={2.5} dot={{ r: 3 }} /><Line type="monotone" dataKey="expenseCents" name="Despesas" stroke="#dc8335" strokeWidth={2.5} dot={{ r: 3 }} /><Line type="monotone" dataKey="resultCents" name="Resultado" stroke="#4d766e" strokeWidth={2.5} dot={{ r: 3 }} /></LineChart></ResponsiveContainer></div> : <EmptyBlock icon={BarChart3} title="Sem evolução suficiente" text="Amplie o período para visualizar a evolução ao longo dos meses." />}
        </article>
        <article className="rounded-[24px] border bg-white p-4 sm:p-6">
          <SectionHeading title="Comparativos" description="Destaques fornecidos pelo analytics" />
          {topCategory || topIncrease || topReduction ? <div className="mt-5 space-y-3"><ComparisonHighlight label="Maior gasto" item={topCategory} value={topCategory ? brl(topCategory.currentCents) : null} onClick={topCategory?.id ? () => applyCategory(topCategory.id!) : undefined} /><ComparisonHighlight label="Maior aumento" item={topIncrease} value={topIncrease ? comparisonValue(topIncrease.comparison) : null} onClick={topIncrease?.id ? () => applyCategory(topIncrease.id!) : undefined} /><ComparisonHighlight label="Maior redução" item={topReduction} value={topReduction ? comparisonValue(topReduction.comparison) : null} onClick={topReduction?.id ? () => applyCategory(topReduction.id!) : undefined} /></div> : <EmptyBlock icon={BarChart3} title="Sem comparativos disponíveis" text="Precisamos de despesas e histórico comparável para destacar mudanças." compact />}
        </article>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <RankingSection title="Categorias" description="Onde a família concentrou as despesas" items={data.rankings.categories} empty="Nenhuma categoria encontrada neste relatório." onSelect={applyCategory} />
        <RankingSection title="Subcategorias" description="Gastos concretos e comportamento histórico" items={data.rankings.subcategories} empty="Nenhuma subcategoria encontrada neste relatório." onSelect={applySubcategory} showHistory />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <article className="rounded-[24px] border bg-white p-4 sm:p-6">
          <SectionHeading title="Movimentação por conta" description="Saídas reais incluem pagamentos de fatura, sem criar uma nova despesa geral" />
          {data.rankings.accountMovements.length ? <div className="mt-4 grid gap-3 sm:grid-cols-2">{data.rankings.accountMovements.map((item) => <button key={item.accountId} type="button" onClick={() => updateFilters((current) => ({ ...current, accountId: item.accountId }))} className="rounded-2xl border p-4 text-left transition hover:border-[#98b8af] hover:bg-[#f8faf9]"><div className="flex items-center gap-2"><Wallet className="h-4 w-4 text-[#56736b]" /><h4 className="min-w-0 flex-1 truncate font-semibold">{item.accountName}</h4><ChevronRight className="h-4 w-4 text-[#96a6a2]" /></div><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><AmountLabel label="Entradas" value={item.incomeCents} tone="green" /><AmountLabel label="Saídas reais" value={item.expenseCents} tone="orange" /><AmountLabel label="Líquido" value={item.netMovementCents} tone={item.netMovementCents >= 0 ? "green" : "orange"} /><div><span className="text-[#7b8c87]">Movimentações</span><strong className="mt-1 block text-sm">{item.movementCount}</strong></div></div></button>)}</div> : <EmptyBlock icon={Wallet} title="Nenhuma conta movimentada" text="Não há movimentações de conta para os filtros selecionados." compact />}
        </article>

        <article className="rounded-[24px] border bg-white p-4 sm:p-6">
          <SectionHeading title="Responsáveis pelos lançamentos" description="Mostra quem registrou ou ficou responsável. Os valores continuam pertencendo à família." />
          {data.rankings.responsibleMovements.length ? <div className="mt-4 space-y-3">{data.rankings.responsibleMovements.map((item) => <button key={item.responsibleUserId ?? item.responsibleName} type="button" disabled={!item.responsibleUserId} onClick={() => item.responsibleUserId && updateFilters((current) => ({ ...current, responsibleUserId: item.responsibleUserId! }))} className="w-full rounded-2xl border p-4 text-left transition enabled:hover:border-[#98b8af] enabled:hover:bg-[#f8faf9] disabled:cursor-default"><div className="flex items-center gap-2"><UserRound className="h-4 w-4 text-[#56736b]" /><h4 className="min-w-0 flex-1 truncate font-semibold">{item.responsibleName}</h4>{item.responsibleUserId && <ChevronRight className="h-4 w-4 text-[#96a6a2]" />}</div><div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4"><AmountLabel label="Entradas" value={item.incomeCents} tone="green" /><AmountLabel label="Despesas" value={item.expenseCents} tone="orange" /><AmountLabel label="Líquido" value={item.netMovementCents} tone={item.netMovementCents >= 0 ? "green" : "orange"} /><div><span className="text-[#7b8c87]">Registros</span><strong className="mt-1 block text-sm">{item.movementCount}</strong></div></div></button>)}</div> : <EmptyBlock icon={UserRound} title="Sem responsáveis no período" text="Não há lançamentos atribuídos para os filtros selecionados." compact />}
        </article>
      </div>

      <article className="rounded-[24px] border bg-white p-4 sm:p-6">
        <SectionHeading title="Resumo inteligente" description="Insights determinísticos e histórico dos dados filtrados" />
        {data.insights.length ? <div className="mt-4 grid gap-3 md:grid-cols-2">{data.insights.map((insight) => <div key={insight.key} className={`flex gap-3 rounded-2xl p-4 ${insight.tone === "positive" ? "bg-[#eff8e9] text-[#365c29]" : insight.tone === "warning" ? "bg-[#fff5e7] text-[#82521a]" : "bg-[#f1f5f3] text-[#49635d]"}`}><Lightbulb className="mt-0.5 h-4 w-4 shrink-0" /><p className="text-sm leading-6">{insight.message}</p></div>)}</div> : <EmptyBlock icon={Lightbulb} title="Sem insights para estes filtros" text="Tente ampliar o período ou remover algum filtro." compact />}
      </article>

      <article className="rounded-[24px] border bg-white p-4 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><SectionHeading title="Movimentações do relatório" description="Ordem mais recente fornecida pelo relatório" />{details && <p className="text-xs text-[#71837e]">{details.totalItems} {details.totalItems === 1 ? "resultado" : "resultados"}</p>}</div>
        {details?.items.length ? <div className="mt-4 divide-y">{details.items.map((item) => <ReportMovement key={`${item.entityType}-${item.id}`} item={item} />)}</div> : <EmptyBlock icon={CreditCard} title="Nenhuma movimentação encontrada" text="Tente ampliar o período ou remover algum filtro." />}
        {details && details.totalPages > 1 && <div className="mt-4 flex items-center justify-between gap-2 border-t pt-4"><Button variant="outline" size="sm" disabled={loading || details.page <= 1} onClick={() => { setLoading(true); setError(""); setPage(details.page - 1); }}><ChevronLeft className="h-4 w-4" /> Anterior</Button><span className="text-xs text-[#71837e]">Página {details.page} de {details.totalPages}</span><Button variant="outline" size="sm" disabled={loading || details.page >= details.totalPages} onClick={() => { setLoading(true); setError(""); setPage(details.page + 1); }}>Próxima <ChevronRight className="h-4 w-4" /></Button></div>}
      </article>
    </section>
  );
}

function FilterSelect({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean }) {
  return <div className="min-w-0"><p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#71837e]">{label}</p><Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger className="h-11 w-full rounded-xl"><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>;
}

function SummaryCard({ label, icon, comparison, tone }: { label: string; icon: React.ReactNode; comparison: AnalyticsComparison; tone: "green" | "orange" | "blue" }) {
  const colors = { green: "bg-[#eff8e9] text-[#315f29]", orange: "bg-[#fff3e2] text-[#89521b]", blue: "bg-[#eaf3f1] text-[#355f58]" };
  const emptyLabel = comparison.currentCents === 0 && label !== "Resultado" ? `Nenhuma ${label.toLocaleLowerCase("pt-BR").replace("despesas", "despesa").replace("entradas", "entrada")} no período` : null;
  return <article className={`rounded-[22px] p-5 ${colors[tone]}`}><span className="grid h-10 w-10 place-items-center rounded-xl bg-white/70">{icon}</span><p className="mt-4 text-xs font-semibold uppercase tracking-[0.1em] opacity-70">{label}</p><p className="mt-2 text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">{brl(comparison.currentCents)}</p>{emptyLabel && <p className="mt-2 text-xs font-medium">{emptyLabel}</p>}<p className="mt-2 text-xs opacity-75">Anterior: {brl(comparison.previousCents)}</p><p className="mt-1 text-xs font-medium"><ComparisonText comparison={comparison} /></p></article>;
}

function ComparisonText({ comparison }: { comparison: AnalyticsComparison }) {
  if (!comparison.hasComparableHistory) return <>Sem histórico suficiente para comparar</>;
  const value = formatPercent(comparison.percentChange);
  if (!value) return <>Sem base percentual anterior</>;
  if (comparison.direction === "stable") return <><Minus className="mr-1 inline h-3.5 w-3.5" />Estável</>;
  const increase = comparison.direction === "increase" || comparison.direction === "new";
  return <>{increase ? <ArrowUp className="mr-1 inline h-3.5 w-3.5" /> : <ArrowDown className="mr-1 inline h-3.5 w-3.5" />}{value}</>;
}

function RankingSection({ title, description, items, empty, onSelect, showHistory = false }: { title: string; description: string; items: AnalyticsBreakdown[]; empty: string; onSelect: (id: string) => void; showHistory?: boolean }) {
  return <article className="rounded-[24px] border bg-white p-4 sm:p-6"><SectionHeading title={title} description={description} />{items.length ? <ol className="mt-4 space-y-2">{items.map((item, index) => <li key={`${item.id ?? "none"}-${item.name}`}><button type="button" disabled={!item.id} onClick={() => item.id && onSelect(item.id)} className="w-full rounded-2xl px-2 py-3 text-left transition enabled:hover:bg-[#f5f8f6] disabled:cursor-default"><div className="flex min-w-0 items-center gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#edf3f0] text-sm font-semibold text-[#58706a]">{index + 1}</span><span className="min-w-0 flex-1 truncate font-medium">{item.name}</span><span className="shrink-0 text-right"><strong className="block text-sm sm:text-base">{brl(item.currentCents)}</strong><span className="text-xs text-[#71837e]">{percent.format(finite(item.sharePercent))}%</span></span>{item.id && <ChevronRight className="h-4 w-4 shrink-0 text-[#96a6a2]" />}</div><div className="ml-11 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#71837e]"><ComparisonText comparison={item.comparison} />{showHistory && item.historicalAverage.sufficientHistory && item.historicalAverage.averageCents !== null && <><span>Média: {brl(item.historicalAverage.averageCents)}</span><HistoricalAverageLabel comparison={item.historicalAverage.comparison} /></>}{showHistory && <TrendLabel trend={item.trend} />}</div></button></li>)}</ol> : <EmptyBlock icon={Tags} title={empty} text="Tente ampliar o período ou remover algum filtro." compact />}</article>;
}

function HistoricalAverageLabel({ comparison }: { comparison: AnalyticsComparison | null }) {
  if (!comparison) return null;
  if (comparison.direction === "stable") return <span>Na média histórica</span>;
  if (comparison.direction === "increase" || comparison.direction === "new") return <span>Acima da média histórica</span>;
  return <span>Abaixo da média histórica</span>;
}

function TrendLabel({ trend }: { trend: AnalyticsTrend }) {
  const labels: Record<AnalyticsTrend["direction"], string> = { increasing: "Tendência de alta", decreasing: "Tendência de queda", stable: "Tendência estável", mixed: "Tendência variável", insufficient: "Sem histórico de tendência" };
  return <span>{labels[trend.direction]}</span>;
}

function AmountLabel({ label, value, tone }: { label: string; value: number; tone: "green" | "orange" }) {
  return <div><span className="text-[#7b8c87]">{label}</span><strong className={`mt-1 block text-sm ${tone === "green" ? "text-[#39742c]" : "text-[#9b5b17]"}`}>{brl(value)}</strong></div>;
}

function ComparisonHighlight({ label, item, value, onClick }: { label: string; item: AnalyticsBreakdown | undefined; value: string | null; onClick?: () => void }) {
  if (!item || !value) return <div className="rounded-2xl bg-[#f5f8f6] p-4"><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#7b8c87]">{label}</p><p className="mt-2 text-sm text-[#71837e]">Sem dados suficientes</p></div>;
  const content = <><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#7b8c87]">{label}</p><div className="mt-2 flex items-center justify-between gap-3"><span className="min-w-0 truncate font-medium">{item.name}</span><strong className="shrink-0 text-sm">{value}</strong></div></>;
  return onClick ? <button type="button" onClick={onClick} className="w-full rounded-2xl bg-[#f5f8f6] p-4 text-left hover:bg-[#edf3f0]">{content}</button> : <div className="rounded-2xl bg-[#f5f8f6] p-4">{content}</div>;
}

function comparisonValue(comparison: AnalyticsComparison) {
  const value = formatPercent(comparison.percentChange);
  if (!value) return null;
  return `${comparison.direction === "decrease" ? "−" : "+"}${value}`;
}

function ReportMovement({ item }: { item: AnalyticsDetail }) {
  const income = item.type === "income";
  return <article className="min-w-0 py-4"><div className="flex min-w-0 items-start gap-3"><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${income ? "bg-[#eff8e9] text-[#39742c]" : "bg-[#fff1df] text-[#95591d]"}`}>{income ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}</span><div className="min-w-0 flex-1"><div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3"><div className="min-w-0"><p className="font-medium sm:truncate">{item.description}</p><p className="mt-1 text-xs text-[#748681]">{dateLabel(item.date)}</p></div><strong className={`shrink-0 ${income ? "text-[#39742c]" : "text-[#965a1d]"}`}>{income ? "+" : "−"} {brl(item.amountCents)}</strong></div><div className="mt-3 flex flex-wrap gap-2 text-xs text-[#627872]"><Badge variant="outline">{income ? "Entrada" : "Despesa"}</Badge><span className="rounded-full bg-[#f1f5f3] px-2.5 py-1">{item.categoryName}</span><span className="rounded-full bg-[#f1f5f3] px-2.5 py-1">{item.subcategoryName}</span><span className="rounded-full bg-[#f1f5f3] px-2.5 py-1">{item.accountName}</span><span className="rounded-full bg-[#f1f5f3] px-2.5 py-1">{item.responsibleName}</span>{item.entityType === "card_installment" && <span className="rounded-full bg-[#eee8ff] px-2.5 py-1 text-[#6848a3]">Cartão · parcela {item.installmentNumber}/{item.installmentCount}</span>}</div></div></div></article>;
}

function buildActiveFilters(filters: ReportFilters, accounts: ReportAccount[], categories: ReportCategory[], members: Array<ReportMember & { userId: string }>) {
  const items: Array<{ key: keyof ReportFilters; label: string; remove: (update: (fn: (current: ReportFilters) => ReportFilters) => void) => void }> = [];
  const add = (key: keyof ReportFilters, label: string, clearWith?: keyof ReportFilters) => items.push({ key, label, remove: (update) => update((current) => ({ ...current, [key]: key === "type" ? "all" : "", ...(clearWith ? { [clearWith]: "" } : {}) })) });
  if (filters.type !== "all") add("type", filters.type === "income" ? "Entradas" : "Despesas");
  if (filters.accountId) add("accountId", accounts.find((item) => item.id === filters.accountId)?.name ?? "Conta filtrada");
  if (filters.categoryId) add("categoryId", categories.find((item) => item.id === filters.categoryId)?.name ?? "Categoria filtrada", "subcategoryId");
  if (filters.subcategoryId) add("subcategoryId", categories.flatMap((item) => item.subcategories).find((item) => item.id === filters.subcategoryId)?.name ?? "Subcategoria filtrada");
  if (filters.responsibleUserId) add("responsibleUserId", members.find((item) => item.userId === filters.responsibleUserId)?.name ?? "Responsável filtrado");
  return items;
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return <div><h3 className="text-lg font-semibold tracking-[-0.02em]">{title}</h3><p className="mt-1 text-sm leading-6 text-[#71837e]">{description}</p></div>;
}

function EmptyBlock({ icon: Icon, title, text, compact = false }: { icon: typeof Tags; title: string; text: string; compact?: boolean }) {
  return <div className={`grid place-items-center text-center ${compact ? "min-h-36 pt-4" : "min-h-56 pt-5"}`}><div><span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-[#edf3f0] text-[#6a807a]"><Icon className="h-5 w-5" /></span><p className="mt-3 font-medium">{title}</p><p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-[#7a8c87]">{text}</p></div></div>;
}

function ReportsSkeleton({ selection, onSelection }: { selection: FinancePeriodSelection; onSelection: (value: FinancePeriodSelection) => void }) {
  return <section className="space-y-5"><div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><div className="h-4 w-40 animate-pulse rounded bg-[#dfe7e4]" /><div className="mt-3 h-8 w-64 animate-pulse rounded bg-[#dfe7e4]" /></div><div className="w-full xl:max-w-3xl"><FinancePeriodFilter value={selection} onChange={onSelection} disabled /></div></div><div className="h-48 animate-pulse rounded-[24px] bg-[#dfe7e4]" /><div className="grid gap-3 md:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <div key={index} className="h-48 animate-pulse rounded-[22px] bg-[#dfe7e4]" />)}</div><div className="h-96 animate-pulse rounded-[24px] bg-[#dfe7e4]" /></section>;
}

function ReportsFailure({ selection, onSelection, message, onRetry }: { selection: FinancePeriodSelection; onSelection: (value: FinancePeriodSelection) => void; message: string; onRetry: () => void }) {
  return <section className="space-y-5"><div className="flex justify-end"><div className="w-full xl:max-w-3xl"><FinancePeriodFilter value={selection} onChange={onSelection} /></div></div><div className="grid min-h-[420px] place-items-center rounded-[24px] border bg-white p-6 text-center"><div><span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#fff0dd] text-[#925619]"><RefreshCw className="h-5 w-5" /></span><h2 className="mt-4 text-xl font-semibold">Não foi possível carregar o relatório</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#71837e]">{message || "Ocorreu uma falha temporária ao buscar os dados."}</p><Button className="mt-5" onClick={onRetry}><RefreshCw className="h-4 w-4" /> Tentar novamente</Button></div></div></section>;
}

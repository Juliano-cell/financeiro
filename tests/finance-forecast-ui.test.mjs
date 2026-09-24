import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FORECAST_HORIZONS,
  forecastMonthLabel,
  forecastMonthPresentation,
  forecastSummary,
  forecastWarningPresentation,
} from "../lib/finance-forecast-ui.mjs";

const component = readFileSync(new URL("../app/finance-forecast.tsx", import.meta.url), "utf8");
const parent = readFileSync(new URL("../app/finance-app.tsx", import.meta.url), "utf8");

function month(overrides = {}) {
  return {
    month: "2027-01",
    openingBalanceCents: 1_304_270,
    knownFutureIncomeCents: 10_000,
    futureIncomeCents: 10_000,
    expectedIncomeCents: 302_000,
    overdueExpectedIncomeCents: 20_000,
    futureTransactionExpenseCents: 5_000,
    overdueBillsCents: 100,
    dueBillsCents: 20,
    cardInvoiceRemainingCents: 20_000,
    knownOutflowCents: 25_120,
    projectedNetCashFlowCents: 306_880,
    closingBalanceCents: 1_611_150,
    details: {},
    ...overrides,
  };
}

function forecast(overrides = {}) {
  return {
    currentBalanceCents: 1_576_167,
    knownFutureIncomeCents: 10_000,
    expectedIncomeCents: 604_000,
    overdueExpectedIncomeCents: 20_000,
    knownFutureOutflowCents: 250_000,
    projectedEndingBalanceCents: 1_960_167,
    months: [month(), month({ month: "2027-02", openingBalanceCents: 1_611_150, expectedIncomeCents: 302_000, overdueExpectedIncomeCents: 0, closingBalanceCents: 1_893_150 })],
    warnings: [],
    ...overrides,
  };
}

test("resumo usa exclusivamente totais canônicos e identifica menor closing", () => {
  assert.deepEqual(forecastSummary(forecast()), {
    currentBalanceCents: 1_576_167,
    projectedIncomeCents: 634_000,
    projectedOutflowCents: 250_000,
    projectedEndingBalanceCents: 1_960_167,
    lowestMonth: { month: "2027-01", closingBalanceCents: 1_611_150 },
    hasNegativeMonth: false,
    hasFutureActivity: true,
  });
});

test("saldo negativo é derivado somente do closing retornado", () => {
  const value = forecastSummary(forecast({ months: [month({ month: "2026-12", closingBalanceCents: -1 })] }));
  assert.equal(value.hasNegativeMonth, true);
  assert.deepEqual(value.lowestMonth, { month: "2026-12", closingBalanceCents: -1 });
});

test("bucket separa expected, overdue, legado, bills, faturas e saída futura", () => {
  assert.deepEqual(forecastMonthPresentation(month()), {
    month: "2027-01",
    openingBalanceCents: 1_304_270,
    projectedIncomeCents: 332_000,
    projectedOutflowCents: 25_120,
    closingBalanceCents: 1_611_150,
    isNegative: false,
    income: { expectedIncomeCents: 302_000, overdueExpectedIncomeCents: 20_000, knownFutureIncomeCents: 10_000 },
    outflow: { pendingBillsCents: 120, cardInvoiceCents: 20_000, futureTransactionExpenseCents: 5_000 },
  });
});

test("R$3.020 permanece em occurrences mensais separadas", () => {
  const months = ["2027-01", "2027-02", "2027-03", "2027-04"].map((key) => forecastMonthPresentation(month({ month: key, expectedIncomeCents: 302_000, knownFutureIncomeCents: 0, overdueExpectedIncomeCents: 0 })));
  assert.deepEqual(months.map((value) => value.income.expectedIncomeCents), [302_000, 302_000, 302_000, 302_000]);
  assert.ok(months.every((value) => value.projectedIncomeCents === 302_000));
});

test("exemplo local de seis meses é apresentado exatamente como recebido da API", () => {
  const apiMonths = [
    ["2026-09", 1_576_167, 10_000, 17_200, 101_990, 1_466_977],
    ["2026-10", 1_466_977, 0, 17_600, 50_000, 1_399_377],
    ["2026-11", 1_399_377, 0, 15_453, 50_000, 1_333_924],
    ["2026-12", 1_333_924, 0, 9_654, 20_000, 1_304_270],
    ["2027-01", 1_304_270, 302_000, 120, 20_000, 1_586_150],
    ["2027-02", 1_586_150, 302_000, 0, 20_000, 1_868_150],
  ].map(([key, opening, expected, bills, card, closing]) => forecastMonthPresentation(month({
    month: key,
    openingBalanceCents: opening,
    knownFutureIncomeCents: 0,
    expectedIncomeCents: expected,
    overdueExpectedIncomeCents: 0,
    futureTransactionExpenseCents: 0,
    overdueBillsCents: 0,
    dueBillsCents: bills,
    cardInvoiceRemainingCents: card,
    knownOutflowCents: bills + card,
    closingBalanceCents: closing,
  })));
  assert.deepEqual(apiMonths.map((value) => [
    value.month,
    value.openingBalanceCents,
    value.income.expectedIncomeCents,
    value.outflow.pendingBillsCents,
    value.outflow.cardInvoiceCents,
    value.closingBalanceCents,
  ]), [
    ["2026-09", 1_576_167, 10_000, 17_200, 101_990, 1_466_977],
    ["2026-10", 1_466_977, 0, 17_600, 50_000, 1_399_377],
    ["2026-11", 1_399_377, 0, 15_453, 50_000, 1_333_924],
    ["2026-12", 1_333_924, 0, 9_654, 20_000, 1_304_270],
    ["2027-01", 1_304_270, 302_000, 120, 20_000, 1_586_150],
    ["2027-02", 1_586_150, 302_000, 0, 20_000, 1_868_150],
  ]);
});

test("labels mensais preservam calendário civil", () => {
  assert.equal(forecastMonthLabel("2027-01"), "janeiro de 2027");
  assert.equal(forecastMonthLabel("2028-02"), "fevereiro de 2028");
  assert.equal(forecastMonthLabel("invalid"), "Mês indisponível");
});

test("warnings possuem linguagem segura e nunca decidem duplicidade", () => {
  assert.match(forecastWarningPresentation("UNREGISTERED_INCOME_NOT_INCLUDED").description, /apenas as entradas cadastradas/u);
  assert.match(forecastWarningPresentation("POSSIBLE_FUTURE_INCOME_OVERLAP").description, /podem representar/u);
  assert.match(forecastWarningPresentation("POSSIBLE_FUTURE_INCOME_OVERLAP").description, /mantidos separados/u);
  for (const code of ["RECURRENCE_COVERAGE_LIMITED", "EXPECTED_INCOME_COVERAGE_LIMITED"]) assert.match(forecastWarningPresentation(code).description, /pode ficar incompleta/u);
});

test("navegação desktop e mobile integra Previsão com componente dedicado", () => {
  assert.match(parent, /"forecast"/u);
  assert.match(parent, /label: "Previsão"/u);
  assert.match(parent, /ChartNoAxesCombined/u);
  assert.match(parent, /view === "forecast".*<FinanceForecast/u);
  assert.match(parent, /\["dashboard", "reports", "forecast", "transactions", "bills", "settings"\]/u);
  assert.match(parent, /grid-cols-6/u);
});

test("interface usa somente GET Forecast com horizontes simples 3, 6 e 12", () => {
  assert.deepEqual(FORECAST_HORIZONS, [3, 6, 12]);
  assert.match(component, /useState\(6\)/u);
  assert.match(component, /\/api\/finance\/forecast\?months=\$\{months\}/u);
  assert.match(component, /method: "GET"/u);
  assert.doesNotMatch(component, /method: "(?:POST|PUT|PATCH|DELETE)"/u);
  assert.doesNotMatch(component, /householdId/u);
});

test("cabeçalho e resumo distinguem saldo real de estimativas", () => {
  assert.match(component, /Previsão financeira/u);
  assert.match(component, /saldo pode evoluir/u);
  assert.match(component, /Saldo hoje/u);
  assert.match(component, /Saldo real e canônico atual/u);
  assert.match(component, /Saldo projetado/u);
  assert.match(component, /Estimativa ao fim do horizonte/u);
});

test("composição mensal separa todas as identidades financeiras", () => {
  for (const label of ["Entradas previstas", "Entradas previstas atrasadas", "Entradas futuras já lançadas", "Contas", "Faturas de cartão", "Outras saídas futuras já lançadas"]) assert.match(component, new RegExp(label, "u"));
  assert.doesNotMatch(component, /\.details\./u);
});

test("expansão usa button real, aria-expanded e painel controlado", () => {
  assert.match(component, /<Button type="button"[^>]*aria-expanded=\{expanded\}[^>]*aria-controls=\{panelId\}/u);
  assert.match(component, /expandedMonths/u);
  assert.match(component, /Ver composição/u);
});

test("cadeia apresenta opening e closing da API sem recalcular closing", () => {
  assert.match(component, /saldo projetado anterior vira o saldo inicial/iu);
  assert.match(component, /openingBalanceCents/u);
  assert.match(component, /closingBalanceCents/u);
  assert.doesNotMatch(component, /openingBalanceCents\s*[+-]/u);
  assert.doesNotMatch(component, /projectedNetCashFlowCents/u);
});

test("negativo possui texto e alerta, não depende somente de cor", () => {
  assert.match(component, /Saldo projetado negativo/u);
  assert.match(component, /projeção fica negativa em pelo menos um mês/u);
  assert.match(component, /hasNegativeMonth/u);
});

test("privacy mascara todos os valores sem vazar cents em aria ou title", () => {
  assert.match(component, /formatFinancialCents\(Math\.abs\(cents\), \{ hidden \}\)/u);
  assert.match(component, /aria-label=\{hidden \? "Valor financeiro oculto" : undefined\}/u);
  assert.doesNotMatch(component, /aria-label=\{[^}]*cents/u);
  assert.doesNotMatch(component, /title=\{[^}]*cents/u);
});

test("dark mode usa tokens semânticos e não cria paleta hexadecimal", () => {
  for (const token of ["bg-card", "text-card-foreground", "text-muted-foreground", "border-border", "bg-muted", "text-destructive", "text-primary"]) assert.match(component, new RegExp(token, "u"));
  assert.doesNotMatch(component, /#[0-9a-f]{3,8}/iu);
});

test("mobile usa cards empilháveis sem tabela ou scroll horizontal obrigatório", () => {
  assert.match(component, /grid gap-3 sm:grid-cols-2 xl:grid-cols-4/u);
  assert.match(component, /flex flex-col gap-2 sm:flex-row/u);
  assert.match(component, /break-words/u);
  assert.doesNotMatch(component, /<Table|overflow-x-auto/u);
});

test("loading, erro, retry e vazio são explícitos sem falso zero", () => {
  assert.match(component, /aria-busy="true"/u);
  assert.match(component, /<Skeleton/u);
  assert.match(component, /Não foi possível carregar a previsão\./u);
  assert.match(component, /Tentar novamente/u);
  assert.match(component, /Poucos lançamentos futuros/u);
  const skeleton = component.slice(component.indexOf("function ForecastSkeleton"));
  assert.doesNotMatch(skeleton, /R\$\s*0/u);
});

test("warnings visuais são acessíveis e oferecem somente ação explícita segura", () => {
  assert.match(component, /aria-label="Avisos da previsão"/u);
  assert.match(component, /Adicionar entrada prevista/u);
  assert.match(component, /onNavigate\("expected-income"\)/u);
  assert.doesNotMatch(component, /materialize|deduplic/u);
});

test("requisições antigas são abortadas ao trocar horizonte ou desmontar", () => {
  assert.match(component, /new AbortController\(\)/u);
  assert.match(component, /fetchForecast\(horizon, controller\.signal\)/u);
  assert.match(component, /return \(\) => controller\.abort\(\)/u);
  assert.match(component, /if \(controller\.signal\.aborted\) return/u);
});

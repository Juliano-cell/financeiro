import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDashboardNavigationIntent, initializeReportFromDashboard } from "../lib/dashboard-navigation.ts";

const presets = ["this_month", "previous_month", "last_3_months", "last_6_months", "last_12_months"];

test("Saldo navega somente para Contas", () => {
  const intent = createDashboardNavigationIntent("balance", { period: "last_3_months" });
  assert.deepEqual(intent, { target: "accounts" });
  assert.equal(initializeReportFromDashboard(intent), null);
});

test("Entradas, despesas e resultado inicializam o Relatório com o tipo correto", () => {
  const period = { period: "previous_month" };
  assert.equal(initializeReportFromDashboard(createDashboardNavigationIntent("income", period)).filters.type, "income");
  assert.equal(initializeReportFromDashboard(createDashboardNavigationIntent("expense", period)).filters.type, "expense");
  assert.equal(initializeReportFromDashboard(createDashboardNavigationIntent("result", period)).filters.type, "all");
});

test("todos os períodos predefinidos são preservados sem datas personalizadas residuais", () => {
  for (const period of presets) {
    const state = initializeReportFromDashboard(createDashboardNavigationIntent("expense", { period, from: "2026-01-01", to: "2026-01-31" }));
    assert.deepEqual(state.selection, { period });
    assert.equal(state.page, 1);
  }
});

test("período personalizado preserva from e to literalmente", () => {
  const selection = { period: "custom", from: "2026-08-01", to: "2026-08-31" };
  const state = initializeReportFromDashboard(createDashboardNavigationIntent("income", selection));
  assert.deepEqual(state.selection, selection);
});

test("navegação pelo Dashboard limpa todos os filtros secundários", () => {
  const state = initializeReportFromDashboard(createDashboardNavigationIntent("expense", { period: "this_month" }));
  assert.deepEqual(state.filters, { type: "expense", accountId: "", categoryId: "", subcategoryId: "", responsibleUserId: "" });
  state.filters.accountId = "account";
  assert.equal(state.filters.accountId, "account", "os filtros continuam editáveis depois da inicialização");
});

test("intenção é consumida e os quatro cards usam botões acessíveis", () => {
  const app = readFileSync(new URL("../app/finance-app.tsx", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../app/finance-dashboard.tsx", import.meta.url), "utf8");
  const reports = readFileSync(new URL("../app/finance-reports.tsx", import.meta.url), "utf8");
  assert.match(reports, /if \(navigationIntent\) onNavigationIntentConsumed\(\)/);
  assert.match(app, /setDashboardNavigationIntent\(null\)/);
  assert.equal((dashboard.match(/<KpiCard label=/g) ?? []).length, 4);
  assert.match(dashboard, /return <button type="button"/);
  assert.match(dashboard, /aria-label=\{ariaLabel\}/);
  assert.match(dashboard, /focus-visible:ring-2/);
});

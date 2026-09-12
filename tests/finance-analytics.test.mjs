import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addDays,
  buildDeterministicInsights,
  calculateComparison,
  calculateHistoricalAverage,
  dateInTimeZone,
  detectDeterministicTrend,
  listMonths,
  previousCompleteMonths,
  resolveAnalyticsPeriod,
  safeShare,
} from "../lib/finance-analytics.mjs";

test("calendário financeiro usa America/Sao_Paulo na virada do ano", () => {
  assert.equal(dateInTimeZone(new Date("2026-01-01T01:30:00.000Z")), "2025-12-31");
  assert.equal(dateInTimeZone(new Date("2026-01-01T03:30:00.000Z")), "2026-01-01");
});

test("período deste mês compara os mesmos dias do mês anterior", () => {
  assert.deepEqual(resolveAnalyticsPeriod({ period: "this_month", today: "2026-03-31" }), {
    preset: "this_month",
    today: "2026-03-31",
    current: { start: "2026-03-01", end: "2026-03-31" },
    previous: { start: "2026-02-01", end: "2026-02-28" },
    days: 31,
  });
  assert.deepEqual(resolveAnalyticsPeriod({ period: "this_month", today: "2026-01-12" }).previous, { start: "2025-12-01", end: "2025-12-12" });
});

test("mês passado e intervalos personalizados atravessam mês e ano", () => {
  const previous = resolveAnalyticsPeriod({ period: "previous_month", today: "2026-01-10" });
  assert.deepEqual(previous.current, { start: "2025-12-01", end: "2025-12-31" });
  assert.deepEqual(previous.previous, { start: "2025-11-01", end: "2025-11-30" });
  const custom = resolveAnalyticsPeriod({ period: "custom", from: "2025-12-29", to: "2026-01-03", today: "2026-01-10" });
  assert.deepEqual(custom.previous, { start: "2025-12-23", end: "2025-12-28" });
  assert.equal(custom.days, 6);
});

test("intervalos longos têm janela anterior de mesma duração", () => {
  const period = resolveAnalyticsPeriod({ period: "last_3_months", today: "2026-09-12" });
  assert.deepEqual(period.current, { start: "2026-07-01", end: "2026-09-12" });
  assert.equal(period.days, 74);
  assert.equal(addDays(period.previous.end, 1), period.current.start);
  assert.equal(resolveAnalyticsPeriod({ period: "custom", from: "2024-01-01", to: "2027-01-01", today: "2027-01-01" }).days, 1097);
  assert.throws(() => resolveAnalyticsPeriod({ period: "custom", from: "2024-01-01", to: "2027-01-02" }), /36 meses/);
});

test("comparação trata período anterior zerado sem NaN ou Infinity", () => {
  assert.deepEqual(calculateComparison(0, 0), { currentCents: 0, previousCents: 0, absoluteChangeCents: 0, percentChange: null, direction: "stable", hasComparableHistory: false });
  assert.deepEqual(calculateComparison(10_000, 0), { currentCents: 10_000, previousCents: 0, absoluteChangeCents: 10_000, percentChange: null, direction: "new", hasComparableHistory: false });
  assert.equal(calculateComparison(0, 10_000).percentChange, -100);
  assert.equal(calculateComparison(12_500, 10_000).percentChange, 25);
  for (const comparison of [calculateComparison(0, 0), calculateComparison(1, 0), calculateComparison(0, 1)]) {
    assert.equal(Number.isNaN(comparison.percentChange), false);
    assert.notEqual(comparison.percentChange, Infinity);
  }
});

test("média e tendência exigem histórico suficiente", () => {
  assert.deepEqual(calculateHistoricalAverage([], 2), { averageCents: null, samples: 0, sufficientHistory: false });
  assert.deepEqual(calculateHistoricalAverage([100], 2), { averageCents: null, samples: 1, sufficientHistory: false });
  assert.deepEqual(calculateHistoricalAverage([100, 200, 300], 2), { averageCents: 200, samples: 3, sufficientHistory: true });
  assert.deepEqual(detectDeterministicTrend([100, 200]), { direction: "insufficient", samples: 2 });
  assert.equal(detectDeterministicTrend([100, 200, 300]).direction, "increasing");
  assert.equal(detectDeterministicTrend([300, 200, 100]).direction, "decreasing");
  assert.equal(detectDeterministicTrend([100, 100, 100]).direction, "stable");
  assert.equal(detectDeterministicTrend([100, 300, 200]).direction, "mixed");
});

test("séries mensais e percentuais vazios são estáveis", () => {
  assert.deepEqual(listMonths("2025-11-30", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(previousCompleteMonths("2026-01-10", 3), ["2025-10", "2025-11", "2025-12"]);
  assert.equal(safeShare(1, 0), 0);
  assert.equal(safeShare(2500, 10_000), 25);
});

test("insights determinísticos não inventam comparação sem histórico", () => {
  const insights = buildDeterministicInsights({
    expenseComparison: calculateComparison(20_000, 0),
    categories: [{ id: "food", name: "Alimentação", currentCents: 12_000, sharePercent: 60, trend: { direction: "insufficient" } }],
    subcategories: [],
  });
  assert.ok(insights.some((item) => item.key === "expense_no_base"));
  assert.ok(insights.some((item) => item.key === "top_category"));
  assert.ok(!insights.some((item) => item.message.includes("Infinity") || item.message.includes("NaN")));
});

test("endpoint não aceita householdId e exige cache privado", () => {
  const route = readFileSync(new URL("../app/api/finance/analytics/route.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../lib/finance-analytics-service.ts", import.meta.url), "utf8");
  assert.match(route, /\.strict\(\)/);
  assert.doesNotMatch(route, /^\s*householdId:/mu);
  assert.match(route, /private, no-store, max-age=0/);
  assert.match(service, /eq\(householdMembers\.status, "active"\)/);
  assert.match(service, /WHERE household_id = \? AND id = \?/);
  assert.match(service, /ON hm\.household_id = e\.household_id AND hm\.user_id = e\.responsible_user_id/);
});

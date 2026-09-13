import type { AnalyticsPeriodPreset, AnalyticsTransactionType } from "@/lib/finance-analytics-types";

export type DashboardPeriodSelection = {
  period: AnalyticsPeriodPreset;
  from?: string;
  to?: string;
};

export type DashboardCard = "balance" | "income" | "expense" | "result";

export type DashboardNavigationIntent =
  | { target: "accounts" }
  | { target: "reports"; period: DashboardPeriodSelection; type?: AnalyticsTransactionType };

export type DashboardReportFilters = {
  type: "all" | AnalyticsTransactionType;
  accountId: string;
  categoryId: string;
  subcategoryId: string;
  responsibleUserId: string;
};

function canonicalPeriod(selection: DashboardPeriodSelection): DashboardPeriodSelection {
  if (selection.period === "custom") return { period: "custom", from: selection.from, to: selection.to };
  return { period: selection.period };
}

export function createDashboardNavigationIntent(card: DashboardCard, selection: DashboardPeriodSelection): DashboardNavigationIntent {
  if (card === "balance") return { target: "accounts" };
  const type = card === "income" ? "income" : card === "expense" ? "expense" : undefined;
  return { target: "reports", period: canonicalPeriod(selection), ...(type ? { type } : {}) };
}

export function initializeReportFromDashboard(intent: DashboardNavigationIntent | null) {
  if (!intent || intent.target !== "reports") return null;
  return {
    selection: canonicalPeriod(intent.period),
    filters: {
      type: intent.type ?? "all",
      accountId: "",
      categoryId: "",
      subcategoryId: "",
      responsibleUserId: "",
    } satisfies DashboardReportFilters,
    page: 1,
  };
}

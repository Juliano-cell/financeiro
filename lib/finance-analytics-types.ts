export type AnalyticsPeriodPreset = "this_month" | "previous_month" | "last_3_months" | "last_6_months" | "last_12_months" | "custom";
export type AnalyticsView = "dashboard" | "report";
export type AnalyticsTransactionType = "income" | "expense";

export type DateRange = { start: string; end: string };

export type ResolvedAnalyticsPeriod = {
  preset: AnalyticsPeriodPreset;
  today: string;
  current: DateRange;
  previous: DateRange;
  days: number;
};

export type AnalyticsComparisonDirection = "increase" | "decrease" | "stable" | "new";

export type AnalyticsComparison = {
  currentCents: number;
  previousCents: number;
  absoluteChangeCents: number;
  percentChange: number | null;
  direction: AnalyticsComparisonDirection;
  hasComparableHistory: boolean;
};

export type AnalyticsAverage = {
  averageCents: number | null;
  samples: number;
  sufficientHistory: boolean;
  comparison: AnalyticsComparison | null;
};

export type AnalyticsTrend = {
  direction: "increasing" | "decreasing" | "stable" | "mixed" | "insufficient";
  samples: number;
};

export type AnalyticsBreakdown = {
  id: string | null;
  name: string;
  color?: string;
  currentCents: number;
  previousCents: number;
  sharePercent: number;
  comparison: AnalyticsComparison;
  historicalAverage: AnalyticsAverage;
  trend: AnalyticsTrend;
};

export type AnalyticsTimelinePoint = {
  month: string;
  incomeCents: number;
  expenseCents: number;
  resultCents: number;
};

export type AnalyticsDetail = {
  id: string;
  entityType: "transaction" | "card_installment";
  date: string;
  competenceMonth: string;
  type: AnalyticsTransactionType;
  amountCents: number;
  description: string;
  categoryId: string | null;
  categoryName: string;
  subcategoryId: string | null;
  subcategoryName: string;
  accountId: string | null;
  accountName: string;
  responsibleUserId: string | null;
  responsibleName: string;
  paymentMethod: string | null;
  origin: string;
  installmentNumber: number | null;
  installmentCount: number | null;
};

export type AccountMovementRanking = {
  accountId: string;
  accountName: string;
  incomeCents: number;
  expenseCents: number;
  netMovementCents: number;
  movementCents: number;
  movementCount: number;
};

export type ResponsibleMovementRanking = {
  responsibleUserId: string | null;
  responsibleName: string;
  incomeCents: number;
  expenseCents: number;
  netMovementCents: number;
  movementCount: number;
};

export type AnalyticsInsight = {
  key: string;
  tone: "positive" | "warning" | "neutral";
  message: string;
};

export type AnalyticsFilters = {
  view: AnalyticsView;
  period: AnalyticsPeriodPreset;
  from?: string;
  to?: string;
  categoryId?: string;
  subcategoryId?: string;
  accountId?: string;
  type?: AnalyticsTransactionType;
  responsibleUserId?: string;
  page: number;
  limit: number;
};

export type AnalyticsResponse = {
  period: ResolvedAnalyticsPeriod;
  filters: Omit<AnalyticsFilters, "view">;
  balance: { currentCents: number };
  totals: {
    income: AnalyticsComparison;
    expense: AnalyticsComparison;
    result: AnalyticsComparison;
  };
  categories: AnalyticsBreakdown[];
  subcategories: AnalyticsBreakdown[];
  timeline: AnalyticsTimelinePoint[];
  insights: AnalyticsInsight[];
  rankings: {
    categories: AnalyticsBreakdown[];
    subcategories: AnalyticsBreakdown[];
    categoryVariations: AnalyticsBreakdown[];
    subcategoryVariations: AnalyticsBreakdown[];
    largestExpenses: AnalyticsDetail[];
    accountMovements: AccountMovementRanking[];
    responsibleMovements: ResponsibleMovementRanking[];
  };
  history: {
    months: string[];
    eligibleMonths: string[];
    sufficient: boolean;
  };
  details: null | {
    items: AnalyticsDetail[];
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
  };
};

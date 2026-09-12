import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getCurrentUser } from "@/app/auth";
import { getDb } from "@/db";
import { householdMembers, households } from "@/db/schema";
import {
  ACCOUNT_MOVEMENTS_CTE,
  buildDeterministicInsights,
  calculateComparison,
  calculateHistoricalAverage,
  CURRENT_ACCOUNT_BALANCES_SQL,
  detectDeterministicTrend,
  endOfMonth,
  FINANCIAL_EVENTS_CTE,
  listMonths,
  previousCompleteMonths,
  resolveAnalyticsPeriod,
  safeShare,
} from "@/lib/finance-analytics.mjs";
import type {
  AccountMovementRanking,
  AnalyticsBreakdown,
  AnalyticsComparison,
  AnalyticsDetail,
  AnalyticsFilters,
  AnalyticsResponse,
  AnalyticsTimelinePoint,
  DateRange,
  ResponsibleMovementRanking,
} from "@/lib/finance-analytics-types";

type AnalyticsContext = {
  userId: string;
  householdId: string;
  householdCreatedAt: string;
};

type IdentityResult =
  | { status: "unauthenticated" }
  | { status: "no_active_household" }
  | { status: "ok"; context: AnalyticsContext };

type SqlRow = Record<string, unknown>;
type QueryParts = { sql: string; bindings: unknown[] };

export class FinanceAnalyticsValidationError extends Error {}

const NO_CATEGORY = "Sem categoria";
const NO_SUBCATEGORY = "Sem subcategoria";
const NO_ACCOUNT = "Sem conta";
const NO_RESPONSIBLE = "Usuário indisponível";

function database() {
  if (!env.DB) throw new Error("D1 binding indisponível");
  return env.DB;
}

function integer(row: SqlRow | undefined, key: string) {
  const value = Number(row?.[key] ?? 0);
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.length ? value : null;
}

function resultRows(result: D1Result<unknown> | undefined) {
  return ((result?.results ?? []) as SqlRow[]);
}

function eventDimensions(filters: AnalyticsFilters, alias = "e"): QueryParts {
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  const add = (column: string, value: string | undefined) => {
    if (!value) return;
    clauses.push(`${alias}.${column} = ?`);
    bindings.push(value);
  };
  add("category_id", filters.categoryId);
  add("subcategory_id", filters.subcategoryId);
  add("account_id", filters.accountId);
  add("type", filters.type);
  add("responsible_user_id", filters.responsibleUserId);
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", bindings };
}

function accountMovementDimensions(filters: AnalyticsFilters): QueryParts {
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  const add = (column: string, value: string | undefined) => {
    if (!value) return;
    clauses.push(`am.${column} = ?`);
    bindings.push(value);
  };
  add("category_id", filters.categoryId);
  add("subcategory_id", filters.subcategoryId);
  add("account_id", filters.accountId);
  add("type", filters.type);
  add("responsible_user_id", filters.responsibleUserId);
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", bindings };
}

function eventStatement(householdId: string, sql: string, bindings: unknown[] = []) {
  return database().prepare(`${FINANCIAL_EVENTS_CTE}\n${sql}`).bind(householdId, householdId, ...bindings);
}

function detailSelect(where: string, suffix = "") {
  return `
    SELECT
      e.id,
      e.entity_type,
      e.event_date,
      e.competence_month,
      e.type,
      e.amount_cents,
      e.description,
      e.category_id,
      COALESCE(c.name, '${NO_CATEGORY}') AS category_name,
      e.subcategory_id,
      COALESCE(s.name, '${NO_SUBCATEGORY}') AS subcategory_name,
      e.account_id,
      CASE WHEN e.card_id IS NOT NULL THEN 'Cartão · ' || COALESCE(e.card_name, 'Cartão') ELSE COALESCE(a.name, '${NO_ACCOUNT}') END AS account_name,
      hm.user_id AS responsible_user_id,
      COALESCE(u.name, '${NO_RESPONSIBLE}') AS responsible_name,
      e.payment_method,
      e.origin,
      e.installment_number,
      e.installment_count
    FROM financial_events e
    LEFT JOIN categories c ON c.household_id = e.household_id AND c.id = e.category_id
    LEFT JOIN subcategories s ON s.household_id = e.household_id AND s.id = e.subcategory_id
    LEFT JOIN accounts a ON a.household_id = e.household_id AND a.id = e.account_id
    LEFT JOIN household_members hm ON hm.household_id = e.household_id AND hm.user_id = e.responsible_user_id
    LEFT JOIN users u ON u.id = hm.user_id
    WHERE ${where}
    ${suffix}
  `;
}

function mapDetail(row: SqlRow): AnalyticsDetail {
  return {
    id: String(row.id),
    entityType: row.entity_type === "card_installment" ? "card_installment" : "transaction",
    date: String(row.event_date),
    competenceMonth: String(row.competence_month),
    type: row.type === "income" ? "income" : "expense",
    amountCents: integer(row, "amount_cents"),
    description: String(row.description),
    categoryId: nullableString(row.category_id),
    categoryName: String(row.category_name ?? NO_CATEGORY),
    subcategoryId: nullableString(row.subcategory_id),
    subcategoryName: String(row.subcategory_name ?? NO_SUBCATEGORY),
    accountId: nullableString(row.account_id),
    accountName: String(row.account_name ?? NO_ACCOUNT),
    responsibleUserId: nullableString(row.responsible_user_id),
    responsibleName: String(row.responsible_name ?? NO_RESPONSIBLE),
    paymentMethod: nullableString(row.payment_method),
    origin: String(row.origin ?? "system"),
    installmentNumber: row.installment_number === null || row.installment_number === undefined ? null : integer(row, "installment_number"),
    installmentCount: row.installment_count === null || row.installment_count === undefined ? null : integer(row, "installment_count"),
  };
}

export async function resolveAuthenticatedAnalyticsContext(): Promise<IdentityResult> {
  const user = await getCurrentUser();
  if (!user) return { status: "unauthenticated" };
  const db = getDb();
  const [membership] = await db
    .select({ householdId: householdMembers.householdId, householdCreatedAt: households.createdAt })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active")))
    .limit(1);
  if (!membership) return { status: "no_active_household" };
  return { status: "ok", context: { userId: user.id, householdId: membership.householdId, householdCreatedAt: membership.householdCreatedAt } };
}

async function validateFilters(householdId: string, filters: AnalyticsFilters) {
  const checks: Array<{ label: string; statement: D1PreparedStatement }> = [];
  const d1 = database();
  if (filters.categoryId) checks.push({ label: "categoria", statement: d1.prepare("SELECT id FROM categories WHERE household_id = ? AND id = ? LIMIT 1").bind(householdId, filters.categoryId) });
  if (filters.subcategoryId) {
    checks.push({
      label: "subcategoria",
      statement: d1.prepare("SELECT id FROM subcategories WHERE household_id = ? AND id = ? AND (? IS NULL OR category_id = ?) LIMIT 1").bind(householdId, filters.subcategoryId, filters.categoryId ?? null, filters.categoryId ?? null),
    });
  }
  if (filters.accountId) checks.push({ label: "conta", statement: d1.prepare("SELECT id FROM accounts WHERE household_id = ? AND id = ? LIMIT 1").bind(householdId, filters.accountId) });
  if (filters.responsibleUserId) checks.push({ label: "responsável", statement: d1.prepare("SELECT id FROM household_members WHERE household_id = ? AND user_id = ? LIMIT 1").bind(householdId, filters.responsibleUserId) });
  if (!checks.length) return;
  const results = await d1.batch(checks.map((item) => item.statement));
  const invalid = checks.find((_, index) => resultRows(results[index]).length === 0);
  if (invalid) throw new FinanceAnalyticsValidationError(`Filtro de ${invalid.label} inválido para esta família.`);
}

export async function getCurrentAccountBalances(householdId: string, today: string) {
  const result = await database().prepare(CURRENT_ACCOUNT_BALANCES_SQL).bind(householdId, today, householdId, today, householdId).all<{
    account_id: string;
    is_active: number;
    current_balance_cents: number;
  }>();
  return (result.results ?? []).map((row) => ({
    accountId: row.account_id,
    isActive: Boolean(row.is_active),
    currentBalanceCents: Number.isFinite(Number(row.current_balance_cents)) ? Math.round(Number(row.current_balance_cents)) : 0,
  }));
}

function attachHistory(
  rows: SqlRow[],
  totalExpenseCents: number,
  dimensionType: "category" | "subcategory",
  historyRows: SqlRow[],
  historyMonths: string[],
  householdCreatedAt: string,
): AnalyticsBreakdown[] {
  const history = new Map<string, number>();
  for (const row of historyRows.filter((item) => item.dimension_type === dimensionType)) {
    history.set(`${nullableString(row.dimension_id) ?? "__none__"}:${String(row.month)}`, integer(row, "amount_cents"));
  }
  return rows.map((row) => {
    const id = nullableString(row.dimension_id);
    const createdAt = nullableString(row.dimension_created_at)?.slice(0, 10) ?? householdCreatedAt.slice(0, 10);
    const eligibleMonths = historyMonths.filter((month) => endOfMonth(`${month}-01`) >= createdAt);
    const values = eligibleMonths.map((month) => history.get(`${id ?? "__none__"}:${month}`) ?? 0);
    const average = calculateHistoricalAverage(values, 2);
    const currentCents = integer(row, "current_cents");
    const previousCents = integer(row, "previous_cents");
    return {
      id,
      name: String(row.dimension_name ?? (dimensionType === "category" ? NO_CATEGORY : NO_SUBCATEGORY)),
      ...(dimensionType === "category" ? { color: String(row.dimension_color ?? "#798582") } : {}),
      currentCents,
      previousCents,
      sharePercent: safeShare(currentCents, totalExpenseCents),
      comparison: calculateComparison(currentCents, previousCents) as AnalyticsComparison,
      historicalAverage: {
        ...average,
        comparison: average.averageCents === null ? null : calculateComparison(currentCents, average.averageCents),
      },
      trend: detectDeterministicTrend(values),
    } as AnalyticsBreakdown;
  }).sort((a, b) => b.currentCents - a.currentCents || a.name.localeCompare(b.name, "pt-BR"));
}

export async function getFinanceAnalytics(context: AnalyticsContext, filters: AnalyticsFilters): Promise<AnalyticsResponse> {
  await validateFilters(context.householdId, filters);
  let period;
  try {
    period = resolveAnalyticsPeriod({ period: filters.period, from: filters.from, to: filters.to });
  } catch (error) {
    throw new FinanceAnalyticsValidationError(error instanceof Error ? error.message : "Período inválido.");
  }

  const dimension = eventDimensions(filters);
  const currentOrPrevious = "((e.event_date BETWEEN ? AND ?) OR (e.event_date BETWEEN ? AND ?))";
  const comparisonBindings = [period.current.start, period.current.end, period.previous.start, period.previous.end, ...dimension.bindings];
  const historyMonths = previousCompleteMonths(period.current.start, 3);
  const historyRange: DateRange = { start: `${historyMonths[0]}-01`, end: endOfMonth(`${historyMonths.at(-1)}-01`) };
  const historyBindings = [historyRange.start, historyRange.end, ...dimension.bindings];

  const totals = eventStatement(context.householdId, `
    SELECT
      COALESCE(SUM(CASE WHEN e.event_date BETWEEN ? AND ? AND e.type = 'income' THEN e.amount_cents ELSE 0 END), 0) AS current_income,
      COALESCE(SUM(CASE WHEN e.event_date BETWEEN ? AND ? AND e.type = 'expense' THEN e.amount_cents ELSE 0 END), 0) AS current_expense,
      COALESCE(SUM(CASE WHEN e.event_date BETWEEN ? AND ? AND e.type = 'income' THEN e.amount_cents ELSE 0 END), 0) AS previous_income,
      COALESCE(SUM(CASE WHEN e.event_date BETWEEN ? AND ? AND e.type = 'expense' THEN e.amount_cents ELSE 0 END), 0) AS previous_expense
    FROM financial_events e
    WHERE ${currentOrPrevious}${dimension.sql}
  `, [
    period.current.start, period.current.end,
    period.current.start, period.current.end,
    period.previous.start, period.previous.end,
    period.previous.start, period.previous.end,
    ...comparisonBindings,
  ]);

  const categories = eventStatement(context.householdId, `
    SELECT
      e.category_id AS dimension_id,
      COALESCE(c.name, '${NO_CATEGORY}') AS dimension_name,
      COALESCE(c.color, '#798582') AS dimension_color,
      c.created_at AS dimension_created_at,
      COALESCE(SUM(CASE WHEN e.event_date BETWEEN ? AND ? THEN e.amount_cents ELSE 0 END), 0) AS current_cents,
      COALESCE(SUM(CASE WHEN e.event_date BETWEEN ? AND ? THEN e.amount_cents ELSE 0 END), 0) AS previous_cents
    FROM financial_events e
    LEFT JOIN categories c ON c.household_id = e.household_id AND c.id = e.category_id
    WHERE e.type = 'expense' AND ${currentOrPrevious}${dimension.sql}
    GROUP BY e.category_id, c.name, c.color, c.created_at
  `, [period.current.start, period.current.end, period.previous.start, period.previous.end, ...comparisonBindings]);

  const subcategories = eventStatement(context.householdId, `
    SELECT
      e.subcategory_id AS dimension_id,
      COALESCE(s.name, '${NO_SUBCATEGORY}') AS dimension_name,
      s.created_at AS dimension_created_at,
      COALESCE(SUM(CASE WHEN e.event_date BETWEEN ? AND ? THEN e.amount_cents ELSE 0 END), 0) AS current_cents,
      COALESCE(SUM(CASE WHEN e.event_date BETWEEN ? AND ? THEN e.amount_cents ELSE 0 END), 0) AS previous_cents
    FROM financial_events e
    LEFT JOIN subcategories s ON s.household_id = e.household_id AND s.id = e.subcategory_id
    WHERE e.type = 'expense' AND ${currentOrPrevious}${dimension.sql}
    GROUP BY e.subcategory_id, s.name, s.created_at
  `, [period.current.start, period.current.end, period.previous.start, period.previous.end, ...comparisonBindings]);

  const timeline = eventStatement(context.householdId, `
    SELECT
      substr(e.event_date, 1, 7) AS month,
      COALESCE(SUM(CASE WHEN e.type = 'income' THEN e.amount_cents ELSE 0 END), 0) AS income_cents,
      COALESCE(SUM(CASE WHEN e.type = 'expense' THEN e.amount_cents ELSE 0 END), 0) AS expense_cents
    FROM financial_events e
    WHERE e.event_date BETWEEN ? AND ?${dimension.sql}
    GROUP BY substr(e.event_date, 1, 7)
    ORDER BY month
  `, [period.current.start, period.current.end, ...dimension.bindings]);

  const history = eventStatement(context.householdId, `
    SELECT 'category' AS dimension_type, e.category_id AS dimension_id, substr(e.event_date, 1, 7) AS month, SUM(e.amount_cents) AS amount_cents
    FROM financial_events e
    WHERE e.type = 'expense' AND e.event_date BETWEEN ? AND ?${dimension.sql}
    GROUP BY e.category_id, substr(e.event_date, 1, 7)
    UNION ALL
    SELECT 'subcategory' AS dimension_type, e.subcategory_id AS dimension_id, substr(e.event_date, 1, 7) AS month, SUM(e.amount_cents) AS amount_cents
    FROM financial_events e
    WHERE e.type = 'expense' AND e.event_date BETWEEN ? AND ?${dimension.sql}
    GROUP BY e.subcategory_id, substr(e.event_date, 1, 7)
  `, [...historyBindings, ...historyBindings]);

  const expenseWhere = `e.type = 'expense' AND e.event_date BETWEEN ? AND ?${dimension.sql}`;
  const largestExpenses = eventStatement(context.householdId, detailSelect(expenseWhere, "ORDER BY e.amount_cents DESC, e.event_date DESC, e.id DESC LIMIT 10"), [period.current.start, period.current.end, ...dimension.bindings]);

  const movementDimensions = accountMovementDimensions(filters);
  const accountMovements = database().prepare(`${ACCOUNT_MOVEMENTS_CTE}
    SELECT
      a.id AS account_id,
      a.name AS account_name,
      COALESCE(SUM(CASE WHEN am.type = 'income' THEN am.amount_cents ELSE 0 END), 0) AS income_cents,
      COALESCE(SUM(CASE WHEN am.type IN ('expense', 'settlement') THEN am.amount_cents ELSE 0 END), 0) AS expense_cents,
      COALESCE(SUM(CASE WHEN am.type = 'income' THEN am.amount_cents ELSE -am.amount_cents END), 0) AS net_movement_cents,
      COALESCE(SUM(am.amount_cents), 0) AS movement_cents,
      COUNT(*) AS movement_count
    FROM account_movements am
    INNER JOIN accounts a ON a.household_id = am.household_id AND a.id = am.account_id
    WHERE am.event_date BETWEEN ? AND ?${movementDimensions.sql}
    GROUP BY a.id, a.name
    ORDER BY movement_cents DESC, a.name
    LIMIT 10
  `).bind(context.householdId, context.householdId, period.current.start, period.current.end, ...movementDimensions.bindings);

  const responsibleMovements = eventStatement(context.householdId, `
    SELECT
      hm.user_id AS responsible_user_id,
      COALESCE(u.name, '${NO_RESPONSIBLE}') AS responsible_name,
      COALESCE(SUM(CASE WHEN e.type = 'income' THEN e.amount_cents ELSE 0 END), 0) AS income_cents,
      COALESCE(SUM(CASE WHEN e.type = 'expense' THEN e.amount_cents ELSE 0 END), 0) AS expense_cents,
      COALESCE(SUM(CASE WHEN e.type = 'income' THEN e.amount_cents ELSE -e.amount_cents END), 0) AS net_movement_cents,
      COUNT(*) AS movement_count
    FROM financial_events e
    LEFT JOIN household_members hm ON hm.household_id = e.household_id AND hm.user_id = e.responsible_user_id
    LEFT JOIN users u ON u.id = hm.user_id
    WHERE e.event_date BETWEEN ? AND ?${dimension.sql}
    GROUP BY hm.user_id, u.name
    ORDER BY expense_cents DESC, income_cents DESC, responsible_name
  `, [period.current.start, period.current.end, ...dimension.bindings]);

  const statements: D1PreparedStatement[] = [totals, categories, subcategories, timeline, history, largestExpenses, accountMovements, responsibleMovements];
  if (filters.view === "report") {
    statements.push(
      eventStatement(context.householdId, `SELECT COUNT(*) AS total_items FROM financial_events e WHERE e.event_date BETWEEN ? AND ?${dimension.sql}`, [period.current.start, period.current.end, ...dimension.bindings]),
      eventStatement(context.householdId, detailSelect(`e.event_date BETWEEN ? AND ?${dimension.sql}`, "ORDER BY e.event_date DESC, e.id DESC LIMIT ? OFFSET ?"), [period.current.start, period.current.end, ...dimension.bindings, filters.limit, (filters.page - 1) * filters.limit]),
    );
  }

  const [balanceRows, queryResults] = await Promise.all([
    getCurrentAccountBalances(context.householdId, period.today),
    database().batch(statements),
  ]);
  const totalsRow = resultRows(queryResults[0])[0];
  const currentIncome = integer(totalsRow, "current_income");
  const currentExpense = integer(totalsRow, "current_expense");
  const previousIncome = integer(totalsRow, "previous_income");
  const previousExpense = integer(totalsRow, "previous_expense");
  const incomeComparison = calculateComparison(currentIncome, previousIncome) as AnalyticsComparison;
  const expenseComparison = calculateComparison(currentExpense, previousExpense) as AnalyticsComparison;
  const resultComparison = calculateComparison(currentIncome - currentExpense, previousIncome - previousExpense) as AnalyticsComparison;
  const historyResultRows = resultRows(queryResults[4]);
  const categoryBreakdown = attachHistory(resultRows(queryResults[1]), currentExpense, "category", historyResultRows, historyMonths, context.householdCreatedAt);
  const subcategoryBreakdown = attachHistory(resultRows(queryResults[2]), currentExpense, "subcategory", historyResultRows, historyMonths, context.householdCreatedAt);
  const timelineByMonth = new Map(resultRows(queryResults[3]).map((row) => [String(row.month), row]));
  const timelinePoints: AnalyticsTimelinePoint[] = listMonths(period.current.start, period.current.end).map((month: string) => {
    const row = timelineByMonth.get(month);
    const incomeCents = integer(row, "income_cents");
    const expenseCents = integer(row, "expense_cents");
    return { month, incomeCents, expenseCents, resultCents: incomeCents - expenseCents };
  });
  const largestExpenseRows = resultRows(queryResults[5]).map(mapDetail);
  const accountMovementRows: AccountMovementRanking[] = resultRows(queryResults[6]).map((row) => ({
    accountId: String(row.account_id),
    accountName: String(row.account_name),
    incomeCents: integer(row, "income_cents"),
    expenseCents: integer(row, "expense_cents"),
    netMovementCents: integer(row, "net_movement_cents"),
    movementCents: integer(row, "movement_cents"),
    movementCount: integer(row, "movement_count"),
  }));
  const responsibleMovementRows: ResponsibleMovementRanking[] = resultRows(queryResults[7]).map((row) => ({
    responsibleUserId: nullableString(row.responsible_user_id),
    responsibleName: String(row.responsible_name ?? NO_RESPONSIBLE),
    incomeCents: integer(row, "income_cents"),
    expenseCents: integer(row, "expense_cents"),
    netMovementCents: integer(row, "net_movement_cents"),
    movementCount: integer(row, "movement_count"),
  }));

  const eligibleHistoryMonths = historyMonths.filter((month) => endOfMonth(`${month}-01`) >= context.householdCreatedAt.slice(0, 10));
  let details: AnalyticsResponse["details"] = null;
  if (filters.view === "report") {
    const totalItems = integer(resultRows(queryResults[8])[0], "total_items");
    details = {
      items: resultRows(queryResults[9]).map(mapDetail),
      page: filters.page,
      limit: filters.limit,
      totalItems,
      totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / filters.limit),
    };
  }

  const variations = (items: AnalyticsBreakdown[]) => items
    .filter((item) => item.comparison.hasComparableHistory && item.comparison.absoluteChangeCents !== 0)
    .sort((a, b) => Math.abs(b.comparison.absoluteChangeCents) - Math.abs(a.comparison.absoluteChangeCents))
    .slice(0, 10);

  return {
    period,
    filters: {
      period: filters.period,
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.subcategoryId ? { subcategoryId: filters.subcategoryId } : {}),
      ...(filters.accountId ? { accountId: filters.accountId } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.responsibleUserId ? { responsibleUserId: filters.responsibleUserId } : {}),
      page: filters.page,
      limit: filters.limit,
    },
    balance: { currentCents: balanceRows.filter((row) => row.isActive).reduce((sum, row) => sum + row.currentBalanceCents, 0) },
    totals: { income: incomeComparison, expense: expenseComparison, result: resultComparison },
    categories: categoryBreakdown,
    subcategories: subcategoryBreakdown,
    timeline: timelinePoints,
    insights: buildDeterministicInsights({ expenseComparison, categories: categoryBreakdown, subcategories: subcategoryBreakdown }),
    rankings: {
      categories: categoryBreakdown.filter((item) => item.currentCents > 0).slice(0, 10),
      subcategories: subcategoryBreakdown.filter((item) => item.currentCents > 0).slice(0, 10),
      categoryVariations: variations(categoryBreakdown),
      subcategoryVariations: variations(subcategoryBreakdown),
      largestExpenses: largestExpenseRows,
      accountMovements: accountMovementRows,
      responsibleMovements: responsibleMovementRows,
    },
    history: { months: historyMonths, eligibleMonths: eligibleHistoryMonths, sufficient: eligibleHistoryMonths.length >= 2 },
    details,
  };
}

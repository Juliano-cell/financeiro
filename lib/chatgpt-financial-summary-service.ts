import { formatChatGptFinancialSummary } from "./chatgpt-financial-summary-formatter.mjs";
import type {
  ChatGptFinancialSummaryDto,
  ChatGptFinancialSummaryResponse,
  FinancialSummaryBill,
  FinancialSummaryCard,
  FinancialSummaryExpectedIncome,
  FinancialSummaryWarning,
} from "./chatgpt-financial-summary-types";
import { billPaymentAdjustment } from "./bill-payment.mjs";
import { addMonths, dateInTimeZone, endOfMonth } from "./finance-analytics.mjs";
import { getCurrentAccountBalances, getFinanceAnalytics } from "./finance-analytics-service";
import { getFinanceForecast } from "./finance-forecast-service";
import { getInvoiceDetail, INVOICE_DETAIL_MAX_PAGE_SIZE } from "./invoice-detail-service";
import { getHouseholdInvoiceStates } from "./invoice-service";

const TIMEZONE = "America/Sao_Paulo" as const;
const MAX_MONTH_ADVANCE = 23;
const ANALYTICS_PAGE_SIZE = 100;

export type ChatGptFinancialSummaryContext = {
  d1: D1Database;
  householdId: string;
  userId: string;
  householdCreatedAt: string;
  now?: Date;
};

export class ChatGptFinancialSummaryValidationError extends Error {}
export class ChatGptFinancialSummaryIntegrityError extends Error {}

type AccountRow = {
  id: string;
  name: string;
  type: "bank" | "cash" | "savings" | "wallet" | "other";
};

type BillRow = {
  description: string;
  amount_cents: number;
  due_date: string;
  status: "pending" | "paid";
  category_name: string | null;
  subcategory_name: string | null;
  planned_account_name: string | null;
  paid_amount_cents: number | null;
  paid_date: string | null;
  recurrence: "none" | "monthly";
  recurrence_day: number | null;
  installment_number: number | null;
  installment_count: number | null;
  installment_total_cents: number | null;
};

type ExpectedIncomeRow = {
  description: string;
  expected_amount_cents: number;
  expected_date: string;
  status: "pending" | "received";
  planned_account_name: string | null;
  category_name: string | null;
  subcategory_name: string | null;
  received_amount_cents: number | null;
  received_date: string | null;
  actual_account_name: string | null;
  configured_day: number | null;
};

type CardRow = {
  id: string;
  name: string;
  institution: string;
  limit_cents: number;
  closing_day: number;
  due_day: number;
  is_active: number;
};

function assertSafeMoney(value: unknown, label: string, allowNegative = false) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowNegative && parsed < 0)) {
    throw new ChatGptFinancialSummaryIntegrityError(`Valor monetário inconsistente: ${label}.`);
  }
  return parsed;
}

function checkedSum(values: number[], label: string) {
  return values.reduce((sum, value) => {
    const result = sum + value;
    if (!Number.isSafeInteger(result)) throw new ChatGptFinancialSummaryIntegrityError(`Total monetário inconsistente: ${label}.`);
    return result;
  }, 0);
}

function assertDate(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ChatGptFinancialSummaryIntegrityError(`Data inconsistente: ${label}.`);
  }
  return value;
}

function assertMonth(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value)) {
    throw new ChatGptFinancialSummaryIntegrityError(`Competência inconsistente: ${label}.`);
  }
  return value;
}

function monthDistance(fromMonth: string, toMonth: string) {
  const from = Number(fromMonth.slice(0, 4)) * 12 + Number(fromMonth.slice(5, 7));
  const to = Number(toMonth.slice(0, 4)) * 12 + Number(toMonth.slice(5, 7));
  return to - from;
}

export function resolveChatGptSummaryPeriod(now: Date, requestedMonth?: string) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new ChatGptFinancialSummaryValidationError("Data de corte inválida.");
  const asOfDate = dateInTimeZone(now, TIMEZONE);
  const currentMonth = asOfDate.slice(0, 7);
  const month = requestedMonth ?? currentMonth;
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) throw new ChatGptFinancialSummaryValidationError("Competência inválida.");
  const advance = monthDistance(currentMonth, month);
  if (advance < 0 || advance > MAX_MONTH_ADVANCE) {
    throw new ChatGptFinancialSummaryValidationError("A competência deve estar entre o mês atual e os próximos 23 meses.");
  }
  return {
    month,
    currentMonth,
    advance,
    asOfDate,
    generatedAt: now.toISOString(),
    from: `${month}-01`,
    to: endOfMonth(`${month}-01`),
    maximumMonth: addMonths(`${currentMonth}-01`, MAX_MONTH_ADVANCE).slice(0, 7),
  };
}

async function allAnalyticsPages(
  context: ChatGptFinancialSummaryContext,
  period: ReturnType<typeof resolveChatGptSummaryPeriod>,
  now: Date,
) {
  const filters = {
    view: "report" as const,
    period: "custom" as const,
    from: period.from,
    to: period.to,
    page: 1,
    limit: ANALYTICS_PAGE_SIZE,
  };
  const analyticsContext = {
    userId: context.userId,
    householdId: context.householdId,
    householdCreatedAt: context.householdCreatedAt,
    now,
  };
  const first = await getFinanceAnalytics(analyticsContext, filters);
  if (!first.details) throw new ChatGptFinancialSummaryIntegrityError("Detalhamento realizado indisponível.");
  const items = [...first.details.items];
  for (let page = 2; page <= first.details.totalPages; page += 1) {
    const next = await getFinanceAnalytics(analyticsContext, { ...filters, page });
    if (!next.details
      || next.details.totalItems !== first.details.totalItems
      || next.totals.income.currentCents !== first.totals.income.currentCents
      || next.totals.expense.currentCents !== first.totals.expense.currentCents) {
      throw new ChatGptFinancialSummaryIntegrityError("Os dados realizados mudaram durante a leitura.");
    }
    items.push(...next.details.items);
  }
  if (items.length !== first.details.totalItems) throw new ChatGptFinancialSummaryIntegrityError("Detalhamento realizado incompleto.");
  return { analytics: first, items };
}

async function readSupportingRows(context: ChatGptFinancialSummaryContext, month: string, asOfDate: string) {
  const statements = [
    context.d1.prepare(`SELECT id, name, type FROM accounts
      WHERE household_id = ? AND is_active = 1 ORDER BY name COLLATE NOCASE, id`).bind(context.householdId),
    context.d1.prepare(`SELECT
        b.description, b.amount_cents, b.due_date, b.status,
        c.name AS category_name, sc.name AS subcategory_name, a.name AS planned_account_name,
        t.amount_cents AS paid_amount_cents, t.transaction_date AS paid_date,
        b.recurrence, r.day_of_month AS recurrence_day,
        io.installment_number, s.installment_count, s.total_amount_cents AS installment_total_cents
      FROM bills b
      LEFT JOIN categories c ON c.household_id = b.household_id AND c.id = b.category_id
      LEFT JOIN subcategories sc ON sc.household_id = b.household_id AND sc.id = b.subcategory_id
      LEFT JOIN accounts a ON a.household_id = b.household_id AND a.id = b.account_id
      LEFT JOIN transactions t ON t.household_id = b.household_id AND t.id = b.payment_transaction_id
      LEFT JOIN recurring_bill_series r ON r.household_id = b.household_id AND r.id = b.recurrence_series_id
      LEFT JOIN bill_installment_occurrences io ON io.household_id = b.household_id AND io.bill_id = b.id
      LEFT JOIN bill_installment_series s ON s.household_id = io.household_id AND s.id = io.series_id
      WHERE b.household_id = ?
        AND b.status IN ('pending', 'paid')
        AND (substr(b.due_date, 1, 7) = ? OR (b.status = 'pending' AND b.due_date < ?))
      ORDER BY b.due_date, b.description COLLATE NOCASE, b.id`).bind(context.householdId, month, asOfDate),
    context.d1.prepare(`SELECT
        o.description, o.expected_amount_cents, o.expected_date, o.status,
        pa.name AS planned_account_name, c.name AS category_name, sc.name AS subcategory_name,
        t.amount_cents AS received_amount_cents, t.transaction_date AS received_date,
        aa.name AS actual_account_name, s.configured_day
      FROM expected_income_occurrences o
      LEFT JOIN expected_income_series s ON s.household_id = o.household_id AND s.id = o.series_id
      LEFT JOIN accounts pa ON pa.household_id = o.household_id AND pa.id = o.planned_account_id
      LEFT JOIN categories c ON c.household_id = o.household_id AND c.id = o.category_id
      LEFT JOIN subcategories sc ON sc.household_id = o.household_id AND sc.id = o.subcategory_id
      LEFT JOIN transactions t ON t.household_id = o.household_id AND t.id = o.received_transaction_id
      LEFT JOIN accounts aa ON aa.household_id = t.household_id AND aa.id = t.account_id
      WHERE o.household_id = ?
        AND o.status IN ('pending', 'received')
        AND (substr(o.expected_date, 1, 7) = ? OR (o.status = 'pending' AND o.expected_date < ?))
      ORDER BY o.expected_date, o.description COLLATE NOCASE, o.id`).bind(context.householdId, month, asOfDate),
    context.d1.prepare(`SELECT id, name, institution, limit_cents, closing_day, due_day, is_active
      FROM credit_cards WHERE household_id = ? ORDER BY name COLLATE NOCASE, id`).bind(context.householdId),
  ];
  const [accounts, bills, expectedIncome, cards] = await context.d1.batch<unknown>(statements);
  return {
    accountRows: (accounts?.results ?? []) as AccountRow[],
    billRows: (bills?.results ?? []) as BillRow[],
    expectedIncomeRows: (expectedIncome?.results ?? []) as ExpectedIncomeRow[],
    cardRows: (cards?.results ?? []) as CardRow[],
  };
}

function mapBills(rows: BillRow[], month: string, asOfDate: string) {
  return rows.map((row): FinancialSummaryBill => {
    const scheduledAmountCents = assertSafeMoney(row.amount_cents, "conta prevista");
    const dueDate = assertDate(row.due_date, "vencimento");
    if (row.status !== "pending" && row.status !== "paid") throw new ChatGptFinancialSummaryIntegrityError("Status de vencimento inconsistente.");
    const isPaid = row.status === "paid";
    const actualPaidAmountCents = isPaid ? assertSafeMoney(row.paid_amount_cents, "conta paga") : null;
    const paidDate = isPaid ? assertDate(row.paid_date, "pagamento") : null;
    if (!isPaid && (row.paid_amount_cents !== null || row.paid_date !== null)) {
      throw new ChatGptFinancialSummaryIntegrityError("Vencimento pendente com pagamento associado.");
    }
    const adjustment = isPaid ? billPaymentAdjustment(scheduledAmountCents, actualPaidAmountCents) : null;
    const adjustmentType = adjustment?.adjustmentType;
    if (adjustmentType !== undefined && adjustmentType !== "normal" && adjustmentType !== "surcharge" && adjustmentType !== "discount") {
      throw new ChatGptFinancialSummaryIntegrityError("Ajuste de pagamento inconsistente.");
    }
    const installment = row.installment_number === null ? null : {
      number: Number(row.installment_number),
      count: Number(row.installment_count),
      originalTotalCents: assertSafeMoney(row.installment_total_cents, "total parcelado"),
    };
    if (installment && (!Number.isSafeInteger(installment.number) || installment.number < 1
      || !Number.isSafeInteger(installment.count) || installment.count < installment.number)) {
      throw new ChatGptFinancialSummaryIntegrityError("Parcela de vencimento inconsistente.");
    }
    const recurrence = row.recurrence === "monthly" ? {
      type: "monthly" as const,
      configuredDay: Number(row.recurrence_day),
    } : null;
    if (recurrence && (!Number.isSafeInteger(recurrence.configuredDay) || recurrence.configuredDay < 1 || recurrence.configuredDay > 31)) {
      throw new ChatGptFinancialSummaryIntegrityError("Recorrência de vencimento inconsistente.");
    }
    return {
      description: row.description,
      scheduledAmountCents,
      dueDate,
      status: isPaid ? "paid" : dueDate < asOfDate ? "overdue" : "pending",
      categoryName: row.category_name,
      subcategoryName: row.subcategory_name,
      plannedAccountName: row.planned_account_name,
      actualPaidAmountCents,
      paidDate,
      paymentAdjustment: adjustment && adjustmentType
        ? { type: adjustmentType, amountCents: adjustment.adjustmentAmountCents }
        : null,
      recurrence,
      installment,
    };
  }).filter((bill) => bill.status === "overdue" || bill.dueDate.startsWith(month));
}

function mapExpectedIncome(rows: ExpectedIncomeRow[], month: string, asOfDate: string) {
  return rows.map((row): FinancialSummaryExpectedIncome => {
    const expectedDate = assertDate(row.expected_date, "receita prevista");
    const expectedAmountCents = assertSafeMoney(row.expected_amount_cents, "receita prevista");
    if (row.status !== "pending" && row.status !== "received") throw new ChatGptFinancialSummaryIntegrityError("Status de receita prevista inconsistente.");
    const received = row.status === "received";
    const receivedAmountCents = received ? assertSafeMoney(row.received_amount_cents, "receita recebida") : null;
    const receivedDate = received ? assertDate(row.received_date, "recebimento") : null;
    if (!received && (row.received_amount_cents !== null || row.received_date !== null || row.actual_account_name !== null)) {
      throw new ChatGptFinancialSummaryIntegrityError("Receita pendente com recebimento associado.");
    }
    const configuredDay = row.configured_day === null ? null : Number(row.configured_day);
    if (configuredDay !== null && (!Number.isSafeInteger(configuredDay) || configuredDay < 1 || configuredDay > 31)) {
      throw new ChatGptFinancialSummaryIntegrityError("Recorrência de receita inconsistente.");
    }
    return {
      description: row.description,
      expectedAmountCents,
      expectedDate,
      status: row.status,
      timing: received ? "received" : expectedDate < asOfDate ? "overdue" : "pending",
      plannedAccountName: row.planned_account_name,
      categoryName: row.category_name,
      subcategoryName: row.subcategory_name,
      receivedAmountCents,
      receivedDate,
      actualAccountName: received ? row.actual_account_name : null,
      recurrence: configuredDay === null ? null : { type: "monthly", configuredDay },
    };
  }).filter((income) => income.timing === "overdue" || income.expectedDate.startsWith(month));
}

async function readInvoicePurchases(
  context: ChatGptFinancialSummaryContext,
  invoiceId: string,
  timestamp: string,
) {
  const invoiceContext = { d1: context.d1, householdId: context.householdId, userId: context.userId, timestamp };
  const first = await getInvoiceDetail({ invoiceId, pageSize: INVOICE_DETAIL_MAX_PAGE_SIZE }, invoiceContext);
  const items = [...first.active.items];
  for (let page = 2; page <= first.active.totalPages; page += 1) {
    const next = await getInvoiceDetail({
      invoiceId,
      activePage: page,
      pageSize: INVOICE_DETAIL_MAX_PAGE_SIZE,
    }, invoiceContext);
    if (next.invoice.invoiceTotalCents !== first.invoice.invoiceTotalCents
      || next.invoice.paidCents !== first.invoice.paidCents
      || next.invoice.remainingCents !== first.invoice.remainingCents
      || next.active.totalItems !== first.active.totalItems) {
      throw new ChatGptFinancialSummaryIntegrityError("A fatura mudou durante a leitura.");
    }
    items.push(...next.active.items);
  }
  if (items.length !== first.active.totalItems) throw new ChatGptFinancialSummaryIntegrityError("Detalhamento da fatura incompleto.");
  return { detail: first, items };
}

async function mapCards(
  context: ChatGptFinancialSummaryContext,
  cardRows: CardRow[],
  invoiceStates: Awaited<ReturnType<typeof getHouseholdInvoiceStates>>,
  month: string,
  maximumMonth: string,
  timestamp: string,
) {
  const relevantStates = invoiceStates
    .filter((invoice) => invoice.referenceMonth >= month && invoice.referenceMonth <= maximumMonth && invoice.invoiceTotalCents > 0)
    .sort((left, right) => left.referenceMonth.localeCompare(right.referenceMonth) || left.invoiceId.localeCompare(right.invoiceId));
  const cardById = new Map(cardRows.map((card) => [card.id, card]));
  const invoicesByCard = new Map<string, FinancialSummaryCard["invoices"]>();
  for (const state of relevantStates) {
    const card = cardById.get(state.cardId);
    if (!card) throw new ChatGptFinancialSummaryIntegrityError("Fatura sem cartão correspondente.");
    const { detail, items } = await readInvoicePurchases(context, state.invoiceId, timestamp);
    if (detail.invoice.cardId !== state.cardId
      || detail.invoice.cardName !== card.name
      || detail.invoice.referenceMonth !== state.referenceMonth
      || detail.invoice.invoiceTotalCents !== state.invoiceTotalCents
      || detail.invoice.paidCents !== state.paidCents
      || detail.invoice.remainingCents !== state.remainingCents) {
      throw new ChatGptFinancialSummaryIntegrityError("Estado e detalhe da fatura não reconciliam.");
    }
    const invoices = invoicesByCard.get(state.cardId) ?? [];
    invoices.push({
      referenceMonth: assertMonth(state.referenceMonth, "fatura"),
      dueDate: assertDate(state.dueDate, "vencimento da fatura"),
      closesOn: state.closesOn === null ? null : assertDate(state.closesOn, "fechamento da fatura"),
      invoiceTotalCents: assertSafeMoney(state.invoiceTotalCents, "total da fatura"),
      paidCents: assertSafeMoney(state.paidCents, "pagamento da fatura"),
      remainingCents: assertSafeMoney(state.remainingCents, "restante da fatura"),
      cycleStatus: state.cycleStatus,
      paymentStatus: state.paymentStatus,
      openingBalance: detail.openingBalance,
      purchases: items.map((item) => ({
        purchaseDate: assertDate(item.purchaseDate, "compra"),
        description: item.description,
        installmentAmountCents: assertSafeMoney(item.installmentAmountCents, "parcela do cartão"),
        installmentNumber: item.installmentNumber,
        installmentCount: item.installmentCount,
        purchaseTotalCents: assertSafeMoney(item.purchaseTotalCents, "compra do cartão"),
        categoryName: item.categoryName,
        subcategoryName: item.subcategoryName,
      })),
    });
    invoicesByCard.set(state.cardId, invoices);
  }
  return cardRows.map((card): FinancialSummaryCard => ({
    name: card.name,
    institution: card.institution,
    isActive: Number(card.is_active) === 1,
    limitCents: assertSafeMoney(card.limit_cents, "limite do cartão"),
    closingDay: Number(card.closing_day),
    dueDay: Number(card.due_day),
    invoices: invoicesByCard.get(card.id) ?? [],
  })).map((card) => {
    if (!Number.isSafeInteger(card.closingDay) || card.closingDay < 1 || card.closingDay > 31
      || !Number.isSafeInteger(card.dueDay) || card.dueDay < 1 || card.dueDay > 31) {
      throw new ChatGptFinancialSummaryIntegrityError("Calendário de cartão inconsistente.");
    }
    return card;
  });
}

export async function composeChatGptFinancialSummary(
  context: ChatGptFinancialSummaryContext,
  requestedMonth?: string,
): Promise<ChatGptFinancialSummaryDto> {
  const now = context.now ?? new Date();
  const period = resolveChatGptSummaryPeriod(now, requestedMonth);
  const timestamp = period.generatedAt;
  const [
    balances,
    analyticsResult,
    forecast,
    invoiceStates,
    supporting,
  ] = await Promise.all([
    getCurrentAccountBalances(context.householdId, period.asOfDate),
    allAnalyticsPages(context, period, now),
    getFinanceForecast({ d1: context.d1, householdId: context.householdId, now }, period.advance + 1),
    getHouseholdInvoiceStates({ d1: context.d1, householdId: context.householdId, userId: context.userId, timestamp }),
    readSupportingRows(context, period.month, period.asOfDate),
  ]);
  const activeBalances = balances.filter((balance) => balance.isActive);
  const balanceById = new Map(activeBalances.map((balance) => [balance.accountId, balance.currentBalanceCents]));
  if (balanceById.size !== activeBalances.length || supporting.accountRows.length !== activeBalances.length
    || supporting.accountRows.some((account) => !balanceById.has(account.id))) {
    throw new ChatGptFinancialSummaryIntegrityError("As contas ativas mudaram durante a leitura.");
  }
  const accounts = supporting.accountRows.map((account) => ({
    name: account.name,
    type: account.type,
    currentBalanceCents: assertSafeMoney(balanceById.get(account.id), "saldo da conta", true),
  }));
  const totalAvailableCents = checkedSum(accounts.map((account) => account.currentBalanceCents), "saldo disponível");
  if (totalAvailableCents !== analyticsResult.analytics.balance.currentCents
    || totalAvailableCents !== forecast.currentBalanceCents) {
    throw new ChatGptFinancialSummaryIntegrityError("Os saldos canônicos não reconciliam.");
  }

  const bills = mapBills(supporting.billRows, period.month, period.asOfDate);
  const expectedIncome = mapExpectedIncome(supporting.expectedIncomeRows, period.month, period.asOfDate);
  const cards = await mapCards(context, supporting.cardRows, invoiceStates, period.month, period.maximumMonth, timestamp);
  const projection = forecast.months.find((item) => item.month === period.month);
  if (!projection) throw new ChatGptFinancialSummaryIntegrityError("Mês selecionado ausente da projeção.");
  const details = [
    ...projection.details.futureTransactions,
    ...projection.details.expectedIncome,
    ...projection.details.overdueExpectedIncome,
    ...projection.details.overdueBills,
    ...projection.details.dueBills,
    ...projection.details.cardInvoices,
  ];
  const warnings: FinancialSummaryWarning[] = forecast.warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
  }));
  if (period.advance > 0) warnings.push({
    code: "CURRENT_BALANCE_AS_OF_TODAY",
    message: "Os saldos de contas são os saldos reais da data de corte; o saldo do mês futuro aparece somente na projeção.",
  });

  return {
    period: {
      month: period.month,
      generatedAt: period.generatedAt,
      asOfDate: period.asOfDate,
      timezone: TIMEZONE,
      isFutureMonth: period.advance > 0,
    },
    balances: { basis: "current_as_of_date", totalAvailableCents, accounts },
    realized: {
      basis: "realized_by_competence",
      incomeCents: analyticsResult.analytics.totals.income.currentCents,
      expenseCents: analyticsResult.analytics.totals.expense.currentCents,
      resultCents: analyticsResult.analytics.totals.result.currentCents,
      items: analyticsResult.items.map((item) => ({
        date: assertDate(item.date, "realizado"),
        competenceMonth: assertMonth(item.competenceMonth, "realizado"),
        type: item.type,
        amountCents: assertSafeMoney(item.amountCents, "realizado", true),
        description: item.description,
        categoryName: item.categoryName,
        subcategoryName: item.subcategoryName,
        accountName: item.accountName,
        paymentMethod: item.paymentMethod,
        installment: item.installmentNumber === null || item.installmentCount === null
          ? null
          : { number: item.installmentNumber, count: item.installmentCount },
      })),
    },
    expectedIncome: {
      basis: "planned",
      pendingCents: checkedSum(expectedIncome.filter((item) => item.timing === "pending").map((item) => item.expectedAmountCents), "receitas pendentes"),
      overdueCents: checkedSum(expectedIncome.filter((item) => item.timing === "overdue").map((item) => item.expectedAmountCents), "receitas atrasadas"),
      receivedCents: checkedSum(expectedIncome.filter((item) => item.status === "received").map((item) => item.receivedAmountCents ?? 0), "receitas recebidas"),
      items: expectedIncome,
    },
    bills: {
      basis: "planned_due_date",
      pendingCents: checkedSum(bills.filter((bill) => bill.status === "pending").map((bill) => bill.scheduledAmountCents), "contas pendentes"),
      overdueCents: checkedSum(bills.filter((bill) => bill.status === "overdue").map((bill) => bill.scheduledAmountCents), "contas atrasadas"),
      paidScheduledCents: checkedSum(bills.filter((bill) => bill.status === "paid").map((bill) => bill.scheduledAmountCents), "contas pagas previstas"),
      paidActualCents: checkedSum(bills.filter((bill) => bill.status === "paid").map((bill) => bill.actualPaidAmountCents ?? 0), "contas pagas efetivas"),
      items: bills,
    },
    cards,
    commitments: details.map((item) => ({
      source: item.source,
      direction: item.direction,
      description: item.description,
      amountCents: assertSafeMoney(item.amountCents, "compromisso"),
      originalDate: assertDate(item.originalDate, "compromisso"),
      allocationMonth: assertMonth(item.allocationMonth, "compromisso"),
      status: item.status,
      overdue: item.overdue,
      installment: item.installment ? { number: item.installment.number, count: item.installment.count } : null,
    })),
    projection: {
      basis: "known_cash_only",
      month: projection.month,
      openingBalanceCents: projection.openingBalanceCents,
      knownFutureIncomeCents: projection.knownFutureIncomeCents,
      expectedIncomeCents: projection.expectedIncomeCents,
      overdueExpectedIncomeCents: projection.overdueExpectedIncomeCents,
      futureTransactionExpenseCents: projection.futureTransactionExpenseCents,
      overdueBillsCents: projection.overdueBillsCents,
      dueBillsCents: projection.dueBillsCents,
      cardInvoiceRemainingCents: projection.cardInvoiceRemainingCents,
      knownOutflowCents: projection.knownOutflowCents,
      projectedNetCashFlowCents: projection.projectedNetCashFlowCents,
      closingBalanceCents: projection.closingBalanceCents,
    },
    warnings,
  };
}

export async function getChatGptFinancialSummary(
  context: ChatGptFinancialSummaryContext,
  requestedMonth?: string,
): Promise<ChatGptFinancialSummaryResponse> {
  const dto = await composeChatGptFinancialSummary(context, requestedMonth);
  return {
    month: dto.period.month,
    generatedAt: dto.period.generatedAt,
    asOfDate: dto.period.asOfDate,
    summaryText: formatChatGptFinancialSummary(dto),
    warnings: dto.warnings,
  };
}

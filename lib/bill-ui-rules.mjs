import { dateInTimeZone } from "./finance-analytics.mjs";

const BILL_DAY_MS = 86_400_000;

function civilDateTimestamp(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function billTodayInSaoPaulo(now = new Date()) {
  return dateInTimeZone(now, "America/Sao_Paulo");
}

export function billReferenceMonthInSaoPaulo(now = new Date()) {
  return billTodayInSaoPaulo(now).slice(0, 7);
}

export function billDayRefreshDelay(now = new Date()) {
  const startedAt = now.getTime();
  if (Number.isNaN(startedAt)) throw new Error("Instante inválido.");
  const today = billTodayInSaoPaulo(now);
  let lower = startedAt;
  let upper = startedAt + (36 * BILL_DAY_MS);
  while (billTodayInSaoPaulo(new Date(upper)) === today) upper += 12 * 60 * 60 * 1_000;
  while (upper - lower > 1_000) {
    const middle = Math.floor((lower + upper) / 2);
    if (billTodayInSaoPaulo(new Date(middle)) === today) lower = middle;
    else upper = middle;
  }
  return Math.max(1_000, upper - startedAt + 1_000);
}

export function billDueDayOffset(dueDate, today) {
  return Math.round((civilDateTimestamp(dueDate) - civilDateTimestamp(today)) / BILL_DAY_MS);
}

export function billTiming(bill, today) {
  if (bill.status === "paid" || bill.status === "cancelled") return bill.status;
  const offset = billDueDayOffset(bill.dueDate, today);
  if (offset < 0) return "overdue";
  if (offset === 0) return "today";
  return "upcoming";
}

export function billOpenAmountCents(bill) {
  return bill.amountCents;
}

export function globalOverdueBills(bills, today) {
  return bills.filter((bill) => billTiming(bill, today) === "overdue");
}

export function billsForSelectedMonthAndGlobalOverdue(bills, selectedMonth, today) {
  const relevant = new Map();
  for (const bill of globalOverdueBills(bills, today)) relevant.set(bill.id, bill);
  for (const bill of bills) {
    if (bill.dueDate.startsWith(selectedMonth)) relevant.set(bill.id, bill);
  }
  return [...relevant.values()];
}

export function billRelativeDueLabel(dueDate, today) {
  const offset = billDueDayOffset(dueDate, today);
  if (offset === 0) return "Hoje";
  if (offset === 1) return "Amanhã";
  if (offset < 0) {
    const days = Math.abs(offset);
    return `Atrasada há ${days} ${days === 1 ? "dia" : "dias"}`;
  }
  return `Vence em ${offset} dias`;
}

export function filterAndSortBills(bills, { today, status = "pending", search = "", accountId = "all", categoryId = "all" }) {
  const query = search.trim().toLocaleLowerCase("pt-BR");
  const rank = (bill) => {
    const timing = billTiming(bill, today);
    return timing === "overdue" ? 0 : timing === "today" ? 1 : timing === "upcoming" ? 2 : timing === "paid" ? 3 : 4;
  };
  return bills
    .filter((bill) => status === "all" || (status === "overdue" ? billTiming(bill, today) === "overdue" : bill.status === status))
    .filter((bill) => !query || bill.description.toLocaleLowerCase("pt-BR").includes(query))
    .filter((bill) => accountId === "all" || (accountId === "unassigned" ? !bill.accountId : bill.accountId === accountId))
    .filter((bill) => categoryId === "all" || bill.categoryId === categoryId)
    .sort((left, right) => rank(left) - rank(right)
      || left.dueDate.localeCompare(right.dueDate)
      || left.description.localeCompare(right.description, "pt-BR")
      || left.id.localeCompare(right.id));
}

export function paidBillAccountId(bill, dateView = "due") {
  return dateView === "payment" ? bill.payment?.accountId ?? null : bill.accountId ?? null;
}

export function paidBillsForSelectedMonth(bills, selectedMonth, dateView = "due") {
  const matches = new Map();
  for (const bill of bills) {
    if (bill.status !== "paid") continue;
    const referenceDate = dateView === "payment" ? bill.payment?.paidOn : bill.dueDate;
    if (referenceDate?.startsWith(selectedMonth)) matches.set(bill.id, bill);
  }
  return [...matches.values()];
}

export function filterAndSortPaidBills(bills, { selectedMonth, dateView = "due", search = "", accountId = "all", categoryId = "all" }) {
  const query = search.trim().toLocaleLowerCase("pt-BR");
  return paidBillsForSelectedMonth(bills, selectedMonth, dateView)
    .filter((bill) => !query || bill.description.toLocaleLowerCase("pt-BR").includes(query))
    .filter((bill) => accountId === "all" || (accountId === "unassigned" ? !paidBillAccountId(bill, dateView) : paidBillAccountId(bill, dateView) === accountId))
    .filter((bill) => categoryId === "all" || bill.categoryId === categoryId)
    .sort((left, right) => dateView === "payment"
      ? left.payment.paidOn.localeCompare(right.payment.paidOn)
        || left.dueDate.localeCompare(right.dueDate)
        || left.id.localeCompare(right.id)
      : left.dueDate.localeCompare(right.dueDate)
        || left.description.localeCompare(right.description, "pt-BR")
        || left.id.localeCompare(right.id));
}

export function summarizePendingBills(bills, today) {
  const summary = {
    overdue: { count: 0, valueCents: 0 },
    today: { count: 0, valueCents: 0 },
    upcoming: { count: 0, valueCents: 0 },
  };
  for (const bill of bills) {
    const timing = billTiming(bill, today);
    if (!(timing in summary)) continue;
    summary[timing].count += 1;
    summary[timing].valueCents += billOpenAmountCents(bill);
  }
  return summary;
}

export function activeBillCategories(categories) {
  return categories.filter((category) => category.isActive !== false && (category.type === "expense" || category.type === "both"));
}

export function activeBillSubcategories(categories, categoryId) {
  if (!categoryId) return [];
  const category = categories.find((item) => item.id === categoryId);
  return (category?.subcategories ?? []).filter((subcategory) => subcategory.isActive !== false);
}

export function changeBillCategory(classification, categoryId) {
  return { ...classification, categoryId: categoryId || null, subcategoryId: null };
}

export function billClassificationError(classification, categories) {
  if (!classification.categoryId) return "Selecione uma categoria para o vencimento.";
  const category = activeBillCategories(categories).find((item) => item.id === classification.categoryId);
  if (!category) return "Categoria inválida para o vencimento.";
  const subcategories = activeBillSubcategories(categories, category.id);
  if (subcategories.length > 0 && !classification.subcategoryId) return "Selecione uma subcategoria para o vencimento.";
  if (classification.subcategoryId && !subcategories.some((item) => item.id === classification.subcategoryId)) return "Subcategoria inválida para a categoria selecionada.";
  return null;
}

export function initialBillPaymentAccountId(bill, accounts) {
  if (!bill.accountId) return null;
  return accounts.some((account) => account.id === bill.accountId && account.isActive) ? bill.accountId : null;
}

export function normalizeBillAccountId(value) {
  return value && value !== "none" ? value : null;
}

export function recurringBillOccurrences(bills, seriesId) {
  if (!seriesId) return [];
  return bills.filter((bill) => bill.recurrenceSeriesId === seriesId).sort((left, right) => left.dueDate.localeCompare(right.dueDate));
}

/** @param {string | null} [fromDueDate] */
export function eligibleRecurringBillIds(bills, seriesId, fromDueDate = null) {
  return recurringBillOccurrences(bills, seriesId)
    .filter((bill) => bill.status === "pending" && (!fromDueDate || bill.dueDate >= fromDueDate))
    .map((bill) => bill.id);
}

export function normalizeRecurringBillSelection(selectedIds, eligibleIds) {
  const eligible = new Set(eligibleIds);
  return [...new Set(selectedIds)].filter((id) => eligible.has(id));
}

export function toggleRecurringBillSelection(selectedIds, id, checked, eligibleIds) {
  const next = checked ? [...selectedIds, id] : selectedIds.filter((selectedId) => selectedId !== id);
  return normalizeRecurringBillSelection(next, eligibleIds);
}

export function buildRecurringBillCalendarPayload({ scope, changeDueDate, changeRecurrenceEnd, dayOfMonth, endsOn }) {
  const payload = {
    changeDueDate: changeDueDate === true,
    changeRecurrenceEnd: scope === "future" && changeRecurrenceEnd === true,
  };
  if (payload.changeDueDate) {
    const day = Number(dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("Informe um dia de vencimento válido.");
    payload.dayOfMonth = day;
  }
  if (payload.changeRecurrenceEnd) payload.endsOn = endsOn || null;
  return payload;
}

/**
 * @param {{ billId: string; accountId: string | null; paidAmountCents: number; paidOn: string; expectedAmountCents: number; operationId: string; differenceTreatment?: "discount" | null }} input
 */
export function buildBillPaymentPayload({ billId, accountId, paidAmountCents, paidOn, expectedAmountCents, operationId, differenceTreatment = null }) {
  if (!accountId) throw new Error("Selecione a conta usada no pagamento.");
  if (!operationId) throw new Error("A identificação da operação é obrigatória.");
  return {
    action: "pay_bill",
    id: billId,
    accountId,
    paidAmountCents,
    paidOn,
    expectedAmountCents,
    operationId,
    differenceTreatment,
  };
}

export function billActions(status) {
  if (status === "pending") return ["pay", "edit", "cancel"];
  if (status === "paid") return ["undo"];
  return [];
}

export function friendlyBillPaymentError(code, fallback) {
  if (code === "BILL_CLASSIFICATION_REQUIRED") return "Antes de pagar este vencimento, informe a categoria e a subcategoria.";
  return fallback || "Não foi possível pagar o vencimento.";
}

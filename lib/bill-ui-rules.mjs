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

export function buildBillPaymentPayload(billId, accountId) {
  if (!accountId) throw new Error("Selecione a conta usada no pagamento.");
  return { action: "pay_bill", id: billId, accountId };
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

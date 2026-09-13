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

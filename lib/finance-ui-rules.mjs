export function activeSubcategories(categories, categoryId) {
  if (!categoryId) return [];
  const category = categories.find((item) => item.id === categoryId);
  return (category?.subcategories ?? []).filter((item) => item.isActive !== false);
}

export function changeTransactionCategory(current, categoryId) {
  return { ...current, categoryId: categoryId || null, subcategoryId: null };
}

export function changeTransactionType(current, type, categories) {
  const category = categories.find((item) => item.id === current.categoryId && item.isActive !== false);
  const compatible = category && (category.type === type || category.type === "both");
  if (!compatible) return { ...current, type, categoryId: null, subcategoryId: null };
  const validSubcategory = activeSubcategories(categories, category.id).some((item) => item.id === current.subcategoryId);
  return { ...current, type, subcategoryId: validSubcategory ? current.subcategoryId : null };
}

export function transactionClassificationError({ type, categoryId, subcategoryId }, categories) {
  if (type !== "expense") return null;
  if (!categoryId) return "Selecione uma categoria para a despesa.";
  const category = categories.find((item) => item.id === categoryId && item.isActive !== false && (item.type === "expense" || item.type === "both"));
  if (!category) return "Categoria inválida para esta despesa.";
  const subcategories = activeSubcategories(categories, categoryId);
  if (subcategories.length && !subcategoryId) return "Selecione uma subcategoria para esta despesa.";
  if (subcategoryId && !subcategories.some((item) => item.id === subcategoryId)) return "Subcategoria inválida para a categoria selecionada.";
  return null;
}

export function applyReportCategoryFilter(filters, categoryId, categories) {
  const keepsSubcategory = categories.find((item) => item.id === categoryId)?.subcategories.some((item) => item.id === filters.subcategoryId);
  return { ...filters, categoryId, subcategoryId: keepsSubcategory ? filters.subcategoryId : "" };
}

export function applyReportSubcategoryFilter(filters, subcategoryId, categories) {
  const category = categories.find((item) => item.subcategories.some((subcategory) => subcategory.id === subcategoryId));
  if (!category) return filters;
  return { ...filters, categoryId: category.id, subcategoryId };
}

export function reportMovementMode(item) {
  if (item.entityType === "card_installment" || item.paymentMethod === "conta_a_pagar") return "readonly";
  return "edit";
}

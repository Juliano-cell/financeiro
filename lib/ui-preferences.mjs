export const THEME_STORAGE_KEY = "ncf-theme";
export const FINANCIAL_VALUES_STORAGE_KEY = "ncf-financial-values";
export const FINANCIAL_VALUES_MASK = "R$ ••••••";

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const compactCurrency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 });

export function storedTheme(value) {
  return value === "dark" ? "dark" : "light";
}

export function nextTheme(value) {
  return storedTheme(value) === "dark" ? "light" : "dark";
}

export function storedFinancialValues(value) {
  return value === "hidden" ? "hidden" : "visible";
}

export function nextFinancialValues(value) {
  return storedFinancialValues(value) === "hidden" ? "visible" : "hidden";
}

export function financialValuesAreHidden() {
  if (typeof window === "undefined") return false;
  try {
    return storedFinancialValues(window.localStorage.getItem(FINANCIAL_VALUES_STORAGE_KEY)) === "hidden";
  } catch {
    return document.documentElement.dataset.financialValues === "hidden";
  }
}

export function formatFinancialCents(cents, options = {}) {
  if (!Number.isSafeInteger(cents)) return "Valor indisponível";
  const hidden = options.hidden ?? financialValuesAreHidden();
  if (hidden) return FINANCIAL_VALUES_MASK;
  return (options.compact ? compactCurrency : currency).format(cents / 100);
}

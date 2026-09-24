import { addMonths } from "./finance-rules.mjs";
import { assertExpectedIncomeCivilDate, assertExpectedIncomeConfiguredDay, expectedIncomeDateForMonth } from "./expected-income-rules.mjs";

export function expectedIncomeFilterMatch(item, filter) {
  if (filter === "all") return true;
  if (filter === "pending") return item.status === "pending" && item.timing !== "overdue";
  if (filter === "overdue") return item.status === "pending" && item.timing === "overdue";
  return item.status === filter;
}

export function expectedIncomeStatusLabel(item) {
  if (item.status === "received") return "Recebida";
  if (item.status === "cancelled") return "Cancelada";
  return item.timing === "overdue" ? "Atrasada" : "A receber";
}

export function expectedIncomeDifference(expectedAmountCents, receivedAmountCents) {
  if (!Number.isSafeInteger(expectedAmountCents) || !Number.isSafeInteger(receivedAmountCents)) return null;
  return receivedAmountCents - expectedAmountCents;
}

export function currencyInputToCents(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s/gu, "").replace(/^R\$/u, "").replace(/\./gu, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents >= 1 && cents <= 100_000_000_000 ? cents : null;
}

export function centsToCurrencyInput(cents) {
  if (!Number.isSafeInteger(cents)) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

export function normalizeExpectedIncomeSelectId(value) {
  if (value === undefined || value === null || value === "" || value === "none") return null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeExpectedIncomeClassification(categoryValue, subcategoryValue) {
  const categoryId = normalizeExpectedIncomeSelectId(categoryValue);
  if (!categoryId) return { categoryId: null, subcategoryId: null };
  return { categoryId, subcategoryId: normalizeExpectedIncomeSelectId(subcategoryValue) };
}

export function recurringExpectedIncomePreview(startsOn, configuredDay, endsOn = null, limit = 4) {
  assertExpectedIncomeCivilDate(startsOn, "Data inicial");
  assertExpectedIncomeConfiguredDay(configuredDay);
  if (endsOn) {
    assertExpectedIncomeCivilDate(endsOn, "Data final");
    if (endsOn < startsOn) throw new Error("A data final não pode ser anterior à data inicial.");
  }
  const startMonth = startsOn.slice(0, 7);
  const firstDate = expectedIncomeDateForMonth(startMonth, configuredDay);
  const effectiveStart = firstDate < startsOn ? expectedIncomeDateForMonth(addMonths(startMonth, 1), configuredDay) : firstDate;
  const dates = [];
  for (let offset = 0; dates.length < limit && offset < 24; offset += 1) {
    const date = expectedIncomeDateForMonth(addMonths(effectiveStart.slice(0, 7), offset), configuredDay);
    if (endsOn && date > endsOn) break;
    dates.push(date);
  }
  return dates;
}

export function recurringExpectedIncomeStartsOn(startsOn, configuredDay) {
  return recurringExpectedIncomePreview(startsOn, configuredDay, null, 1)[0];
}

export function mutationSemanticKey(action, payload) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
  };
  return JSON.stringify(stable({ action, payload }));
}

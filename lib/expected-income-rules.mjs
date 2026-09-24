import { addMonths, dateForDayOfMonth } from "./finance-rules.mjs";

export const MAX_EXPECTED_INCOME_CENTS = 100_000_000_000;
export const MAX_EXPECTED_INCOME_MATERIALIZATION_MONTHS = 24;

function requiredId(value, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) throw new Error(`${label} inválido.`);
  return value.trim();
}

function optionalId(value, label) {
  if (value === undefined || value === null) return null;
  return requiredId(value, label);
}

export function assertExpectedIncomeAmount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EXPECTED_INCOME_CENTS) throw new Error("Valor previsto inválido.");
  return value;
}

export function assertExpectedIncomeCivilDate(value, label = "Data") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value < "0001-01-01") throw new Error(`${label} inválida.`);
  const [year, month, day] = value.split("-").map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) throw new Error(`${label} inválida.`);
  return value;
}

export function assertExpectedIncomeMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value)) throw new Error("Mês inválido.");
  return value;
}

export function assertExpectedIncomeConfiguredDay(value) {
  if (!Number.isInteger(value) || value < 1 || value > 31) throw new Error("Dia configurado inválido.");
  return value;
}

export function expectedIncomeDateForMonth(month, configuredDay) {
  assertExpectedIncomeMonth(month);
  assertExpectedIncomeConfiguredDay(configuredDay);
  return dateForDayOfMonth(month, configuredDay);
}

export function normalizeExpectedIncomeFields(input) {
  const description = typeof input?.description === "string" ? input.description.trim() : "";
  if (!description || description.length > 120) throw new Error("Descrição inválida.");
  const notes = input?.notes === undefined || input.notes === null ? null : input.notes;
  if (typeof notes !== "string" && notes !== null) throw new Error("Observação inválida.");
  if (notes !== null && notes.length > 500) throw new Error("Observação inválida.");
  const categoryId = optionalId(input?.categoryId, "Categoria");
  const subcategoryId = optionalId(input?.subcategoryId, "Subcategoria");
  if (!categoryId && subcategoryId) throw new Error("A subcategoria exige uma categoria.");
  return {
    description,
    expectedAmountCents: assertExpectedIncomeAmount(input?.expectedAmountCents),
    plannedAccountId: optionalId(input?.plannedAccountId, "Conta planejada"),
    categoryId,
    subcategoryId,
    notes,
  };
}

function monthDistance(fromMonth, throughMonth) {
  const [fromYear, fromIndex] = fromMonth.split("-").map(Number);
  const [throughYear, throughIndex] = throughMonth.split("-").map(Number);
  return (throughYear - fromYear) * 12 + throughIndex - fromIndex;
}

export function buildExpectedIncomeMaterializationPlan(input) {
  const startsOn = assertExpectedIncomeCivilDate(input?.startsOn, "Data inicial");
  const configuredDay = assertExpectedIncomeConfiguredDay(input?.configuredDay);
  const startsMonth = startsOn.slice(0, 7);
  if (expectedIncomeDateForMonth(startsMonth, configuredDay) !== startsOn) throw new Error("A data inicial não corresponde ao dia configurado.");
  const endsOn = input?.endsOn === undefined || input.endsOn === null ? null : assertExpectedIncomeCivilDate(input.endsOn, "Data final");
  if (endsOn && endsOn < startsOn) throw new Error("A data final não pode ser anterior à data inicial.");
  const fromMonth = assertExpectedIncomeMonth(input?.fromMonth ?? startsMonth);
  const requestedThroughMonth = assertExpectedIncomeMonth(input?.throughMonth ?? addMonths(fromMonth, MAX_EXPECTED_INCOME_MATERIALIZATION_MONTHS - 1));
  const distance = monthDistance(fromMonth, requestedThroughMonth);
  if (distance < 0 || distance >= MAX_EXPECTED_INCOME_MATERIALIZATION_MONTHS) throw new Error("A materialização deve cobrir de 1 a 24 meses por operação.");
  const materializedThroughMonth = endsOn && endsOn.slice(0, 7) < requestedThroughMonth ? endsOn.slice(0, 7) : requestedThroughMonth;
  if (materializedThroughMonth < fromMonth) return { occurrences: [], materializedThroughMonth };
  const occurrences = [];
  const finalDistance = monthDistance(fromMonth, materializedThroughMonth);
  for (let index = 0; index <= finalDistance; index += 1) {
    const occurrenceMonth = addMonths(fromMonth, index);
    const expectedDate = expectedIncomeDateForMonth(occurrenceMonth, configuredDay);
    if (expectedDate < startsOn || (endsOn && expectedDate > endsOn)) continue;
    occurrences.push({ occurrenceMonth, expectedDate });
  }
  return { occurrences, materializedThroughMonth };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function canonicalExpectedIncomeRequest(operationType, payload) {
  if (typeof operationType !== "string" || !operationType) throw new Error("Tipo de operação inválido.");
  return JSON.stringify(stableValue({ operationType, payload }));
}

export async function expectedIncomeRequestFingerprint(operationType, payload) {
  const bytes = new TextEncoder().encode(canonicalExpectedIncomeRequest(operationType, payload));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function expectedIncomeTiming(status, expectedDate, today) {
  assertExpectedIncomeCivilDate(expectedDate, "Data prevista");
  assertExpectedIncomeCivilDate(today, "Data de hoje");
  if (status === "received" || status === "cancelled") return status;
  if (status !== "pending") throw new Error("Status inválido.");
  return expectedDate < today ? "overdue" : "pending";
}

export function normalizeExpectedIncomeOperationId(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new Error("Identificação da operação inválida.");
  return value.trim();
}

export function normalizeExpectedIncomeOccurrenceId(value) {
  return requiredId(value, "Receita prevista");
}

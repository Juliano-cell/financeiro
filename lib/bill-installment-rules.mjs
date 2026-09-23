import { addMonths, dateForDayOfMonth, splitInstallments } from "./finance-rules.mjs";

export const MIN_BILL_INSTALLMENTS = 2;
export const MAX_BILL_INSTALLMENTS = 120;
export const MAX_BILL_INSTALLMENT_TOTAL_CENTS = 100_000_000_000;

function requiredId(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw new Error(`${label} inválido.`);
  return value;
}

function optionalId(value, label) {
  if (value === undefined || value === null) return null;
  return requiredId(value, label);
}

export function assertBillInstallmentCivilDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value < "0001-01-01") throw new Error("Primeiro vencimento inválido.");
  const month = value.slice(0, 7);
  const day = Number(value.slice(8));
  let normalized;
  try { normalized = dateForDayOfMonth(month, day); } catch { throw new Error("Primeiro vencimento inválido."); }
  if (normalized !== value) throw new Error("Primeiro vencimento inválido.");
  return value;
}

export function normalizeBillInstallmentContract(input) {
  const description = typeof input?.description === "string" ? input.description.trim() : "";
  if (!description || description.length > 120) throw new Error("Descrição inválida.");
  if (!Number.isSafeInteger(input?.totalAmountCents) || input.totalAmountCents < 1 || input.totalAmountCents > MAX_BILL_INSTALLMENT_TOTAL_CENTS) throw new Error("Valor total inválido.");
  if (!Number.isInteger(input?.installmentCount) || input.installmentCount < MIN_BILL_INSTALLMENTS || input.installmentCount > MAX_BILL_INSTALLMENTS) throw new Error("Quantidade de parcelas inválida.");
  if (input.totalAmountCents < input.installmentCount) throw new Error("O valor total é insuficiente para a quantidade de parcelas.");
  const firstDueDate = assertBillInstallmentCivilDate(input.firstDueDate);
  const notes = input.notes === undefined || input.notes === null ? null : input.notes;
  if (typeof notes !== "string" && notes !== null) throw new Error("Observação inválida.");
  if (notes !== null && notes.length > 500) throw new Error("Observação inválida.");
  return {
    description,
    totalAmountCents: input.totalAmountCents,
    installmentCount: input.installmentCount,
    firstDueDate,
    categoryId: requiredId(input.categoryId, "Categoria"),
    subcategoryId: optionalId(input.subcategoryId, "Subcategoria"),
    accountId: optionalId(input.accountId, "Conta"),
    notes,
  };
}

export function buildBillInstallmentPlan(input) {
  const contract = normalizeBillInstallmentContract(input);
  const configuredDay = Number(contract.firstDueDate.slice(8));
  const firstMonth = contract.firstDueDate.slice(0, 7);
  const amounts = splitInstallments(contract.totalAmountCents, contract.installmentCount);
  const plan = amounts.map((amountCents, index) => ({
    installmentNumber: index + 1,
    installmentCount: contract.installmentCount,
    amountCents,
    dueDate: dateForDayOfMonth(addMonths(firstMonth, index), configuredDay),
  }));
  if (plan.reduce((sum, item) => sum + item.amountCents, 0) !== contract.totalAmountCents) throw new Error("O plano parcelado não preservou o valor total.");
  return plan;
}

// JSON with a fixed property order is the canonical serialization used by the
// idempotency fingerprint. Derived IDs and timestamps are intentionally absent.
export function canonicalBillInstallmentRequest(input) {
  const contract = normalizeBillInstallmentContract(input);
  return JSON.stringify({
    description: contract.description,
    totalAmountCents: contract.totalAmountCents,
    installmentCount: contract.installmentCount,
    firstDueDate: contract.firstDueDate,
    categoryId: contract.categoryId,
    subcategoryId: contract.subcategoryId,
    accountId: contract.accountId,
    notes: contract.notes,
  });
}

export async function billInstallmentRequestFingerprint(input) {
  const bytes = new TextEncoder().encode(canonicalBillInstallmentRequest(input));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

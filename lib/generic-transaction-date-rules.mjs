import { dateInTimeZone } from "./finance-analytics.mjs";

export const FUTURE_GENERIC_TRANSACTION_ERROR_CODE = "FUTURE_GENERIC_TRANSACTION_NOT_ALLOWED";

export function genericTransactionToday(now = new Date()) {
  return dateInTimeZone(now, "America/Sao_Paulo");
}

/**
 * @param {"income" | "expense"} type
 * @returns {"expected_income" | "bill"}
 */
export function genericTransactionPlanningTarget(type) {
  return type === "income" ? "expected_income" : "bill";
}

/**
 * @param {"income" | "expense"} type
 */
export function futureGenericTransactionMessage(type) {
  return type === "income"
    ? "Para planejar uma receita futura, use Entradas previstas."
    : "Para planejar uma despesa futura, use Contas.";
}

/**
 * @param {{ transactionDate: string, today: string, existingTransactionDate?: string | null }} input
 */
export function genericTransactionDateDecision({ transactionDate, today, existingTransactionDate = null }) {
  const isFuture = transactionDate > today;
  const isExistingFuture = existingTransactionDate !== null && existingTransactionDate > today;
  return {
    allowed: !isFuture || isExistingFuture,
    isFuture,
    isExistingFuture,
  };
}

/**
 * @param {{ type: "income" | "expense", transactionDate: string, today: string, existingTransactionDate?: string | null }} input
 */
export function futureGenericTransactionViolation({ type, transactionDate, today, existingTransactionDate = null }) {
  const decision = genericTransactionDateDecision({ transactionDate, today, existingTransactionDate });
  if (decision.allowed) return null;
  return {
    code: FUTURE_GENERIC_TRANSACTION_ERROR_CODE,
    message: futureGenericTransactionMessage(type),
    planningTarget: genericTransactionPlanningTarget(type),
  };
}

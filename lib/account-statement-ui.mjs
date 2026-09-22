import { formatFinancialCents } from "./ui-preferences.mjs";

const EVENT_PRESENTATION = {
  income: { label: "Entrada", direction: "credit" },
  expense: { label: "Despesa", direction: "debit" },
  invoice_payment: { label: "Pagamento de fatura", direction: "debit" },
  invoice_payment_reversal: { label: "Reversão de pagamento", direction: "credit" },
};

const PAYMENT_METHOD_LABELS = {
  cash: "Dinheiro",
  credit_card: "Cartão de crédito",
  debit: "Débito",
  debit_card: "Cartão de débito",
  pix: "Pix",
  transfer: "Transferência",
  bank_transfer: "Transferência",
  boleto: "Boleto",
  conta_a_pagar: "Conta a pagar",
};

export function formatStatementMoney(cents) {
  return formatFinancialCents(cents);
}

export function formatStatementDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value ?? "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "Data indisponível";
}

export function formatStatementReferenceMonth(value) {
  const match = /^(\d{4})-(\d{2})$/u.exec(value ?? "");
  return match ? `${match[2]}/${match[1]}` : null;
}

export function statementEventPresentation(eventType) {
  return EVENT_PRESENTATION[eventType] ?? { label: "Movimentação", direction: null };
}

export function statementPaymentMethodLabel(value) {
  if (!value) return null;
  return PAYMENT_METHOD_LABELS[value] ?? value;
}

export function validateStatementCustomPeriod({ period, from, to, today }) {
  if (period !== "custom") return null;
  if (!from || !to) return "Informe as datas inicial e final.";
  if (from > to) return "A data final deve ser igual ou posterior à data inicial.";
  if (to > today) return "O período do extrato não pode incluir datas futuras.";
  return null;
}

/**
 * @param {{ accountId: string, period: string, from: string, to: string, eventType: string, cursor?: string | null, limit?: number }} input
 */
export function buildAccountStatementQuery({ accountId, period, from, to, eventType, cursor = null, limit = 50 }) {
  const query = new URLSearchParams({ accountId, period, eventType, limit: String(limit) });
  if (period === "custom") {
    query.set("from", from);
    query.set("to", to);
  }
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export function mergeStatementItems(current, incoming) {
  const ids = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !ids.has(item.id))];
}

export function statementEmptyMessage(eventType, summary) {
  const hasPeriodMovements = summary.periodCreditsCents !== 0 || summary.periodDebitsCents !== 0;
  if (eventType !== "all" && hasPeriodMovements) return "Nenhuma movimentação deste tipo no período selecionado.";
  return "Nenhuma movimentação neste período.";
}

export function statementErrorMessage(status) {
  if (status === 400) return "Os filtros do extrato são inválidos. Revise o período e tente novamente.";
  if (status === 401) return "Sua sessão expirou. Entre novamente para consultar o extrato.";
  if (status === 403) return "Você não tem acesso a esta conta.";
  if (status === 404) return "A conta não foi encontrada ou não está mais disponível.";
  if (status === 409) return "Os dados desta conta precisam ser revisados antes de exibir o extrato.";
  return "Não foi possível carregar o extrato. Tente novamente.";
}

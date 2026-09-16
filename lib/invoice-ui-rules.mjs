export const paymentStatusLabel = (status) => ({ unpaid: "Em aberto", partial: "Parcialmente paga", settled: "Quitada" })[status] ?? "Situação não identificada";
export const cycleStatusLabel = (status) => ({ open: "Ciclo aberto", closed: "Ciclo fechado", unknown: "Ciclo não identificado" })[status] ?? "Ciclo não identificado";

// FinanceApp owns this ordering domain; only a complete current refresh publishes a generation.
export function createFinancialRefreshController(notify = () => {}) {
  let order = 0;
  let live = false;
  let generation = 0;
  const locks = new Map();
  return {
    get generation() { return generation; },
    mount() { live = true; },
    unmount() { live = false; order++; },
    isLocked(invoiceId) { return locks.has(invoiceId); },
    attempt(invoiceId) { const lock = locks.get(invoiceId); return lock && !lock.inFlight ? lock.payload : null; },
    presentation(invoiceId) { return locks.get(invoiceId)?.presentation ?? null; },
    start(invoiceId, payload, presentation) {
      const lock = locks.get(invoiceId);
      if (lock?.inFlight) throw new Error("Esta operação ainda está em andamento.");
      if (lock && lock.payload?.operationId !== payload.operationId) throw new Error("Aguarde os dados atualizados da fatura.");
      locks.set(invoiceId, { after: ++order, pending: true, inFlight: true, payload, presentation: presentation ?? lock?.presentation });
      if (live) notify();
    },
    uncertain(invoiceId) { const lock = locks.get(invoiceId); if (lock) lock.inFlight = false; if (live) notify(); },
    settle(invoiceId) {
      locks.set(invoiceId, { after: ++order, pending: false, payload: null });
      if (live) notify();
    },
    reject(invoiceId) { locks.delete(invoiceId); order++; if (live) notify(); },
    async read(read, apply, onError) {
      const startedAt = ++order;
      try {
        const value = await read();
        if (!live || startedAt !== order) return false;
        apply(value);
        return true;
      } catch (error) { if (live && startedAt === order && error?.name !== "AbortError") onError(error); return false; }
    },
    async refresh(readMain, readAdvanced, apply, onError) {
      const startedAt = ++order;
      try {
        const [main, advanced] = await Promise.all([readMain(), readAdvanced()]);
        if (!live || startedAt !== order) return { success: false };
        apply(main, advanced);
        generation++;
        for (const [id, lock] of locks) if (!lock.pending && startedAt > lock.after) locks.delete(id);
        notify();
        return { success: true, generation, startedAt };
      } catch (error) {
        if (live && startedAt === order && error?.name !== "AbortError") onError(error);
        return { success: false };
      }
    },
  };
}

export function invoiceToday(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function buildInvoicePayment(invoice, accountId, accounts, paidAt, operationId = crypto.randomUUID()) {
  if (!accounts.some((account) => account.id === accountId && account.isActive)) throw new Error("Selecione uma conta ativa para pagar a fatura.");
  if (!Number.isSafeInteger(invoice.remainingCents) || invoice.remainingCents < 0) throw new Error("Atualize os dados da fatura.");
  return { action: "pay_invoice", invoiceId: invoice.id, accountId, paidAt, operationId, expectedRemainingCents: invoice.remainingCents };
}

export function buildInvoiceReversal(paymentId, reversedAt, operationId = crypto.randomUUID()) {
  return { action: "reverse_invoice_payment", paymentId, reversedAt, operationId };
}

// Whitelist presentation fields; payment operations are already represented by payments.
export function invoiceHistoryEvents(history, accounts) {
  const reversals = history.operations.filter((operation) => operation.kind === "reversal");
  const accountName = (id) => accounts.find((account) => account.id === id)?.name ?? "Conta histórica";
  return [
    ...history.payments.map((payment) => ({ key: `payment:${payment.id}`, paymentId: payment.id, label: "Pagamento", date: payment.paidAt.slice(0, 10), amountCents: payment.amountCents, accountName: accountName(payment.accountId), canReverse: !reversals.some((operation) => operation.reversedPaymentId === payment.id) })),
    ...reversals.map((operation) => ({ key: `reversal:${operation.id}`, paymentId: null, label: "Reversão de pagamento", date: operation.occurredOn.slice(0, 10), amountCents: operation.amountCents, accountName: accountName(operation.accountId), canReverse: false })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

export function invoiceErrorMessage(status, fallback) {
  return ({ 400: "Confira a conta e a data informadas.", 401: "Sua sessão expirou. Entre novamente.", 403: "Você não tem permissão para esta operação.", 404: "Fatura ou pagamento não encontrado. Atualize os dados.", 409: "A fatura foi atualizada. Confira o novo valor restante antes de confirmar o pagamento." })[status] ?? (status >= 500 || !status ? "Não foi possível confirmar o resultado. Tente novamente a mesma operação antes de iniciar outra." : fallback ?? "Não foi possível concluir a operação.");
}

// No automatic retry: callers keep the exact payload for an uncertain technical retry.
export async function submitInvoiceOperation(payload, { api, refresh, onSuccess, onConflict }) {
  let result;
  try { result = await api(payload); }
  catch (error) {
    if (error.status === 409) { await onConflict(); await refresh(); }
    throw error;
  }
  if (!["paid", "already_settled", "reversed"].includes(result?.outcome)) throw new Error("Resposta de operação não reconhecida. Confira o resultado antes de iniciar outra operação.");
  await onSuccess(result.outcome);
  await refresh();
  return result;
}

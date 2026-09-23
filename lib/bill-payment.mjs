export const MAX_BILL_PAYMENT_CENTS = 100_000_000_000;

export function billPaymentAdjustment(originalAmountCents, paidAmountCents) {
  if (!Number.isSafeInteger(originalAmountCents) || originalAmountCents < 1) throw new Error("Valor previsto inválido.");
  if (!Number.isSafeInteger(paidAmountCents) || paidAmountCents < 1 || paidAmountCents > MAX_BILL_PAYMENT_CENTS) throw new Error("Valor pago inválido.");
  const adjustmentAmountCents = paidAmountCents - originalAmountCents;
  return {
    adjustmentAmountCents,
    adjustmentType: adjustmentAmountCents === 0 ? "normal" : adjustmentAmountCents > 0 ? "surcharge" : "discount",
  };
}

export function parseBillPaymentCents(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error("Informe o valor pago.");
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/u.test(normalized)) throw new Error("Informe um valor válido com no máximo duas casas decimais.");
  const [wholeText, fractionText = ""] = normalized.replace(/\./gu, "").split(",");
  const wholeCents = Number(wholeText) * 100;
  const fractionCents = Number(fractionText.padEnd(2, "0"));
  const cents = wholeCents + fractionCents;
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_BILL_PAYMENT_CENTS) throw new Error("O valor pago está fora do limite permitido.");
  return cents;
}

export function formatBillPaymentInput(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) return "";
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${whole},${fraction}`;
}

const MAX_MONEY_CENTS = 100_000_000_000;
export const MAX_ONBOARDING_COMMITMENTS = 50;

export function parseBrlCents(source, { allowZero = false } = {}) {
  if (typeof source !== "string") return null;
  let value = source.trim();
  const currencyPrefix = /^R\$(?:[ \u00a0]*)/iu.exec(value);
  if (currencyPrefix) value = value.slice(currencyPrefix[0].length);
  if (/[\s\u00a0]/u.test(value)) return null;
  if (!value || /[^0-9.,]/u.test(value)) return null;

  let integerPart;
  let decimalPart = "";
  if (value.includes(",")) {
    if ((value.match(/,/gu) ?? []).length !== 1) return null;
    [integerPart, decimalPart] = value.split(",");
    if (!/^\d{1,2}$/u.test(decimalPart)) return null;
    if (value.includes(".") && !/^\d{1,3}(?:\.\d{3})+$/u.test(integerPart)) return null;
    integerPart = integerPart.replace(/\./gu, "");
  } else if (value.includes(".")) {
    if (/^\d{1,3}(?:\.\d{3})+$/u.test(value)) integerPart = value.replace(/\./gu, "");
    else {
      if ((value.match(/\./gu) ?? []).length !== 1) return null;
      [integerPart, decimalPart] = value.split(".");
    }
  } else integerPart = value;

  if (!/^\d+$/u.test(integerPart) || !/^\d{0,2}$/u.test(decimalPart)) return null;
  const normalized = `${integerPart}${decimalPart.padEnd(2, "0")}`.replace(/^0+(?=\d)/u, "");
  const cents = BigInt(normalized || "0");
  if (cents > BigInt(MAX_MONEY_CENTS) || cents < BigInt(allowZero ? 0 : 1)) return null;
  return Number(cents);
}

function validIdentifier(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 100;
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates the canonical successful response returned by the onboarding API.
 * No coercion is allowed: an ambiguous 2xx response must remain retryable.
 */
export function parseOnboardingSuccessResponse(value, expectedCardId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value;
  if (!validIdentifier(response.cardId) || response.cardId !== expectedCardId) return null;
  if (!validIdentifier(response.batchId) || !validIdentifier(response.invoiceId)) return null;
  if (typeof response.referenceMonth !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(response.referenceMonth)) return null;
  if (!Number.isSafeInteger(response.declaredCurrentInvoiceTotalCents)
    || response.declaredCurrentInvoiceTotalCents < 0
    || response.declaredCurrentInvoiceTotalCents > MAX_MONEY_CENTS) return null;
  if (!Number.isSafeInteger(response.openingBalanceCents)
    || response.openingBalanceCents < 0
    || response.openingBalanceCents > response.declaredCurrentInvoiceTotalCents) return null;
  if (!validCount(response.importedPurchaseCount) || response.importedPurchaseCount > MAX_ONBOARDING_COMMITMENTS) return null;
  if (!validCount(response.importedInstallmentCount) || response.importedInstallmentCount > 120 || response.importedInstallmentCount < response.importedPurchaseCount) return null;
  if (response.status !== "completed" || typeof response.replayed !== "boolean") return null;
  return {
    cardId: response.cardId,
    batchId: response.batchId,
    invoiceId: response.invoiceId,
    referenceMonth: response.referenceMonth,
    declaredCurrentInvoiceTotalCents: response.declaredCurrentInvoiceTotalCents,
    openingBalanceCents: response.openingBalanceCents,
    importedPurchaseCount: response.importedPurchaseCount,
    importedInstallmentCount: response.importedInstallmentCount,
    status: response.status,
    replayed: response.replayed,
  };
}

export function canAddOnboardingCommitment(count) {
  return Number.isInteger(count) && count >= 0 && count < MAX_ONBOARDING_COMMITMENTS;
}

export function addReferenceMonth(month, amount) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month) || !Number.isInteger(amount)) return null;
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function saoPauloReferenceMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : null;
}

export function referenceMonthOptions(now = new Date()) {
  const current = saoPauloReferenceMonth(now);
  if (!current) return [];
  const next = addReferenceMonth(current, 1);
  if (!next) return [];
  return [current, next].map((value) => ({
    value,
    label: new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T00:00:00Z`)),
  }));
}

export function validateInstallmentDraft(value) {
  const errors = {};
  const originalTotalCents = parseBrlCents(value.originalTotal);
  const installmentAmountCents = parseBrlCents(value.installmentAmount);
  const originalInstallmentCount = Number(value.originalInstallmentCount);
  const currentInstallmentNumber = Number(value.currentInstallmentNumber);
  if (!String(value.description ?? "").trim()) errors.description = "Informe a descrição.";
  if (originalTotalCents === null) errors.originalTotal = "Informe um valor original válido.";
  if (!Number.isInteger(originalInstallmentCount) || originalInstallmentCount < 1 || originalInstallmentCount > 120) errors.originalInstallmentCount = "Informe de 1 a 120 parcelas.";
  if (!Number.isInteger(currentInstallmentNumber) || currentInstallmentNumber < 1 || currentInstallmentNumber > originalInstallmentCount) errors.currentInstallmentNumber = "A parcela atual deve estar entre 1 e o total.";
  if (installmentAmountCents === null) errors.installmentAmount = "Informe um valor de parcela válido.";
  if (value.originalPurchaseDate && !/^\d{4}-\d{2}-\d{2}$/u.test(value.originalPurchaseDate)) errors.originalPurchaseDate = "Informe uma data válida.";
  if (String(value.notes ?? "").trim().length > 500) errors.notes = "A observação deve ter até 500 caracteres.";
  return { valid: Object.keys(errors).length === 0, errors, originalTotalCents, installmentAmountCents, originalInstallmentCount, currentInstallmentNumber };
}

export function buildOnboardingPayload(draft) {
  const declaredCurrentInvoiceTotalCents = parseBrlCents(draft.invoiceTotal, { allowZero: true });
  if (declaredCurrentInvoiceTotalCents === null) return { valid: false, error: "Informe o total atual da fatura." };
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(draft.referenceMonth)) return { valid: false, error: "Selecione uma competência válida." };
  const existingInstallments = [];
  if (draft.hasInstallments) {
    if (!draft.installments.length) return { valid: false, error: "Adicione ao menos um parcelamento." };
    if (draft.installments.length > MAX_ONBOARDING_COMMITMENTS) return { valid: false, error: `Adicione no máximo ${MAX_ONBOARDING_COMMITMENTS} parcelamentos.` };
    for (const installment of draft.installments) {
      const parsed = validateInstallmentDraft(installment);
      if (!parsed.valid) return { valid: false, error: "Revise os dados dos parcelamentos.", installmentId: installment.id, fieldErrors: parsed.errors };
      existingInstallments.push({
        description: installment.description.trim(),
        originalTotalCents: parsed.originalTotalCents,
        originalInstallmentCount: parsed.originalInstallmentCount,
        currentInstallmentNumber: parsed.currentInstallmentNumber,
        installmentAmountCents: parsed.installmentAmountCents,
        originalPurchaseDate: installment.originalPurchaseDate || null,
        categoryId: installment.categoryId || null,
        subcategoryId: installment.subcategoryId || null,
        notes: installment.notes?.trim() || null,
      });
    }
  }
  const currentInstallmentsCents = existingInstallments.reduce((sum, item) => sum + item.installmentAmountCents, 0);
  return {
    valid: true,
    payload: { cardId: draft.cardId, referenceMonth: draft.referenceMonth, declaredCurrentInvoiceTotalCents, existingInstallments },
    preview: { declaredCurrentInvoiceTotalCents, currentInstallmentsCents, openingBalanceCents: declaredCurrentInvoiceTotalCents - currentInstallmentsCents },
  };
}

export function nextOriginalInstallments(current, total) {
  if (!Number.isInteger(current) || !Number.isInteger(total) || current < 1 || current > total) return [];
  return Array.from({ length: total - current }, (_, index) => current + index + 1);
}

/**
 * @param {{ physicalNumber: number, physicalCount: number, origin: "web" | "telegram" | "system", metadataValid?: boolean, firstOriginalNumber?: number | null, originalCount?: number | null }} input
 * @returns {{ installmentNumber: number, installmentCount: number } | null}
 */
export function resolveInstallmentDisplay({ physicalNumber, physicalCount, origin, metadataValid = false, firstOriginalNumber = null, originalCount = null }) {
  if (!Number.isInteger(physicalNumber) || !Number.isInteger(physicalCount) || physicalNumber < 1 || physicalNumber > physicalCount) return null;
  const hasMetadata = firstOriginalNumber !== null || originalCount !== null;
  if (origin === "web" || origin === "telegram") {
    return hasMetadata ? null : { installmentNumber: physicalNumber, installmentCount: physicalCount };
  }
  if (origin !== "system" || !metadataValid || !hasMetadata) return null;
  if (!Number.isInteger(firstOriginalNumber) || !Number.isInteger(originalCount) || firstOriginalNumber < 1 || firstOriginalNumber > originalCount) return null;
  if (physicalCount !== originalCount - firstOriginalNumber + 1) return null;
  const installmentNumber = Number(firstOriginalNumber) + physicalNumber - 1;
  if (installmentNumber > Number(originalCount)) return null;
  return { installmentNumber, installmentCount: Number(originalCount) };
}

export function financialPayloadFingerprint(payload) {
  return JSON.stringify(payload);
}

export function createOnboardingAttemptManager(createKey = () => crypto.randomUUID()) {
  let attempt = null;
  return {
    prepare(payload) {
      const fingerprint = financialPayloadFingerprint(payload);
      if (attempt?.ambiguous && attempt.fingerprint !== fingerprint) return { kind: "requires_revalidation" };
      if (!attempt || attempt.fingerprint !== fingerprint) attempt = { fingerprint, key: createKey(), ambiguous: false };
      return { kind: "ready", key: attempt.key };
    },
    keyFor(payload) {
      const prepared = this.prepare(payload);
      return prepared.kind === "ready" ? prepared.key : null;
    },
    markAmbiguous(payload, key) {
      const fingerprint = financialPayloadFingerprint(payload);
      if (attempt?.fingerprint === fingerprint && attempt.key === key) attempt.ambiguous = true;
    },
    clearPrepared() {
      if (!attempt?.ambiguous) attempt = null;
    },
    resolve() { attempt = null; },
    inspect() { return attempt ? { ...attempt } : null; },
  };
}

export function createOnboardingAttemptRegistry(createKey = () => crypto.randomUUID()) {
  const managers = new Map();
  return {
    forCard(cardId) {
      if (!managers.has(cardId)) managers.set(cardId, createOnboardingAttemptManager(createKey));
      return managers.get(cardId);
    },
  };
}

export function friendlyOnboardingError(status, fallback) {
  if (status === 400) return fallback || "Revise os dados informados.";
  if (status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (status === 403) return "Você não tem permissão para configurar este cartão.";
  if (status === 404) return "Este cartão não está mais disponível.";
  if (status === 409) return fallback || "O cartão mudou ou já foi configurado. Atualize os dados e tente novamente.";
  return "Não foi possível configurar o cartão agora. Tente novamente.";
}

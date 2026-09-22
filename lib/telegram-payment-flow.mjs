import { addMonths, dateForDayOfMonth, splitInstallments } from "./finance-rules.mjs";

export const TELEGRAM_PAYMENT_FLOWS = ["immediate", "future_bill", "credit_card", "direct_installments"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH_NAMES = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function normalize(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("pt-BR").replace(/\s+/gu, " ").trim();
}

export function isValidTelegramDate(value) {
  if (!ISO_DATE.test(String(value ?? ""))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateForMonthAndDay(month, desiredDay) {
  return dateForDayOfMonth(month, desiredDay);
}

function nextOccurrenceForDay(purchaseDate, desiredDay, strict) {
  const currentMonth = purchaseDate.slice(0, 7);
  if (!strict) {
    const currentCandidate = dateForMonthAndDay(currentMonth, desiredDay);
    return currentCandidate > purchaseDate ? currentCandidate : dateForMonthAndDay(addMonths(currentMonth, 1), desiredDay);
  }
  for (let offset = 0; offset <= 24; offset += 1) {
    const month = addMonths(currentMonth, offset);
    const candidate = calendarDate(Number(month.slice(0, 4)), Number(month.slice(5, 7)), desiredDay);
    if (candidate && candidate >= purchaseDate) return candidate;
  }
  return null;
}

function calendarDate(year, month, day) {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isValidTelegramDate(value) ? value : null;
}

function nextCalendarDay(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function namedTargetMonth(normalized, purchaseDate) {
  const match = normalized.match(new RegExp(`\\b(${Object.keys(MONTH_NAMES).join("|")})\\b`, "u"));
  if (!match) return null;
  const month = MONTH_NAMES[match[1]];
  const purchaseYear = Number(purchaseDate.slice(0, 4));
  const purchaseMonth = Number(purchaseDate.slice(5, 7));
  const year = month < purchaseMonth ? purchaseYear + 1 : purchaseYear;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function explicitTargetMonth(normalized, purchaseDate) {
  if (/\bmes que vem\b/u.test(normalized)) return addMonths(purchaseDate.slice(0, 7), 1);
  return namedTargetMonth(normalized, purchaseDate);
}

/**
 * @param {string | null | undefined} preferredMonth
 * @param {boolean} strictMonthDay
 */
export function resolveTelegramDueDate(text, purchaseDate, preferredMonth = null, strictMonthDay = true) {
  if (!isValidTelegramDate(purchaseDate)) return { status: "invalid", date: null, desiredDay: null };
  const raw = String(text ?? "").trim();
  const normalized = normalize(raw);
  const futureSignal = /\b(vou pagar|pago|pagar depois|fic(?:a|ou) para|vence|vencimento|mes que vem)\b/u.test(normalized);

  if (/\bamanha\b/u.test(normalized) && futureSignal) {
    const date = nextCalendarDay(purchaseDate);
    return { status: "resolved", date, desiredDay: Number(date.slice(8)) };
  }

  const isoMatch = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/u);
  if (isoMatch) {
    const date = isoMatch[1];
    if (!isValidTelegramDate(date) || date < purchaseDate) return { status: "invalid", date: null, desiredDay: null };
    return { status: "resolved", date, desiredDay: Number(date.slice(8)) };
  }

  const brazilianMatch = raw.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/u);
  if (brazilianMatch) {
    const day = Number(brazilianMatch[1]);
    const month = Number(brazilianMatch[2]);
    const purchaseYear = Number(purchaseDate.slice(0, 4));
    if (brazilianMatch[3]) {
      const date = calendarDate(Number(brazilianMatch[3]), month, day);
      if (!date || date < purchaseDate) return { status: "invalid", date: null, desiredDay: null };
      return { status: "resolved", date, desiredDay: day };
    }
    for (let year = purchaseYear; year <= purchaseYear + 8; year += 1) {
      const date = calendarDate(year, month, day);
      if (date && date >= purchaseDate) return { status: "resolved", date, desiredDay: day };
    }
    return { status: "invalid", date: null, desiredDay: null };
  }

  const dayMatch = normalized.match(/\bdia\s+(\d{1,2})\b/u);
  if (dayMatch) {
    const desiredDay = Number(dayMatch[1]);
    if (desiredDay < 1 || desiredDay > 31) return { status: "invalid", date: null, desiredDay: null };
    const month = explicitTargetMonth(normalized, purchaseDate) ?? (/^\d{4}-\d{2}$/u.test(String(preferredMonth ?? "")) ? preferredMonth : null);
    const date = month
      ? strictMonthDay ? calendarDate(Number(month.slice(0, 4)), Number(month.slice(5, 7)), desiredDay) : dateForMonthAndDay(month, desiredDay)
      : nextOccurrenceForDay(purchaseDate, desiredDay, strictMonthDay);
    if (!date || date < purchaseDate) return { status: "invalid", date: null, desiredDay: null };
    return { status: "resolved", date, desiredDay };
  }

  const targetMonth = explicitTargetMonth(normalized, purchaseDate);
  if (targetMonth) return { status: "incomplete", date: null, desiredDay: null, targetMonth };
  if (futureSignal) return { status: "incomplete", date: null, desiredDay: null };
  return { status: "absent", date: null, desiredDay: null };
}

export function parseTelegramInstallmentInput(value) {
  const normalized = normalize(value);
  const matches = [...normalized.matchAll(/(?<![\p{L}\p{N}])([+−-]?\s*[\d.,][\d.,/e+−-]*)\s*(?:x\b|parcelas?\b)/gu)];
  const bare = normalized.match(/^([+−-]?\s*[\d.,][\d.,/e+−-]*)$/u);
  if (!matches.length && !bare) return { status: "absent", count: null };
  const tokens = (matches.length ? matches : [bare]).map((match) => match[1].replace(/\s/gu, ""));
  if (tokens.some((token) => !/^\+?\d+$/u.test(token))) return { status: "invalid", count: null };
  const counts = tokens.map(Number);
  if (counts.some((count) => !Number.isInteger(count) || count < 1 || count > 120 || count !== counts[0])) return { status: "invalid", count: null };
  return { status: "valid", count: counts[0] };
}

export function parseTelegramInstallmentCount(value) {
  return parseTelegramInstallmentInput(value).count;
}

export function buildTelegramInstallmentPreview({ totalCents, count, firstDueDate, desiredDay }) {
  if (!isValidTelegramDate(firstDueDate)) throw new Error("Primeiro vencimento inválido.");
  if (!Number.isSafeInteger(totalCents) || !Number.isInteger(count) || count < 1 || count > 120 || count > totalCents) throw new Error("Parcelamento inválido.");
  const amounts = splitInstallments(totalCents, count);
  const day = Number.isInteger(desiredDay) && desiredDay >= 1 && desiredDay <= 31 ? desiredDay : Number(firstDueDate.slice(8));
  const firstMonth = firstDueDate.slice(0, 7);
  return amounts.map((amountCents, index) => ({
    installmentNumber: index + 1,
    installmentCount: count,
    amountCents,
    dueDate: index === 0 ? firstDueDate : dateForMonthAndDay(addMonths(firstMonth, index), day),
  }));
}

export function transitionTelegramPaymentFlow(intent, paymentFlow) {
  if (!TELEGRAM_PAYMENT_FLOWS.includes(paymentFlow)) throw new Error("Forma de pagamento inválida.");
  const next = { ...intent, paymentFlow };
  // Estados antigos sem status continuam sem default implícito; estados novos são coerentes.
  if (next.installmentInputStatus !== undefined) {
    if (next.installmentInputStatus === "invalid" || (next.installmentInputStatus === "valid" && next.installmentCount == null)
      || (next.installmentCount != null && (!Number.isInteger(next.installmentCount) || next.installmentCount < 1 || next.installmentCount > 120))) {
      next.installmentCount = null;
      next.installmentInputStatus = "invalid";
    } else if (next.installmentCount != null) next.installmentInputStatus = "valid";
  }
  if (intent.paymentFlow !== paymentFlow) next.legacyCardCompatible = false;
  if (paymentFlow === "immediate") {
    next.cardId = null;
    next.dueDate = null;
    next.dueMonth = null;
    next.installmentCount = null;
    next.installmentInputStatus = next.installmentInputStatus === "invalid" ? "invalid" : "absent";
    next.firstDueDate = null;
    next.installmentDayOfMonth = null;
  } else if (paymentFlow === "future_bill") {
    next.cardId = null;
    next.accountId = null;
    next.paymentMethod = null;
    next.installmentCount = null;
    next.installmentInputStatus = next.installmentInputStatus === "invalid" ? "invalid" : "absent";
    next.firstDueDate = null;
    next.installmentDayOfMonth = null;
  } else if (paymentFlow === "credit_card") {
    next.accountId = null;
    next.paymentMethod = null;
    next.dueDate = null;
    next.dueMonth = null;
    next.firstDueDate = null;
    next.installmentDayOfMonth = null;
  } else {
    next.cardId = null;
    next.accountId = null;
    next.paymentMethod = null;
    next.dueDate = null;
    next.dueMonth = null;
  }
  return next;
}

export function effectiveTelegramPaymentFlow(intent) {
  if (TELEGRAM_PAYMENT_FLOWS.includes(intent?.paymentFlow)) return intent.paymentFlow;
  if (intent?.paymentFlow === null) return null;
  return intent?.cardId ? "credit_card" : "immediate";
}

export function isCompleteTelegramCardIntent(intent) {
  return effectiveTelegramPaymentFlow(intent) === "credit_card"
    && intent?.type === "expense"
    && typeof intent?.description === "string" && intent.description.trim().length > 0 && intent.description.trim().length <= 120
    && Number.isSafeInteger(intent?.amountCents) && intent.amountCents > 0
    && isValidTelegramDate(intent?.purchaseDate)
    && Boolean(intent?.cardId) && Boolean(intent?.categoryId)
    && intent?.installmentInputStatus !== "invalid"
    && Number.isInteger(intent?.installmentCount) && intent.installmentCount >= 1 && intent.installmentCount <= 120 && intent.installmentCount <= intent.amountCents
    && !intent?.missing?.length
    && intent?.accountId == null && intent?.dueDate == null;
}

export function telegramFinancialPersistenceTarget(intent) {
  if (isCompleteTelegramCardIntent(intent)) return "card_purchase";
  const flow = effectiveTelegramPaymentFlow(intent);
  if (flow === "future_bill") return "bill";
  return flow === "immediate" ? "transaction" : null;
}

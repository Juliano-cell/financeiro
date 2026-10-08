const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SAO_PAULO_TIMEZONE = "America/Sao_Paulo";

function monthParts(value) {
  const match = MONTH_PATTERN.exec(value);
  if (!match) throw new Error("Competência inválida.");
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function addSummaryMonths(value, offset) {
  const { year, month } = monthParts(value);
  if (!Number.isSafeInteger(offset)) throw new Error("Deslocamento de competência inválido.");
  const absolute = year * 12 + month - 1 + offset;
  const nextYear = Math.floor(absolute / 12);
  const nextMonth = absolute - nextYear * 12 + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`;
}

export function currentSummaryMonthInSaoPaulo(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("Data inválida.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SAO_PAULO_TIMEZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Não foi possível determinar a competência atual.");
  return `${year}-${month}`;
}

export function summaryMonthOptions(now = new Date()) {
  const current = currentSummaryMonthInSaoPaulo(now);
  return Array.from({ length: 24 }, (_, index) => {
    const value = addSummaryMonths(current, index);
    return { value, label: summaryMonthLabel(value) };
  });
}

export function summaryMonthLabel(value) {
  const { year, month } = monthParts(value);
  return new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1, 12)));
}

export function summaryDateLabel(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return "Data indisponível";
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export function summaryTimestampLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Horário indisponível";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: SAO_PAULO_TIMEZONE,
  }).format(date);
}

export function uniqueSummaryWarnings(warnings) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const identity = `${warning.code}\u0000${warning.message}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function parseSummaryResponse(value, requestedMonth) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resposta inválida.");
  const response = value;
  if (response.month !== requestedMonth || !MONTH_PATTERN.test(response.month)) throw new Error("Competência divergente.");
  if (typeof response.generatedAt !== "string" || Number.isNaN(new Date(response.generatedAt).getTime())) throw new Error("Resposta inválida.");
  if (typeof response.asOfDate !== "string" || !DATE_PATTERN.test(response.asOfDate)) throw new Error("Resposta inválida.");
  if (typeof response.summaryText !== "string" || !Array.isArray(response.warnings)) throw new Error("Resposta inválida.");
  if (response.warnings.some((warning) => !warning || typeof warning !== "object" || typeof warning.code !== "string" || typeof warning.message !== "string")) {
    throw new Error("Resposta inválida.");
  }
  return {
    month: response.month,
    generatedAt: response.generatedAt,
    asOfDate: response.asOfDate,
    summaryText: response.summaryText,
    warnings: uniqueSummaryWarnings(response.warnings.map((warning) => ({ code: warning.code, message: warning.message }))),
  };
}

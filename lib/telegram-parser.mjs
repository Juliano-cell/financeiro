import { parseBrazilianMoney } from "./finance-rules.mjs";
import { parseTelegramInstallmentInput, resolveTelegramDueDate } from "./telegram-payment-flow.mjs";

const AMOUNT = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{1,2}|\d+(?:[,.]\d{1,2})?)(?!\d|[.,]\d)(?:\s*reais?)?(?!\s*(?:x\b|parcelas?\b))/i;
const TRANSACTION_WORDS = /\b(gastei|paguei|comprei|passei|recebi|entrou|ganhei)\b/iu;
const STOP_WORDS = /\b(gastei|paguei|comprei|passei|recebi|entrou|ganhei|uma?|de|da|do|no|na|em|pelo|pela|hoje|ontem|anteontem)\b/giu;

export function normalizeTelegramText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/\s+/g, " ").trim();
}

export function dateInSaoPaulo(now = new Date(), dayOffset = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return shifted.toISOString().slice(0, 10);
}

function findNamedEntity(text, items = []) {
  const normalized = normalizeTelegramText(text);
  const matches = items.filter((item) => {
    const name = normalizeTelegramText(item.name);
    return name.length >= 2 && new RegExp(`(?:^|\\b)${escapeRegExp(name)}(?:\\b|$)`, "u").test(normalized);
  }).sort((left, right) => String(right.name).length - String(left.name).length);
  if (!matches.length) return { value: null, ambiguous: false };
  const longest = normalizeTelegramText(matches[0].name).length;
  const equallySpecific = matches.filter((item) => normalizeTelegramText(item.name).length === longest);
  return { value: equallySpecific.length === 1 ? equallySpecific[0] : null, ambiguous: equallySpecific.length > 1 };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function categorySuggestion(text, type, categories = [], subcategories = []) {
  const normalized = normalizeTelegramText(text);
  const eligibleCategories = categories.filter((item) => item.type === type || item.type === "both");
  const categoryById = new Map(eligibleCategories.map((item) => [item.id, item]));
  const eligibleSubs = subcategories.filter((item) => categoryById.has(item.categoryId));
  const directSub = findNamedEntity(normalized, eligibleSubs);
  if (directSub.value) return { categoryId: directSub.value.categoryId, subcategoryId: directSub.value.id, categoryAmbiguous: directSub.ambiguous };
  const directCategory = findNamedEntity(normalized, eligibleCategories);
  if (directCategory.value) return { categoryId: directCategory.value.id, subcategoryId: null, categoryAmbiguous: directCategory.ambiguous };
  const synonyms = type === "income"
    ? [[/\bdiaria\b/u, ["diarias", "renda"]], [/\b(cliente|servico|freela)\b/u, ["servicos", "renda"]], [/\b(salario|pagamento)\b/u, ["salario", "renda"]]]
    : [[/\b(mercado|supermercado)\b/u, ["mercado", "alimentacao"]], [/\b(gasolina|combustivel|etanol|diesel)\b/u, ["combustivel", "transporte"]], [/\b(internet|wifi)\b/u, ["internet", "moradia"]], [/\b(farmacia|remedio|medicamento)\b/u, ["saude", "outros"]]];
  for (const [pattern, candidates] of synonyms) {
    if (!pattern.test(normalized)) continue;
    for (const candidate of candidates) {
      const subcategory = eligibleSubs.find((item) => normalizeTelegramText(item.name) === candidate);
      if (subcategory) return { categoryId: subcategory.categoryId, subcategoryId: subcategory.id, categoryAmbiguous: false };
      const category = eligibleCategories.find((item) => normalizeTelegramText(item.name) === candidate);
      if (category) return { categoryId: category.id, subcategoryId: null, categoryAmbiguous: false };
    }
  }
  return { categoryId: null, subcategoryId: null, categoryAmbiguous: directCategory.ambiguous || directSub.ambiguous };
}

function extractDescription(raw, entities) {
  let description = raw.toLocaleLowerCase("pt-BR")
    .replace(/\b(?:e\s+)?(?:vou\s+pagar|pago|fic(?:a|ou)\s+para(?:\s+pagar)?|vence|vencimento)\b[\s\S]*$/iu, " ")
    .replace(/\b(direto na loja|no carn[eê]|credi[aá]rio|parcelado direto|parcelado com a loja|na hora)\b/giu, " ")
    .replace(new RegExp(`(?:\\bpor\\s+)?${AMOUNT.source}`, "iu"), " ")
    .replace(STOP_WORDS, " ").replace(/\b\d{1,3}\s*x\b/giu, " ");
  for (const entity of entities.filter(Boolean)) description = description.replace(new RegExp(escapeRegExp(String(entity.name)), "giu"), " ");
  description = description
    .replace(/\b(cart[aã]o|cr[eé]dito|d[eé]bito|dinheiro|pix|transfer[eê]ncia|parcelas?|m[eê]s que vem)\b/giu, " ")
    .replace(/\b\d{1,2}(?:\/\d{1,2})(?:\/\d{4})?\b/gu, " ")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  return description ? description[0].toLocaleUpperCase("pt-BR") + description.slice(1) : null;
}

export function mergeFinancialIntent(saved, patch) {
  const merged = { ...saved, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null && value !== "")) };
  merged.missing = [!merged.type && "tipo", !merged.amountCents && "valor", !merged.description && "descrição"].filter(Boolean);
  merged.ambiguous = merged.missing.length > 0;
  return merged;
}

export function parseTelegramMessage(message, context = {}, options = {}) {
  const raw = String(message ?? "").trim();
  const normalized = normalizeTelegramText(raw);
  const now = options.now ?? new Date();
  if (!raw) return { intent: "unknown", missing: ["mensagem"] };
  if (raw.length > 1_000) return { intent: "unknown", error: "message_too_long", missing: [] };
  if (/^\/(?:cancelar)(?:@\w+)?$/iu.test(raw) || normalized === "cancelar") return { intent: "cancel" };
  if (/^(confirmar|confirmo|sim)$/iu.test(normalized)) return { intent: "confirm" };
  if (/^(alterar|editar)$/iu.test(normalized)) return { intent: "alter" };
  if (/^\/(?:ajuda|help)(?:@\w+)?$/iu.test(raw)) return { intent: "help" };
  const start = raw.match(/^\/start(?:@\w+)?(?:\s+(\d{6}))?$/iu);
  if (start) return start[1] ? { intent: "connect", code: start[1] } : { intent: "start" };
  const connect = raw.match(/^\/conectar(?:@\w+)?\s+(\d{6})$/iu);
  if (connect) return { intent: "connect", code: connect[1] };
  if (/\b(quanto temos|qual (?:e |é )?(?:o )?(?:meu|nosso) saldo)\b/iu.test(raw)) return { intent: "query", query: "balance" };

  const amountMatch = raw.match(AMOUNT);
  let amountCents = null;
  try { if (amountMatch) amountCents = parseBrazilianMoney(amountMatch[1]); } catch { /* caller asks again */ }
  const income = /\b(recebi|entrou|ganhei)\b/u.test(normalized);
  const expense = /\b(gastei|paguei|comprei|passei)\b/u.test(normalized);
  const type = income && !expense ? "income" : expense && !income ? "expense" : null;
  const accountMatch = findNamedEntity(normalized, context.accounts);
  const cardMatch = findNamedEntity(normalized, context.cards);
  const paymentMethod = /\bdinheiro\b/u.test(normalized) ? "cash" : /\bpix\b/u.test(normalized) ? "pix" : /\bdebito\b/u.test(normalized) ? "debit" : /\btransferencia\b/u.test(normalized) ? "transfer" : null;
  let installmentInput = parseTelegramInstallmentInput(normalized);
  if (installmentInput.status === "absent" && /\ba vista\b/u.test(normalized)) installmentInput = { status: "valid", count: 1 };
  const parsedInstallmentCount = installmentInput.count;
  const directSignal = /\b(direto na loja|no carne|crediario|parcelado direto|parcelado com a loja)\b/u.test(normalized);
  const futureContext = /\b(vou pagar|pago|fic(?:a|ou) para(?: pagar)?|vence|vencimento)\b/u.test(normalized);
  const futureDate = /\b(depois|amanha|mes que vem|dia\s+\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?|\d{4}-\d{2}-\d{2}|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/u.test(normalized);
  // A descrição do objeto (por exemplo, "capa para cartão de crédito") não é pagamento.
  const explicitCardSignal = /\b(no cartao|no credito|passei no cartao)\b/u.test(normalized);
  const futureSignal = type === "expense" && !directSignal && !explicitCardSignal && futureContext && futureDate;
  const immediateSignal = Boolean(paymentMethod) || /\bna hora\b/u.test(normalized);
  const installmentCardSignal = parsedInstallmentCount !== null && Boolean(cardMatch.value) && !directSignal && !futureSignal && !immediateSignal;
  const flowCandidates = new Set();
  if (directSignal) flowCandidates.add("direct_installments");
  if (futureSignal) flowCandidates.add("future_bill");
  if (explicitCardSignal || installmentCardSignal) flowCandidates.add("credit_card");
  if (immediateSignal) flowCandidates.add("immediate");
  if (!directSignal && !futureSignal && !explicitCardSignal && !installmentCardSignal && !immediateSignal) {
    if (cardMatch.value && accountMatch.value) {
      flowCandidates.add("credit_card");
      flowCandidates.add("immediate");
    } else if (cardMatch.value) flowCandidates.add("credit_card");
    else if (accountMatch.value) flowCandidates.add("immediate");
  }
  const paymentFlow = type === "income" ? "immediate" : flowCandidates.size === 1 ? [...flowCandidates][0] : null;
  const category = type ? categorySuggestion(normalized, type, context.categories, context.subcategories) : { categoryId: null, subcategoryId: null, categoryAmbiguous: false };
  const description = extractDescription(raw, [accountMatch.value, cardMatch.value]);
  const purchaseDate = /\banteontem\b/u.test(normalized) ? dateInSaoPaulo(now, -2) : /\bontem\b/u.test(normalized) ? dateInSaoPaulo(now, -1) : dateInSaoPaulo(now);
  const due = paymentFlow === "future_bill" || paymentFlow === "direct_installments" ? resolveTelegramDueDate(raw, purchaseDate, null, paymentFlow === "future_bill") : { status: "absent", date: null, desiredDay: null };
  const installmentCount = paymentFlow === "immediate" || paymentFlow === "future_bill" ? null : parsedInstallmentCount;
  const missing = [!type && "tipo", !amountCents && "valor", !description && "descrição"].filter(Boolean);
  const paymentAmbiguous = accountMatch.ambiguous || cardMatch.ambiguous || category.categoryAmbiguous || flowCandidates.size > 1;
  return {
    intent: TRANSACTION_WORDS.test(normalized) || amountCents ? "transaction" : "unknown",
    type,
    amountCents,
    description,
    purchaseDate,
    paymentFlow,
    legacyCardCompatible: paymentFlow === "credit_card" && Boolean(cardMatch.value) && parsedInstallmentCount !== null,
    installmentCount,
    installmentInputStatus: installmentCount === null && installmentInput.status === "valid" ? "absent" : installmentInput.status,
    paymentMethod,
    cardId: paymentFlow === "credit_card" ? cardMatch.value?.id ?? null : null,
    accountId: paymentFlow === "immediate" ? accountMatch.value?.id ?? null : null,
    dueDate: paymentFlow === "future_bill" && due.status === "resolved" ? due.date : null,
    dueMonth: paymentFlow === "future_bill" && due.status === "incomplete" ? due.targetMonth ?? null : null,
    firstDueDate: paymentFlow === "direct_installments" && due.status === "resolved" ? due.date : null,
    installmentDayOfMonth: paymentFlow === "direct_installments" && due.status === "resolved" ? due.desiredDay : null,
    categoryId: category.categoryId,
    subcategoryId: category.subcategoryId,
    missing,
    ambiguous: missing.length > 0 || paymentAmbiguous || paymentFlow === null || due.status === "invalid",
    ambiguity: paymentAmbiguous || paymentFlow === null ? "forma_pagamento" : due.status === "invalid" ? "vencimento" : null,
  };
}

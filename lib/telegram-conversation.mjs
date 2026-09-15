import { transitionTelegramPaymentFlow } from "./telegram-payment-flow.mjs";

export const TELEGRAM_PAGE_SIZE = 6;

const kindCodes = { account: "a", card: "r", category: "c", subcategory: "s" };
const codeKinds = Object.fromEntries(Object.entries(kindCodes).map(([kind, code]) => [code, kind]));
const fieldCodes = { value: "v", description: "d", account: "a", card: "r", category: "c", subcategory: "s", date: "t", paymentFlow: "f", dueDate: "u", installmentCount: "n", firstDueDate: "p" };
const codeFields = Object.fromEntries(Object.entries(fieldCodes).map(([field, code]) => [code, field]));
const flowCodes = { immediate: "i", future_bill: "f", credit_card: "c", direct_installments: "d" };
const codeFlows = Object.fromEntries(Object.entries(flowCodes).map(([flow, code]) => [code, flow]));
const safeId = /^[A-Za-z0-9_-]{1,52}$/u;
const safeSessionId = /^[A-Za-z0-9_-]{10}$/u;

function callbackData(sessionId, action) {
  if (!safeSessionId.test(String(sessionId ?? ""))) throw new Error("Sessão financeira inválida.");
  return `${sessionId}${action}`;
}

export function createTelegramFinancialSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "").slice(0, 10);
}

export function parseTelegramCallback(value) {
  const data = String(value ?? "");
  let match = data.match(/^([A-Za-z0-9_-]{10})([oexb])$/u);
  if (match) {
    const actions = { o: "confirm", e: "alter", x: "cancel", b: "back" };
    return match[2] === "b" ? { action: "back", kind: "category", sessionId: match[1] } : { action: actions[match[2]], sessionId: match[1] };
  }
  match = data.match(/^([A-Za-z0-9_-]{10})w([ifcd])$/u);
  if (match && codeFlows[match[2]]) return { action: "select-flow", paymentFlow: codeFlows[match[2]], sessionId: match[1] };
  match = data.match(/^([A-Za-z0-9_-]{10})d([vdarcstfunp])$/u);
  if (match && codeFields[match[2]]) return { action: "edit-field", field: codeFields[match[2]], sessionId: match[1] };
  match = data.match(/^([A-Za-z0-9_-]{10})s([arcs])([A-Za-z0-9_-]{1,52})$/u);
  if (match && codeKinds[match[2]]) return { action: "select", kind: codeKinds[match[2]], id: match[3], sessionId: match[1] };
  match = data.match(/^([A-Za-z0-9_-]{10})p([arcs])(\d{1,4})$/u);
  if (match && codeKinds[match[2]]) return { action: "page", kind: codeKinds[match[2]], page: Number(match[3]), sessionId: match[1] };
  if (/^(?:confirmar|ok|alterar|edit|cancelar|cancel|back:category|flow:[ifcd]|edit:[vdarcstfunp]|pick:[arcs]:[A-Za-z0-9_-]{1,52}|page:[arcs]:\d{1,4})$/u.test(data)) return { action: "stale" };
  return { action: "invalid" };
}

export function isTelegramCallbackForSession(callback, sessionId) {
  return Boolean(callback && safeSessionId.test(String(sessionId ?? "")) && callback.sessionId === sessionId);
}

export function telegramPaymentFlowButtons(sessionId) {
  return [
    [{ text: "💵 Pago agora", callback_data: callbackData(sessionId, "wi") }, { text: "📅 Pagar depois", callback_data: callbackData(sessionId, "wf") }],
    [{ text: "💳 Cartão de crédito", callback_data: callbackData(sessionId, "wc") }, { text: "🧾 Parcelado direto", callback_data: callbackData(sessionId, "wd") }],
    [{ text: "❌ Cancelar", callback_data: callbackData(sessionId, "x") }],
  ];
}

export function telegramCancelButtons(sessionId, text = "❌ Cancelar") {
  return [[{ text, callback_data: callbackData(sessionId, "x") }]];
}

export function resolveTelegramSelection(items, id) {
  return items.find((item) => item.id === id) ?? null;
}

export function paginateTelegramOptions(items, requestedPage, pageSize = TELEGRAM_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(Number.isInteger(requestedPage) ? requestedPage : 0, 0), totalPages - 1);
  return { page, totalPages, items: items.slice(page * pageSize, (page + 1) * pageSize) };
}

function rowsOfTwo(buttons) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return rows;
}

function buttonLabel(prefix, name) {
  const clean = String(name ?? "").replace(/\s+/gu, " ").trim();
  return `${prefix} ${clean.slice(0, 32)}`;
}

export function telegramSelectionButtons(kind, items, requestedPage = 0, options = {}) {
  const code = kindCodes[kind];
  if (!code) return [];
  const sessionId = options.sessionId;
  const eligible = items.filter((item) => safeId.test(String(item.id)));
  const page = paginateTelegramOptions(eligible, requestedPage);
  const prefix = kind === "account" ? "🏦" : kind === "card" ? "💳" : kind === "category" ? "🗂" : "📂";
  const rows = rowsOfTwo(page.items.map((item) => ({ text: buttonLabel(prefix, item.name), callback_data: callbackData(sessionId, `s${code}${item.id}`) })));
  const navigation = [];
  if (page.page > 0) navigation.push({ text: "⬅️ Anterior", callback_data: callbackData(sessionId, `p${code}${page.page - 1}`) });
  if (page.page + 1 < page.totalPages) navigation.push({ text: "➡️ Próxima", callback_data: callbackData(sessionId, `p${code}${page.page + 1}`) });
  if (navigation.length) rows.push(navigation);
  if (options.allowNone && kind === "subcategory") rows.push([{ text: "Sem subcategoria", callback_data: callbackData(sessionId, "ssnone") }]);
  if (options.allowCategoryBack && kind === "subcategory") rows.push([{ text: "⬅️ Voltar às categorias", callback_data: callbackData(sessionId, "b") }]);
  rows.push([{ text: "❌ Cancelar", callback_data: callbackData(sessionId, "x") }]);
  return rows;
}

export function telegramEditButtons({ sessionId = "", paymentFlow = "immediate", isCard = false, hasSubcategories = false } = {}) {
  const flow = isCard && paymentFlow === "immediate" ? "credit_card" : paymentFlow;
  const rows = [
    [{ text: "💰 Valor", callback_data: callbackData(sessionId, "dv") }, { text: "📝 Descrição", callback_data: callbackData(sessionId, "dd") }],
    [{ text: "🗂 Categoria", callback_data: callbackData(sessionId, "dc") }, { text: "📅 Data da compra", callback_data: callbackData(sessionId, "dt") }],
    [{ text: "🔄 Forma de pagamento", callback_data: callbackData(sessionId, "df") }],
  ];
  if (hasSubcategories) rows.push([{ text: "📂 Subcategoria", callback_data: callbackData(sessionId, "ds") }]);
  if (flow === "immediate") rows.push([{ text: "🏦 Conta", callback_data: callbackData(sessionId, "da") }]);
  else if (flow === "future_bill") rows.push([{ text: "📅 Vencimento", callback_data: callbackData(sessionId, "du") }]);
  else if (flow === "credit_card") rows.push([{ text: "💳 Cartão", callback_data: callbackData(sessionId, "dr") }, { text: "🔢 Parcelas", callback_data: callbackData(sessionId, "dn") }]);
  else if (flow === "direct_installments") rows.push([{ text: "🔢 Parcelas", callback_data: callbackData(sessionId, "dn") }, { text: "📅 1º vencimento", callback_data: callbackData(sessionId, "dp") }]);
  rows.push([{ text: "❌ Cancelar alteração", callback_data: callbackData(sessionId, "x") }]);
  return rows;
}

export function telegramConfirmationButtons(sessionId) {
  return [[
    { text: "✅ Confirmar", callback_data: callbackData(sessionId, "o") },
    { text: "✏️ Alterar", callback_data: callbackData(sessionId, "e") },
    { text: "❌ Cancelar", callback_data: callbackData(sessionId, "x") },
  ]];
}

export function updateTelegramIntentField(intent, field, value) {
  if (field === "paymentFlow") return transitionTelegramPaymentFlow(intent, value);
  const next = { ...intent };
  if (field === "value") next.amountCents = value;
  else if (field === "description") next.description = value;
  else if (field === "account") next.accountId = value;
  else if (field === "card") next.cardId = value;
  else if (field === "category") {
    next.categoryId = value;
    next.subcategoryId = null;
    next.subcategorySkipped = false;
  } else if (field === "subcategory") {
    next.subcategoryId = value === "none" ? null : value;
    next.subcategorySkipped = value === "none";
  } else if (field === "date") {
    next.purchaseDate = value;
    delete next.transactionDate;
    if (next.dueDate && next.dueDate < value) {
      next.dueDate = null;
      next.dueMonth = null;
    } else if (next.dueMonth && next.dueMonth < String(value).slice(0, 7)) next.dueMonth = null;
  } else if (field === "dueDate") {
    next.dueDate = value;
    next.dueMonth = null;
  }
  else if (field === "installmentCount") next.installmentCount = value;
  else if (field === "firstDueDate") {
    next.firstDueDate = value.date ?? value;
    next.installmentDayOfMonth = value.desiredDay ?? Number(String(next.firstDueDate).slice(8));
  }
  return next;
}

export { transitionTelegramPaymentFlow };

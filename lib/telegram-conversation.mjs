export const TELEGRAM_PAGE_SIZE = 6;

const kindCodes = { account: "a", card: "r", category: "c", subcategory: "s" };
const codeKinds = Object.fromEntries(Object.entries(kindCodes).map(([kind, code]) => [code, kind]));
const fieldCodes = { value: "v", description: "d", account: "a", card: "r", category: "c", subcategory: "s", date: "t" };
const codeFields = Object.fromEntries(Object.entries(fieldCodes).map(([field, code]) => [code, field]));
const safeId = /^[A-Za-z0-9_-]{1,52}$/u;

export function parseTelegramCallback(value) {
  const data = String(value ?? "");
  if (data === "confirmar" || data === "ok") return { action: "confirm" };
  if (data === "alterar" || data === "edit") return { action: "alter" };
  if (data === "cancelar" || data === "cancel") return { action: "cancel" };
  if (data === "back:category") return { action: "back", kind: "category" };

  let match = data.match(/^edit:([vdarcst])$/u);
  if (match && codeFields[match[1]]) return { action: "edit-field", field: codeFields[match[1]] };
  match = data.match(/^pick:([arcs]):([A-Za-z0-9_-]{1,52})$/u);
  if (match && codeKinds[match[1]]) return { action: "select", kind: codeKinds[match[1]], id: match[2] };
  match = data.match(/^page:([arcs]):(\d{1,4})$/u);
  if (match && codeKinds[match[1]]) return { action: "page", kind: codeKinds[match[1]], page: Number(match[2]) };
  return { action: "invalid" };
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
  const eligible = items.filter((item) => safeId.test(String(item.id)));
  const page = paginateTelegramOptions(eligible, requestedPage);
  const prefix = kind === "account" ? "🏦" : kind === "card" ? "💳" : kind === "category" ? "🗂" : "📂";
  const rows = rowsOfTwo(page.items.map((item) => ({ text: buttonLabel(prefix, item.name), callback_data: `pick:${code}:${item.id}` })));
  const navigation = [];
  if (page.page > 0) navigation.push({ text: "⬅️ Anterior", callback_data: `page:${code}:${page.page - 1}` });
  if (page.page + 1 < page.totalPages) navigation.push({ text: "➡️ Próxima", callback_data: `page:${code}:${page.page + 1}` });
  if (navigation.length) rows.push(navigation);
  if (options.allowNone && kind === "subcategory") rows.push([{ text: "Sem subcategoria", callback_data: "pick:s:none" }]);
  if (options.allowCategoryBack && kind === "subcategory") rows.push([{ text: "⬅️ Voltar às categorias", callback_data: "back:category" }]);
  rows.push([{ text: "❌ Cancelar", callback_data: "cancel" }]);
  return rows;
}

export function telegramEditButtons({ isCard = false, hasSubcategories = false } = {}) {
  const rows = [
    [{ text: "💰 Valor", callback_data: "edit:v" }, { text: "📝 Descrição", callback_data: "edit:d" }],
    [{ text: isCard ? "💳 Cartão" : "🏦 Conta", callback_data: isCard ? "edit:r" : "edit:a" }, { text: "🗂 Categoria", callback_data: "edit:c" }],
  ];
  if (hasSubcategories && !isCard) rows.push([{ text: "📂 Subcategoria", callback_data: "edit:s" }, { text: "📅 Data", callback_data: "edit:t" }]);
  else rows.push([{ text: "📅 Data", callback_data: "edit:t" }]);
  rows.push([{ text: "❌ Cancelar alteração", callback_data: "cancel" }]);
  return rows;
}

export const telegramConfirmationButtons = [[
  { text: "✅ Confirmar", callback_data: "ok" },
  { text: "✏️ Alterar", callback_data: "edit" },
  { text: "❌ Cancelar", callback_data: "cancel" },
]];

export function updateTelegramIntentField(intent, field, value) {
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
  } else if (field === "date") next.transactionDate = value;
  return next;
}

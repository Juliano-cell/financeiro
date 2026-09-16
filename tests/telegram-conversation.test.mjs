import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createTelegramFinancialSessionId, isTelegramCallbackForSession, paginateTelegramOptions, parseTelegramCallback, resolveTelegramSelection, telegramConfirmationButtons, telegramEditButtons, telegramPaymentFlowButtons, telegramSelectionButtons, updateTelegramIntentField } from "../lib/telegram-conversation.mjs";

const sessionId = "AbCdEf012_";
const otherSessionId = "ZyXwVu987-";

const baseIntent = {
  intent: "transaction",
  type: "expense",
  amountCents: 1_000,
  description: "Mercado",
  purchaseDate: "2026-09-11",
  paymentFlow: "immediate",
  accountId: "account-a",
  categoryId: "category-food",
  subcategoryId: "subcategory-market",
};

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

test("seleção de conta usa somente o ID mínimo do callback", () => {
  assert.deepEqual(parseTelegramCallback(`${sessionId}saaccount-a`), { action: "select", kind: "account", id: "account-a", sessionId });
  const buttons = telegramSelectionButtons("account", [{ id: "account-a", name: "Conta dinheiro" }], 0, { sessionId });
  assert.equal(buttons[0][0].callback_data, `${sessionId}saaccount-a`);
  assert.doesNotMatch(buttons[0][0].callback_data, /Conta dinheiro|household/iu);
});

test("conta de outro household é rejeitada pela resolução na lista filtrada", () => {
  const householdAccounts = [{ id: "account-a", name: "Conta A" }];
  assert.equal(resolveTelegramSelection(householdAccounts, "account-b"), null);
  assert.equal(resolveTelegramSelection(householdAccounts, "account-a")?.id, "account-a");
});

test("seleção de categoria usa ID e rejeita categoria de outro household", () => {
  assert.deepEqual(parseTelegramCallback(`${sessionId}sccategory-food`), { action: "select", kind: "category", id: "category-food", sessionId });
  const householdCategories = [{ id: "category-food", name: "Alimentação" }];
  assert.equal(resolveTelegramSelection(householdCategories, "category-other"), null);
});

test("seleção de subcategoria fica limitada à categoria escolhida", () => {
  const all = [{ id: "sub-market", categoryId: "category-food" }, { id: "sub-fuel", categoryId: "category-car" }];
  const eligible = all.filter((item) => item.categoryId === "category-food");
  assert.equal(resolveTelegramSelection(eligible, "sub-market")?.id, "sub-market");
  assert.equal(resolveTelegramSelection(eligible, "sub-fuel"), null);
  assert.deepEqual(parseTelegramCallback(`${sessionId}sssub-market`), { action: "select", kind: "subcategory", id: "sub-market", sessionId });
});

test("paginação de contas limita seis opções e oferece próxima página", () => {
  const accounts = Array.from({ length: 14 }, (_, index) => ({ id: `account-${index}`, name: `Conta ${index}` }));
  assert.deepEqual(paginateTelegramOptions(accounts, 0), { page: 0, totalPages: 3, items: accounts.slice(0, 6) });
  const buttons = telegramSelectionButtons("account", accounts, 0, { sessionId }).flat();
  assert.ok(buttons.some((button) => button.callback_data === `${sessionId}pa1`));
  assert.equal(buttons.filter((button) => button.callback_data.startsWith(`${sessionId}sa`)).length, 6);
});

test("paginação de categorias valida e limita páginas fora do intervalo", () => {
  const categories = Array.from({ length: 8 }, (_, index) => ({ id: `category-${index}`, name: `Categoria ${index}` }));
  const page = paginateTelegramOptions(categories, 99);
  assert.equal(page.page, 1);
  assert.equal(page.totalPages, 2);
  assert.deepEqual(parseTelegramCallback(`${sessionId}pc1`), { action: "page", kind: "category", page: 1, sessionId });
});

test("alteração de valor preserva todos os demais campos", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "value", 2_500), { ...baseIntent, amountCents: 2_500 });
});

test("alteração de descrição preserva todos os demais campos", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "description", "Padaria"), { ...baseIntent, description: "Padaria" });
});

test("escolha posterior de cartão preserva parcelas inválidas e edição válida corrige o status", () => {
  const pending = { ...baseIntent, paymentFlow: "credit_card", legacyCardCompatible: false, cardId: null, installmentCount: null, installmentInputStatus: "invalid" };
  const selected = updateTelegramIntentField(pending, "card", "card-a");
  assert.equal(selected.installmentInputStatus, "invalid");
  assert.equal(selected.legacyCardCompatible, false);
  for (const flow of ["immediate", "future_bill"]) {
    const switched = updateTelegramIntentField(updateTelegramIntentField(selected, "paymentFlow", flow), "paymentFlow", "credit_card");
    assert.equal(switched.installmentInputStatus, "invalid");
    assert.equal(switched.installmentCount, null);
  }
  assert.deepEqual(updateTelegramIntentField(selected, "installmentCount", 3), { ...selected, installmentCount: 3, installmentInputStatus: "valid" });
});

test("alteração de conta preserva todos os demais campos", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "account", "account-new"), { ...baseIntent, accountId: "account-new" });
});

test("alteração de categoria limpa somente a subcategoria dependente", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "category", "category-home"), { ...baseIntent, categoryId: "category-home", subcategoryId: null, subcategorySkipped: false });
});

test("handler exige subcategoria ativa e não oferece pular quando a categoria possui opções", () => {
  const handler = readFileSync(new URL("../lib/telegram-handler.ts", import.meta.url), "utf8");
  assert.match(handler, /subcategoryCandidates\.length && !prepared\.subcategoryId/);
  assert.match(handler, /missing\.add\("subcategoria"\)/);
  assert.match(handler, /telegramSelectionButtons\(kind, items, page\.page, \{ sessionId: state\.sessionId, allowNone: false/);
  assert.match(handler, /const selected = resolveTelegramSelection\(items, callback\.id\)/);
  assert.doesNotMatch(handler, /subcategorySkipped\)\s*missing\.add\("subcategoria"\)/);
});

test("alteração de subcategoria preserva categoria e demais campos", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "subcategory", "subcategory-restaurant"), { ...baseIntent, subcategoryId: "subcategory-restaurant", subcategorySkipped: false });
});

test("alteração de data preserva todos os demais campos", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "date", "2026-09-12"), { ...baseIntent, purchaseDate: "2026-09-12" });
});

test("forma de pagamento usa callbacks curtos e rejeita adulteração", () => {
  assert.deepEqual(parseTelegramCallback(`${sessionId}wi`), { action: "select-flow", paymentFlow: "immediate", sessionId });
  assert.deepEqual(parseTelegramCallback(`${sessionId}wf`), { action: "select-flow", paymentFlow: "future_bill", sessionId });
  assert.deepEqual(parseTelegramCallback(`${sessionId}wc`), { action: "select-flow", paymentFlow: "credit_card", sessionId });
  assert.deepEqual(parseTelegramCallback(`${sessionId}wd`), { action: "select-flow", paymentFlow: "direct_installments", sessionId });
  assert.equal(parseTelegramCallback(`${sessionId}wz`).action, "invalid");
  assert.equal(parseTelegramCallback(`${sessionId}wi:household-a`).action, "invalid");
  for (const button of telegramPaymentFlowButtons(sessionId).flat()) assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
});

test("menu Alterar mostra somente campos compatíveis com o fluxo", () => {
  const fields = (paymentFlow) => telegramEditButtons({ sessionId, paymentFlow, hasSubcategories: true }).flat().map((button) => parseTelegramCallback(button.callback_data).field).filter(Boolean);
  assert.ok(fields("immediate").includes("account"));
  assert.ok(fields("future_bill").includes("dueDate"));
  assert.ok(fields("credit_card").includes("card"));
  assert.ok(fields("credit_card").includes("installmentCount"));
  assert.ok(fields("direct_installments").includes("firstDueDate"));
  assert.ok(fields("direct_installments").includes("installmentCount"));
  assert.ok(fields("immediate").every((value) => !["card", "dueDate", "installmentCount", "firstDueDate"].includes(value)));
  assert.ok(fields("future_bill").every((value) => !["account", "card", "installmentCount", "firstDueDate"].includes(value)));
});

test("cancelamento é reconhecido durante qualquer fase de seleção ou alteração", () => {
  for (const phase of ["choosing_edit_field", "editing_value", "editing_description", "editing_date", "selecting_account", "selecting_category", "selecting_subcategory", "confirming"]) {
    assert.equal(parseTelegramCallback(`${sessionId}x`).action, "cancel", phase);
  }
  assert.ok(telegramEditButtons({ sessionId }).flat().some((button) => button.callback_data === `${sessionId}x`));
});

test("confirmação após alteração continua sendo ação explícita separada", () => {
  const changed = updateTelegramIntentField(baseIntent, "value", 3_000);
  assert.equal(changed.amountCents, 3_000);
  assert.equal(parseTelegramCallback(`${sessionId}o`).action, "confirm");
});

test("callbacks financeiros são vinculados à sessão e botões antigos não atingem conversa nova", () => {
  const currentConfirm = parseTelegramCallback(telegramConfirmationButtons(sessionId)[0][0].callback_data);
  const oldConfirm = parseTelegramCallback(telegramConfirmationButtons(otherSessionId)[0][0].callback_data);
  const oldEdit = parseTelegramCallback(telegramConfirmationButtons(otherSessionId)[0][1].callback_data);
  const oldCancel = parseTelegramCallback(telegramConfirmationButtons(otherSessionId)[0][2].callback_data);
  assert.equal(isTelegramCallbackForSession(currentConfirm, sessionId), true);
  for (const callback of [oldConfirm, oldEdit, oldCancel]) assert.equal(isTelegramCallbackForSession(callback, sessionId), false);
  assert.equal(parseTelegramCallback("ok").action, "stale");
  assert.equal(parseTelegramCallback("cancel").action, "stale");
  assert.equal(parseTelegramCallback(`${sessionId.slice(0, -1)}Xo`).sessionId, `${sessionId.slice(0, -1)}X`);
  assert.equal(isTelegramCallbackForSession(parseTelegramCallback(`${sessionId.slice(0, -1)}Xo`), sessionId), false);
});

test("identificadores financeiros são curtos, imprevisíveis e não carregam IDs internos", () => {
  const sessions = new Set(Array.from({ length: 100 }, () => createTelegramFinancialSessionId()));
  assert.equal(sessions.size, 100);
  for (const value of sessions) assert.match(value, /^[A-Za-z0-9_-]{10}$/u);
  for (const button of telegramConfirmationButtons(sessionId).flat()) {
    assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
    assert.doesNotMatch(button.callback_data, /household|user/iu);
  }
});

test("callback repetido permanece idempotente e não cria movimentação", () => {
  const db = database();
  db.prepare("INSERT INTO telegram_processed_updates(update_id,received_at) VALUES(?,?)").run("callback-42", "2026-09-11T12:00:00.000Z");
  assert.throws(() => db.prepare("INSERT INTO telegram_processed_updates(update_id,received_at) VALUES(?,?)").run("callback-42", "2026-09-11T12:00:01.000Z"), /UNIQUE/);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 0);
});

test("handler revalida household, estado e relações antes de confirmar", () => {
  const handler = readFileSync(new URL("../lib/telegram-handler.ts", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
  assert.match(handler, /eq\(accounts\.householdId, householdId\)/);
  assert.match(handler, /eq\(categories\.householdId, householdId\)/);
  assert.match(handler, /eq\(subcategories\.householdId, householdId\)/);
  assert.match(handler, /conversationStateSchema\.safeParse/);
  assert.match(handler, /kindByPhase\[state\.phase\] !== kind/);
  assert.match(handler, /selectionChanged/);
  assert.match(handler, /if \(action === "confirm"\)[\s\S]+createTransaction/);
  assert.match(webhook, /answerTelegramCallback\(callbackQueryId\)/);
});

test("nenhuma criação financeira ocorre nos fluxos de seleção e alteração", () => {
  const handler = readFileSync(new URL("../lib/telegram-handler.ts", import.meta.url), "utf8");
  const confirmStart = handler.indexOf('if (action === "confirm")');
  const confirmEnd = handler.indexOf('if (command?.intent === "query"', confirmStart);
  assert.ok(confirmStart >= 0 && confirmEnd > confirmStart);
  assert.equal(handler.indexOf("createTransaction(", confirmEnd), -1);
  assert.equal(handler.indexOf("createCardPurchase(", confirmEnd), -1);
  assert.match(handler, /saveState\(updateId/);
});

test("callback_data permanece dentro do limite de 64 bytes", () => {
  const id = "x".repeat(52);
  const buttons = telegramSelectionButtons("subcategory", [{ id, name: "Nome muito longo ".repeat(10) }], 0, { sessionId, allowNone: true, allowCategoryBack: true }).flat();
  for (const button of buttons) assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64, button.callback_data);
  assert.equal(parseTelegramCallback(`${sessionId}ss${id}`).id, id);
  assert.equal(parseTelegramCallback(`${sessionId}ss${id}x`).action, "invalid");
});

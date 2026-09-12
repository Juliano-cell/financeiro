import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { paginateTelegramOptions, parseTelegramCallback, resolveTelegramSelection, telegramEditButtons, telegramSelectionButtons, updateTelegramIntentField } from "../lib/telegram-conversation.mjs";

const baseIntent = {
  intent: "transaction",
  type: "expense",
  amountCents: 1_000,
  description: "Mercado",
  transactionDate: "2026-09-11",
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
  assert.deepEqual(parseTelegramCallback("pick:a:account-a"), { action: "select", kind: "account", id: "account-a" });
  const buttons = telegramSelectionButtons("account", [{ id: "account-a", name: "Conta dinheiro" }]);
  assert.equal(buttons[0][0].callback_data, "pick:a:account-a");
  assert.doesNotMatch(buttons[0][0].callback_data, /Conta dinheiro|household/iu);
});

test("conta de outro household é rejeitada pela resolução na lista filtrada", () => {
  const householdAccounts = [{ id: "account-a", name: "Conta A" }];
  assert.equal(resolveTelegramSelection(householdAccounts, "account-b"), null);
  assert.equal(resolveTelegramSelection(householdAccounts, "account-a")?.id, "account-a");
});

test("seleção de categoria usa ID e rejeita categoria de outro household", () => {
  assert.deepEqual(parseTelegramCallback("pick:c:category-food"), { action: "select", kind: "category", id: "category-food" });
  const householdCategories = [{ id: "category-food", name: "Alimentação" }];
  assert.equal(resolveTelegramSelection(householdCategories, "category-other"), null);
});

test("seleção de subcategoria fica limitada à categoria escolhida", () => {
  const all = [{ id: "sub-market", categoryId: "category-food" }, { id: "sub-fuel", categoryId: "category-car" }];
  const eligible = all.filter((item) => item.categoryId === "category-food");
  assert.equal(resolveTelegramSelection(eligible, "sub-market")?.id, "sub-market");
  assert.equal(resolveTelegramSelection(eligible, "sub-fuel"), null);
  assert.deepEqual(parseTelegramCallback("pick:s:sub-market"), { action: "select", kind: "subcategory", id: "sub-market" });
});

test("paginação de contas limita seis opções e oferece próxima página", () => {
  const accounts = Array.from({ length: 14 }, (_, index) => ({ id: `account-${index}`, name: `Conta ${index}` }));
  assert.deepEqual(paginateTelegramOptions(accounts, 0), { page: 0, totalPages: 3, items: accounts.slice(0, 6) });
  const buttons = telegramSelectionButtons("account", accounts, 0).flat();
  assert.ok(buttons.some((button) => button.callback_data === "page:a:1"));
  assert.equal(buttons.filter((button) => button.callback_data.startsWith("pick:a:")).length, 6);
});

test("paginação de categorias valida e limita páginas fora do intervalo", () => {
  const categories = Array.from({ length: 8 }, (_, index) => ({ id: `category-${index}`, name: `Categoria ${index}` }));
  const page = paginateTelegramOptions(categories, 99);
  assert.equal(page.page, 1);
  assert.equal(page.totalPages, 2);
  assert.deepEqual(parseTelegramCallback("page:c:1"), { action: "page", kind: "category", page: 1 });
});

test("alteração de valor preserva todos os demais campos", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "value", 2_500), { ...baseIntent, amountCents: 2_500 });
});

test("alteração de descrição preserva todos os demais campos", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "description", "Padaria"), { ...baseIntent, description: "Padaria" });
});

test("alteração de conta preserva todos os demais campos", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "account", "account-new"), { ...baseIntent, accountId: "account-new" });
});

test("alteração de categoria limpa somente a subcategoria dependente", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "category", "category-home"), { ...baseIntent, categoryId: "category-home", subcategoryId: null, subcategorySkipped: false });
});

test("alteração de subcategoria preserva categoria e demais campos", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "subcategory", "subcategory-restaurant"), { ...baseIntent, subcategoryId: "subcategory-restaurant", subcategorySkipped: false });
});

test("alteração de data preserva todos os demais campos", () => {
  assert.deepEqual(updateTelegramIntentField(baseIntent, "date", "2026-09-12"), { ...baseIntent, transactionDate: "2026-09-12" });
});

test("cancelamento é reconhecido durante qualquer fase de seleção ou alteração", () => {
  for (const phase of ["choosing_edit_field", "editing_value", "editing_description", "editing_date", "selecting_account", "selecting_category", "selecting_subcategory", "confirming"]) {
    assert.equal(parseTelegramCallback("cancel").action, "cancel", phase);
  }
  assert.ok(telegramEditButtons().flat().some((button) => button.callback_data === "cancel"));
});

test("confirmação após alteração continua sendo ação explícita separada", () => {
  const changed = updateTelegramIntentField(baseIntent, "value", 3_000);
  assert.equal(changed.amountCents, 3_000);
  assert.equal(parseTelegramCallback("ok").action, "confirm");
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
  const buttons = telegramSelectionButtons("subcategory", [{ id, name: "Nome muito longo ".repeat(10) }], 0, { allowNone: true, allowCategoryBack: true }).flat();
  for (const button of buttons) assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64, button.callback_data);
  assert.equal(parseTelegramCallback(`pick:s:${id}`).id, id);
  assert.equal(parseTelegramCallback(`pick:s:${id}x`).action, "invalid");
});

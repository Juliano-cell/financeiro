import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildInstallmentPlan, invoiceSchedule, parseBrazilianMoney, simulatePurchase, splitInstallments } from "../lib/finance-rules.mjs";
import { parseTelegramMessage } from "../lib/telegram-parser.mjs";
import { digestToken, hmacToken } from "../lib/auth-crypto.mjs";

function database() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) for (const statement of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  return db;
}

test("valores brasileiros viram centavos inteiros", () => {
  assert.equal(parseBrazilianMoney("100"), 10000); assert.equal(parseBrazilianMoney("100,50"), 10050); assert.equal(parseBrazilianMoney("1.200,50"), 120050); assert.equal(parseBrazilianMoney("R$ 86,50"), 8650);
});

test("parcelamento preserva a soma e coloca centavo residual no fim", () => {
  assert.deepEqual(splitInstallments(10000, 3), [3333, 3333, 3334]); assert.equal(splitInstallments(240000, 10).reduce((a, b) => a + b), 240000); assert.deepEqual(splitInstallments(999, 1), [999]);
});

test("fechamento inclui o próprio dia e avança compras posteriores", () => {
  assert.equal(invoiceSchedule("2026-09-04", 5, 10, 1)[0].referenceMonth, "2026-09"); assert.equal(invoiceSchedule("2026-09-05", 5, 10, 1)[0].referenceMonth, "2026-09"); assert.equal(invoiceSchedule("2026-09-06", 5, 10, 1)[0].referenceMonth, "2026-10");
  const plan = buildInstallmentPlan({ totalCents: 10000, count: 3, purchaseDate: "2026-12-06", closingDay: 5, dueDay: 10 }); assert.deepEqual(plan.map((item) => item.referenceMonth), ["2027-01", "2027-02", "2027-03"]); assert.equal(plan.reduce((sum, item) => sum + item.amountCents, 0), 10000);
});

test("simulador classifica verde, amarelo, vermelho e dados insuficientes sem mutar entradas", () => {
  const base = [{ month: "2026-09", incomeCents: 500000, commitmentCents: 200000 }, { month: "2026-10", incomeCents: 500000, commitmentCents: 200000 }]; const snapshot = structuredClone(base);
  assert.equal(simulatePurchase({ startMonth: "2026-09", availableCents: 200000, purchaseCents: 10000, installmentCount: 1, firstImpactMonth: "2026-09", months: base }).rating, "green");
  assert.equal(simulatePurchase({ startMonth: "2026-09", availableCents: 0, purchaseCents: 250000, installmentCount: 1, firstImpactMonth: "2026-09", months: base }).rating, "yellow");
  assert.equal(simulatePurchase({ startMonth: "2026-09", availableCents: 0, purchaseCents: 800000, installmentCount: 1, firstImpactMonth: "2026-09", months: base }).rating, "red");
  assert.equal(simulatePurchase({ startMonth: "2026-09", availableCents: 100, purchaseCents: 100, months: [{ month: "2026-09", incomeCents: 0, commitmentCents: 0 }] }).confidence, "insufficient"); assert.deepEqual(base, snapshot);
});

test("parser Telegram entende exemplos e não inventa informação ausente", () => {
  assert.deepEqual(parseTelegramMessage("entrou 200 da Alessandra").type, "income"); assert.equal(parseTelegramMessage("mercado 86,50").amountCents, 8650); assert.equal(parseTelegramMessage("gastei 100 de gasolina").type, "expense");
  const card = parseTelegramMessage("celular 2400 Nubank 10x", { cards: [{ id: "card_a", name: "Nubank" }] }); assert.equal(card.cardId, "card_a"); assert.equal(card.installmentCount, 10); assert.equal(card.amountCents, 240000);
  assert.equal(parseTelegramMessage("quanto temos?").query, "balance"); assert.ok(parseTelegramMessage("gastei gasolina").missing.includes("valor"));
});

test("schema avançado preserva household, histórico e idempotência", () => {
  const db = database(); const at = "2026-09-11T12:00:00.000Z"; db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("u1", "A", "a@a.com", at, at); db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run("h1", "Casa", "u1", at, at); db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("c1", "h1", "Nubank", "Nubank", "A", 500000, 5, 10, at, at);
  assert.throws(() => db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("c2", "h2", "Outro", "Banco", "B", 1, 5, 10, at, at), /FOREIGN KEY/);
  db.prepare("INSERT INTO telegram_processed_updates(update_id,received_at) VALUES(?,?)").run("42", at); assert.throws(() => db.prepare("INSERT INTO telegram_processed_updates(update_id,received_at) VALUES(?,?)").run("42", at), /UNIQUE/);
});

test("migration incremental cria todas as estruturas novas sem alterar migrations antigas", () => {
  const db = database(); const names = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
  for (const name of ["credit_cards", "card_purchases", "card_invoices", "card_installments", "invoice_payments", "recurring_bill_series", "bills", "notification_preferences", "notification_log", "telegram_links", "telegram_link_codes", "telegram_conversation_states", "telegram_processed_updates"]) assert.ok(names.has(name), `missing ${name}`);
});

test("CHECK constraints rejeitam status, origin, recorrência e parcelas inválidos", () => {
  const db = database(); const at = "2026-09-11T12:00:00.000Z";
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("u1", "A", "a@a.com", at, at);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run("h1", "Casa", "u1", at, at);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run("m1", "h1", "u1", "owner", "active", at);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("c1", "h1", "Nubank", "Nubank", "A", 500000, 5, 10, at, at);
  assert.throws(() => db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("p1", "h1", "c1", "X", 100, "2026-09-11", 1, "inventado", "u1", "web", at, at), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("p2", "h1", "c1", "X", 100, "2026-09-11", 1, "active", "u1", "cliente", at, at), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,due_date,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("b1", "h1", "X", 100, "2026-09-20", "monthly", "pending", "u1", "web", at, at), /CHECK/);
});

test("foreign keys compostas rejeitam IDs de outro household", () => {
  const db = database(); const at = "2026-09-11T12:00:00.000Z";
  for (const [user, email] of [["ua", "a@a.com"], ["ub", "b@b.com"]]) db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, email, at, at);
  for (const [house, user] of [["ha", "ua"], ["hb", "ub"]]) { db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(house, house, user, at, at); db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${house}`, house, user, "owner", "active", at); db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`a${house}`, house, house, "bank", at, at); db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`k${house}`, house, house, "expense", at, at); db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`c${house}`, house, house, "Banco", user, 10000, 5, 10, at, at); }
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("sha", "ha", "kha", "Sub A", at, at); db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("shb", "hb", "khb", "Sub B", at, at);
  const purchase = "INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)";
  assert.throws(() => db.prepare(purchase).run("cross-card", "ha", "chb", "X", 100, "2026-09-11", 1, "kha", "active", "ua", "web", at, at), /FOREIGN KEY/);
  assert.throws(() => db.prepare(purchase).run("cross-category", "ha", "cha", "X", 100, "2026-09-11", 1, "khb", "active", "ua", "web", at, at), /FOREIGN KEY/);
  db.prepare(purchase).run("pa", "ha", "cha", "X", 100, "2026-09-11", 1, "kha", "active", "ua", "web", at, at);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("ib", "hb", "chb", "2026-09", "2026-09-20", "open", at, at);
  assert.throws(() => db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("cross-invoice", "ha", "pa", "ib", 1, 1, 100, "pending", at, at), /FOREIGN KEY/);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("ia", "ha", "cha", "2026-09", "2026-09-20", "open", at, at);
  assert.throws(() => db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run("cross-account", "ha", "ia", "ahb", 100, "2026-09-20", "ua", at), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("cross-bill-category", "ha", "X", 100, "khb", "2026-09-20", "aha", "none", "pending", "ua", "web", at, at), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("cross-bill-account", "ha", "X", 100, "kha", "2026-09-20", "ahb", "none", "pending", "ua", "web", at, at), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("cross-telegram", "ha", "ub", "42", "42", at, at), /FOREIGN KEY/);
  assert.equal(db.prepare("SELECT count(*) AS total FROM credit_cards WHERE household_id=? AND id=?").get("ha", "chb").total, 0);
});

test("update_transaction rejeita conta, categoria e subcategoria de outra família", () => {
  const db = database(); const at = "2026-09-11T12:00:00.000Z";
  for (const [user, house] of [["ua", "ha"], ["ub", "hb"]]) { db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, `${user}@example.com`, at, at); db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(house, house, user, at, at); db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`a${house}`, house, house, "bank", at, at); db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`k${house}`, house, house, "expense", at, at); db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`s${house}`, house, `k${house}`, house, at, at); }
  db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,category_id,subcategory_id,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("ta", "ha", "expense", 100, "X", "kha", "sha", "2026-09-11", "ua", "aha", "confirmed", "dashboard", at, at);
  assert.throws(() => db.prepare("UPDATE transactions SET account_id=? WHERE id=?").run("ahb", "ta"), /another household/);
  assert.throws(() => db.prepare("UPDATE transactions SET category_id=?, subcategory_id=NULL WHERE id=?").run("khb", "ta"), /another household/);
  assert.throws(() => db.prepare("UPDATE transactions SET subcategory_id=? WHERE id=?").run("shb", "ta"), /another household/);
});

test("Telegram vinculado à família A não consulta nem modifica registros da B", () => {
  const db = database(); const at = "2026-09-11T12:00:00.000Z";
  for (const [user, house] of [["ua", "ha"], ["ub", "hb"]]) { db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, `${user}@example.com`, at, at); db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(house, house, user, at, at); db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${house}`, house, user, "owner", "active", at); db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`a${house}`, house, house, "bank", at, at); }
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("link-a", "ha", "ua", "42", "42", at, at);
  const link = db.prepare("SELECT household_id FROM telegram_links WHERE telegram_user_id=? AND is_active=1").get("42");
  assert.equal(db.prepare("SELECT count(*) AS total FROM accounts WHERE household_id=? AND id=?").get(link.household_id, "ahb").total, 0);
  assert.equal(db.prepare("UPDATE accounts SET name='invasão' WHERE household_id=? AND id=?").run(link.household_id, "ahb").changes, 0);
  assert.equal(db.prepare("SELECT name FROM accounts WHERE id='ahb'").get().name, "hb");
});

test("pagamento integral é único e notification_log separa households", () => {
  const db = database(); const at = "2026-09-11T12:00:00.000Z";
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("u1", "A", "a@a.com", at, at); db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run("h1", "Casa", "u1", at, at); db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run("m1", "h1", "u1", "owner", "active", at); db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("a1", "h1", "Conta", "bank", at, at); db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("c1", "h1", "Cartão", "Banco", "A", 10000, 5, 10, at, at); db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("i1", "h1", "c1", "2026-09", "2026-09-20", "open", at, at);
  const payment = "INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)"; db.prepare(payment).run("p1", "h1", "i1", "a1", 100, "2026-09-20", "u1", at); assert.throws(() => db.prepare(payment).run("p2", "h1", "i1", "a1", 100, "2026-09-20", "u1", at), /UNIQUE/);
  const migration = readFileSync(new URL("../drizzle/0002_finance_evolution.sql", import.meta.url), "utf8");
  assert.match(migration, /invoice_payments_invoice_unique[^\n]+`invoice_id`/);
  assert.match(migration, /notification_log_idempotency_unique[^\n]+`household_id`/);
  assert.match(migration, /telegram_processed_updates[^;]+`update_id` text PRIMARY KEY/);
});

test("código Telegram usa HMAC secreto, limite e consumo condicional", async () => {
  const digest = await digestToken("123456"); const first = await hmacToken("123456", "secret-a"); const second = await hmacToken("123456", "secret-b");
  assert.notEqual(first, digest); assert.notEqual(first, second);
  const generator = readFileSync(new URL("../app/api/telegram/link-code/route.ts", import.meta.url), "utf8"); const linking = readFileSync(new URL("../lib/telegram-link-service.ts", import.meta.url), "utf8"); const handler = readFileSync(new URL("../lib/telegram-handler.ts", import.meta.url), "utf8");
  assert.match(generator, /consumeRateLimit\([^,]+, 5, 60 \* 60_000\)/); assert.match(linking, /hmacToken\(code, env\.TELEGRAM_LINK_CODE_SECRET\)/); assert.match(linking, /expiresInSeconds: 600/);
  assert.match(handler, /consumeRateLimit\(attemptKey, 5, 10 \* 60_000, 15 \* 60_000\)/); assert.match(linking, /used_at IS NULL AND expires_at > \?/); assert.match(linking, /codeChanges === 1/);
});

test("endpoints web forçam origin e validam relações também ao editar transação", () => {
  const advanced = readFileSync(new URL("../app/api/finance/advanced/route.ts", import.meta.url), "utf8"); const finance = readFileSync(new URL("../app/api/finance/route.ts", import.meta.url), "utf8");
  assert.match(advanced, /createCardPurchase\(parsed, \{ householdId, userId: user\.id, origin: "dashboard" \}\)/); assert.doesNotMatch(advanced, /origin: z\.enum/); assert.match(advanced, /env\.DB\.batch/);
  assert.match(finance, /validateTransactionRelations\(db, householdId, parsed\)/); assert.match(finance, /subcategory\.categoryId !== values\.categoryId/);
});

test("senha mínima está alinhada em oito caracteres no frontend e backend", () => {
  const backend = readFileSync(new URL("../app/api/auth/route.ts", import.meta.url), "utf8"); const frontend = readFileSync(new URL("../app/auth-forms.tsx", import.meta.url), "utf8"); assert.match(backend, /\.min\(8,/); assert.match(frontend, /minLength=\{8\}/); assert.doesNotMatch(frontend, /minLength=\{12\}/);
});

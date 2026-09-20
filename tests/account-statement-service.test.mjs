import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getAccountStatement, AccountStatementError, ACCOUNT_STATEMENT_MAX_LIMIT } from "../lib/account-statement-service.ts";
import { CURRENT_ACCOUNT_BALANCES_SQL } from "../lib/finance-analytics.mjs";

const AT = "2026-09-20T12:00:00.000Z";
const NOW = new Date(AT);

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async run() { const result = this.db.prepare(this.sql).run(...this.bindings); return { success: true, results: [], meta: { changes: result.changes } }; }
}

class LocalD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
}

function database(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  t.after(() => {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
  });
  return db;
}

function seedHousehold(db, suffix) {
  const values = { user: `user-${suffix}`, household: `house-${suffix}`, account: `account-${suffix}` };
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(values.user, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(values.household, `House ${suffix}`, values.user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(`member-${suffix}`, values.household, values.user, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(values.account, values.household, `Account ${suffix}`, "bank", 10_000, 1, AT, AT);
  return values;
}

function transaction(db, values) {
  db.prepare(`INSERT INTO transactions(
    id,household_id,type,amount_cents,description,category_id,subcategory_id,
    transaction_date,responsible_user_id,account_id,payment_method,status,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.id,
    values.household,
    values.type,
    values.amount,
    values.description,
    values.categoryId ?? null,
    values.subcategoryId ?? null,
    values.date,
    values.user,
    values.account,
    values.paymentMethod ?? null,
    values.status ?? "confirmed",
    "dashboard",
    AT,
    AT,
  );
}

function operation(db, values) {
  db.prepare(`INSERT INTO invoice_payment_operations(
    id,household_id,idempotency_key,kind,invoice_id,account_id,created_by_user_id,
    amount_cents,occurred_on,reversed_payment_id,request_fingerprint,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.id,
    values.household,
    `${values.id}-key`,
    values.kind,
    values.invoice,
    values.account,
    values.user,
    values.amount,
    values.date,
    values.reversedPaymentId ?? null,
    `${values.id}-fingerprint`,
    AT,
  );
}

function setup(t) {
  const db = database(t);
  const a = seedHousehold(db, "a");
  const b = seedHousehold(db, "b");
  db.prepare("UPDATE accounts SET initial_balance_cents = 7813 WHERE id = ?").run(a.account);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("account-empty", a.household, "Empty negative", "bank", -500, 1, AT, AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("account-inactive", a.household, "Inactive", "bank", 1_000, 0, AT, AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("account-manual", a.household, "Conta teste", "bank", 7_813, 1, AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("category-a", a.household, "Casa", "expense", "#397f72", AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run("subcategory-a", a.household, "category-a", "Mercado", AT, AT);

  transaction(db, { id: "before-income", household: a.household, type: "income", amount: 1_000, description: "Antes", date: "2026-09-01", user: a.user, account: a.account });
  transaction(db, { id: "salary", household: a.household, type: "income", amount: 5_000, description: "Salário", date: "2026-09-10", user: a.user, account: a.account, paymentMethod: "pix" });
  transaction(db, { id: "market", household: a.household, type: "expense", amount: 2_000, description: "Mercado", date: "2026-09-11", user: a.user, account: a.account, categoryId: "category-a", subcategoryId: "subcategory-a", paymentMethod: "debit_card" });
  transaction(db, { id: "same-day", household: a.household, type: "expense", amount: 200, description: "Mesmo dia", date: "2026-09-11", user: a.user, account: a.account });
  transaction(db, { id: "pending", household: a.household, type: "expense", amount: 700, description: "Pendente", date: "2026-09-12", user: a.user, account: a.account, status: "pending" });
  transaction(db, { id: "cancelled", household: a.household, type: "expense", amount: 800, description: "Cancelada", date: "2026-09-12", user: a.user, account: a.account, status: "cancelled" });
  transaction(db, { id: "paid-bill-transaction", household: a.household, type: "expense", amount: 300, description: "Energia", date: "2026-09-12", user: a.user, account: a.account, categoryId: "category-a", paymentMethod: "conta_a_pagar" });
  transaction(db, { id: "future", household: a.household, type: "expense", amount: 9_999, description: "Futuro", date: "2026-09-21", user: a.user, account: a.account });
  transaction(db, { id: "inactive-history", household: a.household, type: "expense", amount: 1_500, description: "Histórico inativo", date: "2026-09-15", user: a.user, account: "account-inactive" });
  transaction(db, { id: "other-house", household: b.household, type: "income", amount: 99_999, description: "Privado", date: "2026-09-10", user: b.user, account: b.account });

  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("pending-bill", a.household, "Água", 400, "category-a", "2026-09-13", a.account, "none", "pending", a.user, "web", AT, AT);
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,status,paid_at,payment_transaction_id,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("paid-bill", a.household, "Energia", 300, "category-a", "2026-09-12", a.account, "none", "paid", "2026-09-12", "paid-bill-transaction", a.user, "web", AT, AT);

  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("card-a", a.household, "Teste onboarding", "Teste", "A", 100_000, 5, 12, AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("invoice-a", a.household, "card-a", "2026-09", "2026-09-12", "2026-09-05", "open", AT, AT);
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,subcategory_id,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("purchase-a", a.household, "card-a", "Compra no cartão", 1_000, "2026-09-01", 1, "category-a", "subcategory-a", "active", a.user, "web", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("installment-a", a.household, "purchase-a", "invoice-a", 1, 1, 1_000, "pending", AT, AT);
  db.prepare("INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("batch-a", a.household, "card-a", a.user, "batch-a-key", "batch-a-fingerprint", "2026-09", 1_500, 500, 0, 0, "pending", AT);
  db.prepare("INSERT INTO card_invoice_adjustments(id,household_id,invoice_id,import_batch_id,kind,amount_cents,status,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("opening-a", a.household, "invoice-a", "batch-a", "opening_balance", 500, "active", a.user, AT);
  db.prepare("UPDATE card_import_batches SET status='completed', completed_at=? WHERE id='batch-a'").run(AT);

  operation(db, { id: "payment-operation", household: a.household, kind: "payment", invoice: "invoice-a", account: a.account, user: a.user, amount: 1_000, date: "2026-09-19" });
  db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at,operation_id) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("payment-a", a.household, "invoice-a", a.account, 1_000, "2026-09-19", a.user, AT, "payment-operation");
  operation(db, { id: "reversal-a", household: a.household, kind: "reversal", invoice: "invoice-a", account: a.account, user: a.user, amount: 1_000, date: "2026-09-19", reversedPaymentId: "payment-a" });
  operation(db, { id: "no-payment-a", household: a.household, kind: "no_payment", invoice: "invoice-a", account: a.account, user: a.user, amount: 0, date: "2026-09-19" });

  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("card-manual", a.household, "Cartão manual", "Teste", "A", 100_000, 5, 12, AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("invoice-manual", a.household, "card-manual", "2026-09", "2026-09-12", "2026-09-05", "open", AT, AT);
  db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("legacy-payment", a.household, "invoice-manual", "account-manual", 10_000, "2026-09-19", a.user, AT);
  operation(db, { id: "legacy-reversal", household: a.household, kind: "reversal", invoice: "invoice-manual", account: "account-manual", user: a.user, amount: 10_000, date: "2026-09-20", reversedPaymentId: "legacy-payment" });

  return { db, d1: new LocalD1(db), a, b };
}

function context(f, householdId = f.a.household) {
  return { d1: f.d1, householdId, now: NOW };
}

function statement(f, changes = {}, householdId) {
  return getAccountStatement({ accountId: f.a.account, from: "2026-09-10", to: "2026-09-20", ...changes }, context(f, householdId));
}

test("serviço retorna os quatro eventos bancários, metadata segura e reconciliação canônica", async t => {
  const f = setup(t);
  const value = await statement(f);
  assert.deepEqual(value.account, { id: f.a.account, name: "Account a", isActive: true });
  assert.deepEqual(value.period, { from: "2026-09-10", to: "2026-09-20" });
  assert.deepEqual(value.summary, {
    openingBalanceCents: 8_813,
    periodCreditsCents: 6_000,
    periodDebitsCents: 3_500,
    periodNetCents: 2_500,
    closingBalanceCents: 11_313,
  });
  assert.equal(value.summary.closingBalanceCents, value.summary.openingBalanceCents + value.summary.periodNetCents);
  assert.deepEqual(new Set(value.items.map((item) => item.eventType)), new Set(["income", "expense", "invoice_payment", "invoice_payment_reversal"]));
  assert.equal(value.items.find((item) => item.entityId === "salary")?.direction, "credit");
  assert.equal(value.items.find((item) => item.entityId === "market")?.signedAmountCents, -2_000);
  assert.deepEqual(value.items.find((item) => item.entityId === "market"), {
    id: "transaction:market", eventType: "expense", direction: "debit", eventDate: "2026-09-11",
    description: "Mercado", amountCents: 2_000, signedAmountCents: -2_000,
    entityType: "transaction", entityId: "market", categoryId: "category-a", categoryName: "Casa",
    subcategoryId: "subcategory-a", subcategoryName: "Mercado", paymentMethod: "debit_card",
    invoiceId: null, referenceMonth: null, cardId: null, cardName: null, originalPaymentId: null,
  });
  const payment = value.items.find((item) => item.entityId === "payment-a");
  const reversal = value.items.find((item) => item.entityId === "reversal-a");
  assert.equal(payment?.description, "Pagamento de fatura · Teste onboarding · 09/2026");
  assert.equal(payment?.invoiceId, "invoice-a");
  assert.equal(payment?.signedAmountCents, -1_000);
  assert.equal(reversal?.description, "Reversão de pagamento · Teste onboarding · 09/2026");
  assert.equal(reversal?.originalPaymentId, "payment-a");
  assert.equal(reversal?.signedAmountCents, 1_000);
  assert.equal(payment.signedAmountCents + reversal.signedAmountCents, 0);
});

test("eventos não bancários, status não confirmados, futuro e duplicidade da bill ficam ausentes", async t => {
  const f = setup(t);
  const value = await statement(f);
  const ids = value.items.map((item) => item.entityId);
  for (const excluded of ["pending", "cancelled", "future", "no-payment-a", "purchase-a", "installment-a", "opening-a", "pending-bill", "paid-bill"]) {
    assert.ok(!ids.includes(excluded), `${excluded} não pode aparecer no extrato`);
  }
  assert.equal(ids.filter((id) => id === "paid-bill-transaction").length, 1);
  assert.ok(!value.items.some((item) => item.description === "Privado"));
});

test("pagamento legado e reversão reproduzem 78,13 → -21,87 → 78,13", async t => {
  const f = setup(t);
  const paid = await getAccountStatement({ accountId: "account-manual", from: "2026-09-19", to: "2026-09-19" }, context(f));
  assert.equal(paid.summary.openingBalanceCents, 7_813);
  assert.equal(paid.summary.periodDebitsCents, 10_000);
  assert.equal(paid.summary.closingBalanceCents, -2_187);
  assert.equal(paid.items[0].entityId, "legacy-payment");
  assert.equal(paid.items[0].description, "Pagamento de fatura · Cartão manual · 09/2026");
  const reversed = await getAccountStatement({ accountId: "account-manual", from: "2026-09-19", to: "2026-09-20" }, context(f));
  assert.equal(reversed.summary.periodCreditsCents, 10_000);
  assert.equal(reversed.summary.periodDebitsCents, 10_000);
  assert.equal(reversed.summary.periodNetCents, 0);
  assert.equal(reversed.summary.closingBalanceCents, 7_813);
  assert.deepEqual(reversed.items.map((item) => item.eventType), ["invoice_payment_reversal", "invoice_payment"]);
  assert.equal(reversed.items[0].originalPaymentId, "legacy-payment");
});

test("conta sem eventos, saldo negativo e conta inativa permanecem consultáveis", async t => {
  const f = setup(t);
  const empty = await getAccountStatement({ accountId: "account-empty", from: "2026-09-01", to: "2026-09-20" }, context(f));
  assert.equal(empty.items.length, 0);
  assert.deepEqual(empty.summary, { openingBalanceCents: -500, periodCreditsCents: 0, periodDebitsCents: 0, periodNetCents: 0, closingBalanceCents: -500 });
  const inactive = await getAccountStatement({ accountId: "account-inactive", from: "2026-09-01", to: "2026-09-20" }, context(f));
  assert.equal(inactive.account.isActive, false);
  assert.equal(inactive.items.length, 1);
  assert.equal(inactive.summary.closingBalanceCents, -500);
});

test("conta de outro household falha sem retornar metadata ou saldo", async t => {
  const f = setup(t);
  await assert.rejects(
    getAccountStatement({ accountId: f.b.account, from: "2026-09-01", to: "2026-09-20" }, context(f)),
    (error) => error instanceof AccountStatementError && error.status === 404 && error.code === "ACCOUNT_STATEMENT_ACCOUNT_NOT_FOUND",
  );
});

test("paginação keyset é determinística, completa e sem repetição", async t => {
  const f = setup(t);
  for (let index = 0; index < 105; index += 1) {
    transaction(f.db, {
      id: `bulk-${String(index).padStart(3, "0")}`,
      household: f.a.household,
      type: "expense",
      amount: 1,
      description: `Bulk ${index}`,
      date: "2026-09-13",
      user: f.a.user,
      account: f.a.account,
    });
  }
  const defaultPage = await statement(f);
  assert.equal(defaultPage.items.length, 50);
  assert.equal(defaultPage.hasMore, true);
  const collected = [];
  let cursor = null;
  do {
    const page = await statement(f, { limit: 17, cursor });
    collected.push(...page.items);
    cursor = page.nextCursor;
    assert.equal(page.hasMore, cursor !== null);
  } while (cursor);
  assert.equal(collected.length, 111);
  assert.equal(new Set(collected.map((item) => item.id)).size, collected.length);
  assert.deepEqual(
    collected.filter((item) => item.eventDate === "2026-09-11").map((item) => item.id),
    [...collected.filter((item) => item.eventDate === "2026-09-11").map((item) => item.id)].sort().reverse(),
  );
  const maximumPage = await statement(f, { limit: ACCOUNT_STATEMENT_MAX_LIMIT });
  assert.equal(maximumPage.items.length, ACCOUNT_STATEMENT_MAX_LIMIT);
  assert.equal(maximumPage.hasMore, true);
  await assert.rejects(statement(f, { limit: ACCOUNT_STATEMENT_MAX_LIMIT + 1 }), (error) => error instanceof AccountStatementError && error.code === "ACCOUNT_STATEMENT_INVALID_LIMIT");
});

test("cursor é opaco, validado e vinculado ao período, conta e filtro", async t => {
  const f = setup(t);
  const first = await statement(f, { limit: 1 });
  assert.ok(first.nextCursor && !first.nextCursor.includes("payment"));
  await assert.rejects(statement(f, { limit: 1, cursor: "invalido*" }), (error) => error instanceof AccountStatementError && error.code === "ACCOUNT_STATEMENT_INVALID_CURSOR");
  await assert.rejects(statement(f, { limit: 1, cursor: first.nextCursor, from: "2026-09-11" }), (error) => error instanceof AccountStatementError && error.code === "ACCOUNT_STATEMENT_INVALID_CURSOR");
  await assert.rejects(statement(f, { limit: 1, cursor: first.nextCursor, eventType: "expense" }), (error) => error instanceof AccountStatementError && error.code === "ACCOUNT_STATEMENT_INVALID_CURSOR");
});

test("filtros afetam somente itens e nunca alteram os totais canônicos", async t => {
  const f = setup(t);
  const all = await statement(f);
  for (const eventType of ["income", "expense", "invoice_payment", "invoice_payment_reversal"]) {
    const filtered = await statement(f, { eventType });
    assert.ok(filtered.items.length > 0);
    assert.ok(filtered.items.every((item) => item.eventType === eventType));
    assert.deepEqual(filtered.summary, all.summary);
  }
  const smallPage = await statement(f, { limit: 1 });
  assert.deepEqual(smallPage.summary, all.summary);
});

test("datas e filtros inválidos falham fechado e nenhuma projeção futura é permitida", async t => {
  const f = setup(t);
  for (const changes of [
    { from: "2026-02-30" },
    { from: "2026-09-20", to: "2026-09-19" },
    { to: "2026-09-21" },
    { eventType: "settlement" },
  ]) {
    await assert.rejects(statement(f, changes), (error) => error instanceof AccountStatementError && error.status === 400);
  }
});

test("fechamento até hoje é igual ao saldo atual canônico", async t => {
  const f = setup(t);
  const value = await getAccountStatement({ accountId: f.a.account, from: "2026-01-01", to: "2026-09-20" }, context(f));
  const canonical = f.db.prepare(CURRENT_ACCOUNT_BALANCES_SQL)
    .all(f.a.household, "2026-09-20", f.a.household, "2026-09-20", f.a.household)
    .find((row) => row.account_id === f.a.account);
  assert.equal(value.summary.closingBalanceCents, canonical.current_balance_cents);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_ACCOUNT_BALANCES_SQL, FINANCIAL_EVENTS_CTE } from "../lib/finance-analytics.mjs";
import { BillServiceError, cancelRecurringBillSeries, createBill, payBill, undoBillPayment, updateBillOccurrence, updateRecurringBillSeries } from "../lib/bill-service.ts";

const AT = "2026-09-13T02:30:00.000Z";

class LocalStatement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new LocalStatement(this.db, this.sql, bindings);
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.bindings) ?? null;
  }

  async all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: result.changes } };
  }
}

class LocalD1 {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new LocalStatement(this.db, sql);
  }

  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

function seedHousehold(db, suffix) {
  const ids = {
    user: `user_${suffix}`,
    household: `house_${suffix}`,
    account: `account_${suffix}`,
    secondAccount: `account_${suffix}_second`,
    inactiveAccount: `account_${suffix}_inactive`,
    category: `category_${suffix}`,
    categoryWithoutSubs: `category_${suffix}_without_subs`,
    otherCategory: `category_${suffix}_other`,
    inactiveOnlyCategory: `category_${suffix}_inactive_only`,
    subcategory: `subcategory_${suffix}`,
    otherSubcategory: `subcategory_${suffix}_other`,
    inactiveSubcategory: `subcategory_${suffix}_inactive`,
  };
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(ids.user, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(ids.household, `House ${suffix}`, ids.user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member_${suffix}`, ids.household, ids.user, "owner", "active", AT);
  for (const [id, active] of [[ids.account, 1], [ids.secondAccount, 1], [ids.inactiveAccount, 0]]) db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, ids.household, id, "bank", 100_000, active, AT, AT);
  for (const id of [ids.category, ids.categoryWithoutSubs, ids.otherCategory, ids.inactiveOnlyCategory]) db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, ids.household, id, "expense", AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(ids.subcategory, ids.household, ids.category, ids.subcategory, 1, AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(ids.otherSubcategory, ids.household, ids.otherCategory, ids.otherSubcategory, 1, AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(ids.inactiveSubcategory, ids.household, ids.inactiveOnlyCategory, ids.inactiveSubcategory, 0, AT, AT);
  return ids;
}

function context(db, ids) {
  return { d1: new LocalD1(db), householdId: ids.household, userId: ids.user, timestamp: AT };
}

function insertBill(db, ids, overrides = {}) {
  const values = {
    id: `bill_${crypto.randomUUID()}`,
    householdId: ids.household,
    description: "Energia",
    amountCents: 20_000,
    categoryId: ids.category,
    subcategoryId: ids.subcategory,
    accountId: ids.account,
    status: "pending",
    paymentTransactionId: null,
    ...overrides,
  };
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,subcategory_id,due_date,account_id,recurrence,status,payment_transaction_id,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(values.id, values.householdId, values.description, values.amountCents, values.categoryId, values.subcategoryId, "2026-09-20", values.accountId, "none", values.status, values.paymentTransactionId, ids.user, "web", AT, AT);
  return values;
}

function assertBillError(status, code) {
  return (error) => error instanceof BillServiceError && error.status === status && (code === undefined || error.code === code);
}

test("route exige accountId e delega as operações críticas ao serviço", () => {
  const route = readFileSync(new URL("../app/api/finance/advanced/route.ts", import.meta.url), "utf8");
  assert.match(route, /z\.object\(\{ id, accountId: id \}\)/);
  assert.doesNotMatch(route, /parsed\.accountId \?\? bill\.accountId/);
  assert.match(route, /payBill\(parsed, \{ d1: env\.DB, householdId, userId: user\.id, timestamp \}\)/);
  assert.match(route, /undoBillPayment\(parsed\.id, \{ d1: env\.DB, householdId, userId: user\.id, timestamp \}\)/);
  assert.match(route, /changeDueDate: z\.boolean\(\)/);
  assert.match(route, /changeRecurrenceEnd: z\.boolean\(\)/);
  assert.match(route, /dayOfMonth: z\.number\(\).*\.optional\(\)/);
  assert.match(route, /endsOn: dateSchema\.nullable\(\)\.optional\(\)/);
});

test("novas bills exigem categoria e subcategoria ativa quando aplicável", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const b = seedHousehold(db, "b");
  const base = { description: "Conta", amountCents: 1000, dueDate: "2026-09-20", recurrence: "none", accountId: null };
  await assert.rejects(createBill({ ...base }, context(db, a)), assertBillError(400));
  await assert.rejects(createBill({ ...base, categoryId: a.category }, context(db, a)), assertBillError(400));
  await assert.rejects(createBill({ ...base, categoryId: a.inactiveOnlyCategory, subcategoryId: a.inactiveSubcategory }, context(db, a)), assertBillError(400));
  await assert.rejects(createBill({ ...base, categoryId: a.category, subcategoryId: a.otherSubcategory }, context(db, a)), assertBillError(400));
  await assert.rejects(createBill({ ...base, categoryId: a.category, subcategoryId: b.subcategory }, context(db, a)), assertBillError(400));
  db.prepare("UPDATE categories SET is_active=0 WHERE id=?").run(a.categoryWithoutSubs);
  await assert.rejects(createBill({ ...base, categoryId: a.categoryWithoutSubs, subcategoryId: null }, context(db, a)), assertBillError(400));
  db.prepare("UPDATE categories SET is_active=1 WHERE id=?").run(a.categoryWithoutSubs);
  const created = await createBill({ ...base, categoryId: a.categoryWithoutSubs, subcategoryId: null }, context(db, a));
  assert.equal(db.prepare("SELECT subcategory_id FROM bills WHERE id=?").get(created.ids[0]).subcategory_id, null);

  const recurring = await createBill({ ...base, categoryId: a.category, subcategoryId: a.subcategory, recurrence: "monthly", recurrenceEndDate: "2026-11-20" }, context(db, a));
  assert.equal(db.prepare("SELECT subcategory_id FROM recurring_bill_series WHERE id=?").get(recurring.seriesId).subcategory_id, a.subcategory);
  assert.deepEqual(db.prepare("SELECT DISTINCT subcategory_id FROM bills WHERE recurrence_series_id=?").all(recurring.seriesId).map((row) => row.subcategory_id), [a.subcategory]);
});

test("createBill rejeita datas civis inválidas e preserva datas válidas da web", async () => {
  const db = database();
  const a = seedHousehold(db, "date");
  const base = { description: "Conta", amountCents: 1000, categoryId: a.categoryWithoutSubs, subcategoryId: null, recurrence: "none", accountId: null };
  await assert.rejects(createBill({ ...base, dueDate: "2026-02-31" }, context(db, a)), assertBillError(400));
  await assert.rejects(createBill({ ...base, dueDate: "2027-02-29" }, context(db, a)), assertBillError(400));
  const created = await createBill({ ...base, dueDate: "2028-02-29" }, context(db, a));
  assert.equal(db.prepare("SELECT due_date, origin FROM bills WHERE id=?").get(created.ids[0]).due_date, "2028-02-29");
  assert.equal(db.prepare("SELECT due_date, origin FROM bills WHERE id=?").get(created.ids[0]).origin, "web");
});

test("future bill Telegram cria pending com conta nula, auditoria e consumo atômico", async () => {
  const db = database();
  const a = seedHousehold(db, "telegram");
  db.prepare("INSERT INTO telegram_conversation_states(telegram_user_id,household_id,payload_json,expires_at,updated_at) VALUES(?,?,?,?,?)").run("tg-user", a.household, '{"sessionId":"session1234"}', "2026-09-14T13:00:00.000Z", AT);
  const beforeBalance = db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all(a.household, "2026-09-13", a.household, "2026-09-13", a.household).find((row) => row.account_id === a.account).current_balance_cents;
  const result = await createBill({ description: "Camiseta", amountCents: 12_000, dueDate: "2026-10-10", categoryId: a.categoryWithoutSubs, subcategoryId: null, accountId: null, recurrence: "none", notes: null }, {
    ...context(db, a), origin: "telegram", clearTelegramStateFor: "tg-user",
    source: { updateId: "tg-confirm-1", operationId: "session1234", originalUpdateId: "tg-start-1", originalText: "Comprei camiseta e pago mês que vem", telegramUserId: "tg-user", purchaseDate: "2026-09-14" },
  });
  const bill = db.prepare("SELECT status,amount_cents,due_date,account_id,recurrence,created_by_user_id,origin FROM bills WHERE id=?").get(result.ids[0]);
  assert.deepEqual({ ...bill }, { status: "pending", amount_cents: 12_000, due_date: "2026-10-10", account_id: null, recurrence: "none", created_by_user_id: a.user, origin: "telegram" });
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_type='bill' AND entity_id=?").get(result.ids[0]).total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id IN ('tg-confirm-1','financial:session1234')").get().total, 2);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states WHERE telegram_user_id='tg-user'").get().total, 0);
  const afterBalance = db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all(a.household, "2026-09-13", a.household, "2026-09-13", a.household).find((row) => row.account_id === a.account).current_balance_cents;
  assert.equal(afterBalance, beforeBalance);
  assert.equal(db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT count(*) total FROM financial_events`).get(a.household, a.household).total, 0);
  const audit = JSON.parse(db.prepare("SELECT new_data FROM audit_logs WHERE entity_id=?").get(result.ids[0]).new_data);
  assert.equal(audit.source.purchaseDate, "2026-09-14");

  const paid = await payBill({ id: result.ids[0], accountId: a.account }, context(db, a));
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id=? AND payment_method='conta_a_pagar'").get(paid.transactionId).total, 1);
  assert.equal(db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT count(*) total FROM financial_events WHERE payment_method='conta_a_pagar'`).get(a.household, a.household).total, 1);
  await undoBillPayment(result.ids[0], context(db, a));
  assert.equal(db.prepare("SELECT status FROM bills WHERE id=?").get(result.ids[0]).status, "pending");
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id=?").get(paid.transactionId).total, 0);
  const restoredBalance = db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all(a.household, "2026-09-13", a.household, "2026-09-13", a.household).find((row) => row.account_id === a.account).current_balance_cents;
  assert.equal(restoredBalance, beforeBalance);
});

test("idempotência por sessão limita future bill a um registro", async () => {
  const db = database();
  const a = seedHousehold(db, "bill-idempotent");
  const input = { description: "Conta futura", amountCents: 5000, dueDate: "2026-10-20", categoryId: a.categoryWithoutSubs, subcategoryId: null, accountId: null, recurrence: "none" };
  const firstContext = { ...context(db, a), origin: "telegram", source: { updateId: "bill-update-1", operationId: "samebill01", telegramUserId: "tg" } };
  await createBill(input, firstContext);
  await assert.rejects(createBill(input, { ...firstContext, source: { ...firstContext.source, updateId: "bill-update-2" } }), (error) => error instanceof BillServiceError && error.code === "TELEGRAM_UPDATE_ALREADY_PROCESSED");
  assert.equal(db.prepare("SELECT count(*) total FROM bills WHERE household_id=? AND origin='telegram'").get(a.household).total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id='bill-update-2'").get().total, 0);
});

test("falha no batch Telegram não deixa bill, auditoria ou marcador parcial", async () => {
  const db = database();
  const a = seedHousehold(db, "bill-rollback");
  db.prepare("INSERT INTO telegram_conversation_states(telegram_user_id,household_id,payload_json,expires_at,updated_at) VALUES(?,?,?,?,?)").run("tg-rollback", a.household, '{"sessionId":"rollback01"}', "2026-09-14T13:00:00.000Z", AT);
  db.exec("CREATE TRIGGER force_bill_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.entity_type='bill' BEGIN SELECT RAISE(ABORT, 'forced bill audit failure'); END");
  await assert.rejects(createBill({ description: "Falha", amountCents: 1000, dueDate: "2026-10-20", categoryId: a.categoryWithoutSubs, subcategoryId: null, accountId: null, recurrence: "none" }, { ...context(db, a), origin: "telegram", clearTelegramStateFor: "tg-rollback", source: { updateId: "rollback-update", operationId: "rollback01", telegramUserId: "tg-rollback" } }), /forced bill audit failure/);
  assert.equal(db.prepare("SELECT count(*) total FROM bills WHERE household_id=?").get(a.household).total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE household_id=?").get(a.household).total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id IN ('rollback-update','financial:rollback01')").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states WHERE telegram_user_id='tg-rollback'").get().total, 1);
});

test("callback antigo não cria bill nem consome conversation state novo", async () => {
  const db = database();
  const a = seedHousehold(db, "bill-stale");
  db.prepare("INSERT INTO telegram_conversation_states(telegram_user_id,household_id,payload_json,expires_at,updated_at) VALUES(?,?,?,?,?)").run("tg-stale", a.household, '{"sessionId":"newsession"}', "2026-09-14T13:00:00.000Z", AT);
  await assert.rejects(createBill({ description: "Antigo", amountCents: 1000, dueDate: "2026-10-20", categoryId: a.categoryWithoutSubs, subcategoryId: null, accountId: null, recurrence: "none" }, { ...context(db, a), origin: "telegram", clearTelegramStateFor: "tg-stale", source: { updateId: "stale-update", operationId: "oldsession", telegramUserId: "tg-stale" } }), (error) => error instanceof BillServiceError && error.code === "TELEGRAM_UPDATE_ALREADY_PROCESSED");
  assert.equal(db.prepare("SELECT count(*) total FROM bills WHERE household_id=?").get(a.household).total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id IN ('stale-update','financial:oldsession')").get().total, 0);
  assert.equal(JSON.parse(db.prepare("SELECT payload_json FROM telegram_conversation_states WHERE telegram_user_id='tg-stale'").get().payload_json).sessionId, "newsession");
});

test("edição valida classificação e mantém bills legadas legíveis", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const legacy = insertBill(db, a, { categoryId: null, subcategoryId: null });
  assert.deepEqual({ ...db.prepare("SELECT category_id, subcategory_id FROM bills WHERE id=?").get(legacy.id) }, { category_id: null, subcategory_id: null });
  await assert.rejects(updateBillOccurrence({ id: legacy.id, description: "Legado", amountCents: 1000, dueDate: "2026-09-21", categoryId: a.category, subcategoryId: null }, context(db, a)), assertBillError(400));
  await updateBillOccurrence({ id: legacy.id, description: "Legado classificado", amountCents: 1000, dueDate: "2026-09-21", categoryId: a.categoryWithoutSubs, subcategoryId: null }, context(db, a));
  assert.equal(db.prepare("SELECT category_id FROM bills WHERE id=?").get(legacy.id).category_id, a.categoryWithoutSubs);
  const pending = insertBill(db, a);
  await assert.rejects(updateBillOccurrence({ id: pending.id, description: "Categoria trocada", amountCents: 1000, dueDate: "2026-09-21", categoryId: a.otherCategory, subcategoryId: a.subcategory }, context(db, a)), assertBillError(400));

  const paid = insertBill(db, a);
  await payBill({ id: paid.id, accountId: a.account }, context(db, a));
  await assert.rejects(updateBillOccurrence({ id: paid.id, description: "Alterada", amountCents: 1000, dueDate: "2026-09-21", categoryId: a.category, subcategoryId: a.subcategory }, context(db, a)), assertBillError(409));
});

test("edição desta e próximas usa a ocorrência selecionada como âncora e preserva anteriores", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Mensal", amountCents: 3000, dueDate: "2026-09-10", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-11-10" }, context(db, a));
  await updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[1], scope: "future", occurrenceIds: recurring.ids.slice(1), changeDueDate: true, changeRecurrenceEnd: true, description: "Mensal atualizada", amountCents: 3500, dayOfMonth: 25, categoryId: a.otherCategory, subcategoryId: a.otherSubcategory, accountId: null, endsOn: "2026-11-25" }, context(db, a));
  const occurrences = db.prepare("SELECT due_date, description, category_id, subcategory_id, status FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.equal(occurrences[0].due_date, "2026-09-10");
  assert.equal(occurrences[0].description, "Mensal");
  assert.deepEqual(occurrences.slice(1).map((item) => item.due_date), ["2026-10-25", "2026-11-25"]);
  assert.ok(occurrences.every((item) => item.status === "pending"));
  assert.ok(occurrences.slice(1).every((item) => item.category_id === a.otherCategory && item.subcategory_id === a.otherSubcategory));
  assert.deepEqual({ ...db.prepare("SELECT day_of_month, ends_on, subcategory_id FROM recurring_bill_series WHERE id=?").get(recurring.seriesId) }, { day_of_month: 25, ends_on: "2026-11-25", subcategory_id: a.otherSubcategory });

  await cancelRecurringBillSeries(recurring.seriesId, context(db, a));
  const statuses = db.prepare("SELECT due_date, status FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.equal(statuses[0].status, "pending");
  assert.ok(statuses.slice(1).every((item) => item.status === "cancelled"));
  assert.equal(db.prepare("SELECT is_active FROM recurring_bill_series WHERE id=?").get(recurring.seriesId).is_active, 0);
});

test("alterar somente valor nas futuras preserva calendário e janeiro na virada do ano", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Mensal", amountCents: 100, dueDate: "2026-10-13", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2027-01-13" }, context(db, a));
  assert.equal(recurring.ids.length, 4);
  const beforeCount = db.prepare("SELECT count(*) total FROM bills WHERE recurrence_series_id=?").get(recurring.seriesId).total;

  await updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[1], scope: "future", occurrenceIds: recurring.ids.slice(1), changeDueDate: false, changeRecurrenceEnd: false, description: "Mensal", amountCents: 120, dayOfMonth: 14, categoryId: a.category, subcategoryId: a.subcategory, accountId: null, endsOn: "2026-12-13" }, context(db, a));

  const rows = db.prepare("SELECT due_date, recurrence_end_date, status, amount_cents FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.deepEqual(rows.map((row) => row.due_date), ["2026-10-13", "2026-11-13", "2026-12-13", "2027-01-13"]);
  assert.deepEqual(rows.map((row) => row.amount_cents), [100, 120, 120, 120]);
  assert.ok(rows.every((row) => row.status === "pending" && row.recurrence_end_date === "2027-01-13"));
  assert.equal(db.prepare("SELECT count(*) total FROM bills WHERE recurrence_series_id=?").get(recurring.seriesId).total, beforeCount);
  assert.deepEqual({ ...db.prepare("SELECT day_of_month, ends_on FROM recurring_bill_series WHERE id=?").get(recurring.seriesId) }, { day_of_month: 13, ends_on: "2027-01-13" });
});

test("alterar somente o dia nas futuras preserva o limite e não cancela janeiro", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Mensal", amountCents: 100, dueDate: "2026-10-13", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2027-01-13" }, context(db, a));

  await updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[1], scope: "future", occurrenceIds: recurring.ids.slice(1), changeDueDate: true, changeRecurrenceEnd: false, description: "Mensal", amountCents: 100, dayOfMonth: 14, categoryId: a.category, subcategoryId: a.subcategory, accountId: null }, context(db, a));

  const rows = db.prepare("SELECT due_date, recurrence_end_date, status FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.deepEqual(rows.map((row) => row.due_date), ["2026-10-13", "2026-11-14", "2026-12-14", "2027-01-14"]);
  assert.ok(rows.every((row) => row.status === "pending" && row.recurrence_end_date === "2027-01-13"));
  assert.deepEqual({ ...db.prepare("SELECT day_of_month, ends_on FROM recurring_bill_series WHERE id=?").get(recurring.seriesId) }, { day_of_month: 14, ends_on: "2027-01-13" });
});

test("alterar somente o limite preserva datas e não cria novas ocorrências", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Mensal", amountCents: 100, dueDate: "2026-10-13", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2027-01-13" }, context(db, a));

  await updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[1], scope: "future", occurrenceIds: recurring.ids.slice(1), changeDueDate: false, changeRecurrenceEnd: true, description: "Mensal", amountCents: 100, categoryId: a.category, subcategoryId: a.subcategory, accountId: null, endsOn: "2027-02-13" }, context(db, a));

  const rows = db.prepare("SELECT due_date, recurrence_end_date, status FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.deepEqual(rows.map((row) => row.due_date), ["2026-10-13", "2026-11-13", "2026-12-13", "2027-01-13"]);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].recurrence_end_date, "2027-01-13");
  assert.ok(rows.slice(1).every((row) => row.status === "pending" && row.recurrence_end_date === "2027-02-13"));
  assert.deepEqual({ ...db.prepare("SELECT day_of_month, ends_on FROM recurring_bill_series WHERE id=?").get(recurring.seriesId) }, { day_of_month: 13, ends_on: "2027-02-13" });
});

test("reduzir explicitamente o limite cancela somente ocorrências posteriores", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Mensal", amountCents: 100, dueDate: "2026-10-13", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2027-01-13" }, context(db, a));

  await updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[1], scope: "future", occurrenceIds: recurring.ids.slice(1), changeDueDate: false, changeRecurrenceEnd: true, description: "Mensal", amountCents: 120, categoryId: a.category, subcategoryId: a.subcategory, accountId: null, endsOn: "2026-12-13" }, context(db, a));

  const rows = db.prepare("SELECT due_date, status, amount_cents FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { due_date: "2026-10-13", status: "pending", amount_cents: 100 },
    { due_date: "2026-11-13", status: "pending", amount_cents: 120 },
    { due_date: "2026-12-13", status: "pending", amount_cents: 120 },
    { due_date: "2027-01-13", status: "cancelled", amount_cents: 100 },
  ]);
  assert.deepEqual({ ...db.prepare("SELECT day_of_month, ends_on FROM recurring_bill_series WHERE id=?").get(recurring.seriesId) }, { day_of_month: 13, ends_on: "2026-12-13" });
});

test("edição individual e seleção manual alteram somente as ocorrências escolhidas", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Mensal", amountCents: 3000, dueDate: "2026-09-10", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-12-10" }, context(db, a));

  await updateBillOccurrence({ id: recurring.ids[0], description: "Somente setembro", amountCents: 3100, dueDate: "2026-09-12", categoryId: a.category, subcategoryId: a.subcategory, accountId: null }, context(db, a));
  await updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[1], scope: "selected", occurrenceIds: [recurring.ids[1]], changeDueDate: true, changeRecurrenceEnd: false, description: "Somente outubro", amountCents: 3200, dayOfMonth: 15, categoryId: a.category, subcategoryId: a.subcategory, accountId: null }, context(db, a));
  await updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[1], scope: "selected", occurrenceIds: [recurring.ids[1], recurring.ids[3]], changeDueDate: true, changeRecurrenceEnd: false, description: "Outubro e dezembro", amountCents: 3300, dayOfMonth: 18, categoryId: a.otherCategory, subcategoryId: a.otherSubcategory, accountId: a.secondAccount }, context(db, a));

  const occurrences = db.prepare("SELECT id, due_date, description, amount_cents, category_id, subcategory_id, account_id FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.deepEqual(occurrences.map((item) => item.description), ["Somente setembro", "Outubro e dezembro", "Mensal", "Outubro e dezembro"]);
  assert.deepEqual(occurrences.map((item) => item.due_date), ["2026-09-12", "2026-10-18", "2026-11-10", "2026-12-18"]);
  assert.equal(occurrences[1].account_id, a.secondAccount);
  assert.equal(occurrences[3].subcategory_id, a.otherSubcategory);
  assert.equal(db.prepare("SELECT description FROM recurring_bill_series WHERE id=?").get(recurring.seriesId).description, "Mensal");
});

test("seleção manual preserva datas por padrão e altera valores mesmo com duas ocorrências no mesmo mês", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Mensal", amountCents: 3000, dueDate: "2026-09-10", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-12-10" }, context(db, a));
  await updateBillOccurrence({ id: recurring.ids[0], description: "Mensal", amountCents: 3000, dueDate: "2026-10-20", categoryId: a.category, subcategoryId: a.subcategory, accountId: null }, context(db, a));
  const beforeTransactions = db.prepare("SELECT count(*) total FROM transactions").get().total;

  await updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[2], scope: "selected", occurrenceIds: recurring.ids, changeDueDate: false, changeRecurrenceEnd: false, description: "Mensal em lote", amountCents: 7777, dayOfMonth: 10, categoryId: a.otherCategory, subcategoryId: a.otherSubcategory, accountId: null }, context(db, a));

  const rows = db.prepare("SELECT due_date, description, amount_cents FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.deepEqual(rows.map((row) => row.due_date), ["2026-10-10", "2026-10-20", "2026-11-10", "2026-12-10"]);
  assert.ok(rows.every((row) => row.description === "Mensal em lote" && row.amount_cents === 7777));
  assert.equal(db.prepare("SELECT description FROM recurring_bill_series WHERE id=?").get(recurring.seriesId).description, "Mensal");
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, beforeTransactions);
});

test("colisão de datas entre selecionadas retorna 409 amigável sem alteração parcial", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Original", amountCents: 3000, dueDate: "2026-09-10", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-10-10" }, context(db, a));
  await updateBillOccurrence({ id: recurring.ids[0], description: "Original", amountCents: 3000, dueDate: "2026-10-20", categoryId: a.category, subcategoryId: a.subcategory, accountId: null }, context(db, a));
  const before = db.prepare("SELECT id, due_date, description, amount_cents FROM bills WHERE recurrence_series_id=? ORDER BY id").all(recurring.seriesId);

  await assert.rejects(
    updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[0], scope: "selected", occurrenceIds: recurring.ids, changeDueDate: true, changeRecurrenceEnd: false, description: "Não deve persistir", amountCents: 9000, dayOfMonth: 15, categoryId: a.otherCategory, subcategoryId: a.otherSubcategory, accountId: a.secondAccount }, context(db, a)),
    (error) => error instanceof BillServiceError && error.status === 409 && error.code === "BILL_RECURRENCE_DUE_DATE_CONFLICT" && /duas ocorrências.*mesma data/i.test(error.message),
  );
  assert.deepEqual(db.prepare("SELECT id, due_date, description, amount_cents FROM bills WHERE recurrence_series_id=? ORDER BY id").all(recurring.seriesId), before);
  assert.equal(db.prepare("SELECT description FROM recurring_bill_series WHERE id=?").get(recurring.seriesId).description, "Original");
});

test("colisão com ocorrência não selecionada é rejeitada em seleção manual e em futuras", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Original", amountCents: 3000, dueDate: "2026-09-10", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-12-10" }, context(db, a));
  await updateBillOccurrence({ id: recurring.ids[0], description: "Original", amountCents: 3000, dueDate: "2026-10-20", categoryId: a.category, subcategoryId: a.subcategory, accountId: null }, context(db, a));
  const before = db.prepare("SELECT id, due_date, description, amount_cents FROM bills WHERE recurrence_series_id=? ORDER BY id").all(recurring.seriesId);
  const conflictingInput = { id: recurring.seriesId, anchorBillId: recurring.ids[0], occurrenceIds: [recurring.ids[0]], changeDueDate: true, changeRecurrenceEnd: false, description: "Não deve persistir", amountCents: 9000, dayOfMonth: 10, categoryId: a.category, subcategoryId: a.subcategory, accountId: null };

  await assert.rejects(updateRecurringBillSeries({ ...conflictingInput, scope: "selected" }, context(db, a)), assertBillError(409, "BILL_RECURRENCE_DUE_DATE_CONFLICT"));
  await assert.rejects(updateRecurringBillSeries({ ...conflictingInput, scope: "future", occurrenceIds: [recurring.ids[0], recurring.ids[2], recurring.ids[3]] }, context(db, a)), assertBillError(409, "BILL_RECURRENCE_DUE_DATE_CONFLICT"));
  assert.deepEqual(db.prepare("SELECT id, due_date, description, amount_cents FROM bills WHERE recurrence_series_id=? ORDER BY id").all(recurring.seriesId), before);
  assert.equal(db.prepare("SELECT description FROM recurring_bill_series WHERE id=?").get(recurring.seriesId).description, "Original");
});

test("edição em série mantém pagas e canceladas intactas e não cria transações", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Mensal", amountCents: 3000, dueDate: "2026-09-10", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-12-10" }, context(db, a));
  await payBill({ id: recurring.ids[1], accountId: a.account }, context(db, a));
  db.prepare("UPDATE bills SET status='cancelled' WHERE id=?").run(recurring.ids[2]);
  const transactionCount = db.prepare("SELECT count(*) total FROM transactions").get().total;
  const paidPaymentId = db.prepare("SELECT payment_transaction_id FROM bills WHERE id=?").get(recurring.ids[1]).payment_transaction_id;

  await updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[0], scope: "future", occurrenceIds: [recurring.ids[0], recurring.ids[3]], changeDueDate: true, changeRecurrenceEnd: false, description: "Pendentes atualizados", amountCents: 3500, dayOfMonth: 20, categoryId: a.otherCategory, subcategoryId: a.otherSubcategory, accountId: null }, context(db, a));

  const occurrences = db.prepare("SELECT id, due_date, description, status, payment_transaction_id FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.equal(occurrences.find((item) => item.id === recurring.ids[0]).description, "Pendentes atualizados");
  assert.deepEqual({ ...occurrences.find((item) => item.id === recurring.ids[1]) }, { id: recurring.ids[1], due_date: "2026-10-10", description: "Mensal", status: "paid", payment_transaction_id: paidPaymentId });
  assert.ok(paidPaymentId);
  assert.equal(occurrences.find((item) => item.id === recurring.ids[2]).status, "cancelled");
  assert.equal(occurrences.find((item) => item.id === recurring.ids[2]).description, "Mensal");
  assert.equal(occurrences.find((item) => item.id === recurring.ids[3]).description, "Pendentes atualizados");
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, transactionCount);
});

test("seleção recorrente rejeita vazio, outra série, outro household e classificação ou conta inválida", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const b = seedHousehold(db, "b");
  const first = await createBill({ description: "A", amountCents: 3000, dueDate: "2026-09-10", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-10-10" }, context(db, a));
  const second = await createBill({ description: "B", amountCents: 4000, dueDate: "2026-09-15", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-10-15" }, context(db, a));
  const foreign = await createBill({ description: "Estrangeira", amountCents: 5000, dueDate: "2026-09-20", categoryId: b.category, subcategoryId: b.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-10-20" }, context(db, b));
  const base = { id: first.seriesId, anchorBillId: first.ids[0], scope: "selected", changeDueDate: false, changeRecurrenceEnd: false, description: "Alterada", amountCents: 3500, dayOfMonth: 21, categoryId: a.category, subcategoryId: a.subcategory, accountId: null };

  await assert.rejects(updateRecurringBillSeries({ ...base, occurrenceIds: [] }, context(db, a)), assertBillError(400));
  await assert.rejects(updateRecurringBillSeries({ ...base, occurrenceIds: [second.ids[0]] }, context(db, a)), assertBillError(409, "BILL_RECURRENCE_SELECTION_CHANGED"));
  await assert.rejects(updateRecurringBillSeries({ ...base, occurrenceIds: [foreign.ids[0]] }, context(db, a)), assertBillError(409, "BILL_RECURRENCE_SELECTION_CHANGED"));
  await assert.rejects(updateRecurringBillSeries({ ...base, occurrenceIds: [first.ids[0]], categoryId: a.otherCategory, subcategoryId: a.subcategory }, context(db, a)), assertBillError(400));
  await assert.rejects(updateRecurringBillSeries({ ...base, occurrenceIds: [first.ids[0]], accountId: b.account }, context(db, a)), assertBillError(400));
  assert.equal(db.prepare("SELECT description FROM bills WHERE id=?").get(first.ids[0]).description, "A");
});

test("mudança concorrente de status rejeita o lote inteiro e preserva a série", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Original", amountCents: 3000, dueDate: "2026-09-10", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-11-10" }, context(db, a));
  class ConcurrentStatusD1 extends LocalD1 {
    async batch(statements) {
      db.prepare("UPDATE bills SET status='cancelled' WHERE id=?").run(recurring.ids[1]);
      return super.batch(statements);
    }
  }
  const concurrentContext = { ...context(db, a), d1: new ConcurrentStatusD1(db) };

  await assert.rejects(updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[0], scope: "future", occurrenceIds: recurring.ids, changeDueDate: true, changeRecurrenceEnd: false, description: "Não deve persistir", amountCents: 9000, dayOfMonth: 25, categoryId: a.otherCategory, subcategoryId: a.otherSubcategory, accountId: a.secondAccount }, concurrentContext), assertBillError(409, "BILL_RECURRENCE_SELECTION_CHANGED"));
  const rows = db.prepare("SELECT id, description, amount_cents, status FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.equal(rows[0].description, "Original");
  assert.equal(rows[2].description, "Original");
  assert.equal(rows[1].status, "cancelled");
  assert.equal(db.prepare("SELECT description FROM recurring_bill_series WHERE id=?").get(recurring.seriesId).description, "Original");
});

test("edição recorrente preserva payment_transaction_id existente e aceita Definir ao pagar", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Mensal", amountCents: 3000, dueDate: "2026-09-10", categoryId: a.category, subcategoryId: a.subcategory, accountId: a.account, recurrence: "monthly", recurrenceEndDate: "2026-10-10" }, context(db, a));
  db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,account_id,payment_method,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("linked_pending", a.household, "expense", 1, "Vínculo legado", "2026-09-01", a.user, a.account, "cash", "confirmed", "dashboard", AT, AT);
  db.prepare("UPDATE bills SET payment_transaction_id='linked_pending' WHERE id=?").run(recurring.ids[0]);
  const beforeTransactions = db.prepare("SELECT count(*) total FROM transactions").get().total;

  await updateRecurringBillSeries({ id: recurring.seriesId, anchorBillId: recurring.ids[0], scope: "selected", occurrenceIds: [recurring.ids[0]], changeDueDate: false, changeRecurrenceEnd: false, description: "Sem conta definida", amountCents: 3100, dayOfMonth: 22, categoryId: a.categoryWithoutSubs, subcategoryId: null, accountId: null }, context(db, a));
  const bill = db.prepare("SELECT account_id, category_id, subcategory_id, payment_transaction_id FROM bills WHERE id=?").get(recurring.ids[0]);
  assert.deepEqual({ ...bill }, { account_id: null, category_id: a.categoryWithoutSubs, subcategory_id: null, payment_transaction_id: "linked_pending" });
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, beforeTransactions);
});

test("pay_bill rejeita conta ausente, inválida, inativa ou de outro household", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const b = seedHousehold(db, "b");
  const bill = insertBill(db, a);
  await assert.rejects(payBill({ id: bill.id }, context(db, a)), assertBillError(400));
  await assert.rejects(payBill({ id: bill.id, accountId: "missing" }, context(db, a)), assertBillError(400));
  await assert.rejects(payBill({ id: bill.id, accountId: a.inactiveAccount }, context(db, a)), assertBillError(400));
  await assert.rejects(payBill({ id: bill.id, accountId: b.account }, context(db, a)), assertBillError(400));
  const foreignBill = insertBill(db, b);
  await assert.rejects(payBill({ id: foreignBill.id, accountId: a.account }, context(db, a)), assertBillError(404));
});

test("somente bill pending e classificada pode ser paga", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const cancelled = insertBill(db, a, { status: "cancelled" });
  const legacy = insertBill(db, a, { categoryId: null, subcategoryId: null });
  await assert.rejects(payBill({ id: cancelled.id, accountId: a.account }, context(db, a)), assertBillError(409));
  await assert.rejects(payBill({ id: legacy.id, accountId: a.account }, context(db, a)), assertBillError(409, "BILL_CLASSIFICATION_REQUIRED"));
  const paid = insertBill(db, a);
  await payBill({ id: paid.id, accountId: a.account }, context(db, a));
  await assert.rejects(payBill({ id: paid.id, accountId: a.account }, context(db, a)), assertBillError(409));
});

test("pagamento atômico usa a conta confirmada e copia classificação e responsável", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const bill = insertBill(db, a, { accountId: a.account });
  const result = await payBill({ id: bill.id, accountId: a.secondAccount }, context(db, a));
  const transaction = db.prepare("SELECT * FROM transactions WHERE id=?").get(result.transactionId);
  assert.equal(transaction.account_id, a.secondAccount);
  assert.equal(transaction.category_id, a.category);
  assert.equal(transaction.subcategory_id, a.subcategory);
  assert.equal(transaction.responsible_user_id, a.user);
  assert.equal(transaction.payment_method, "conta_a_pagar");
  assert.equal(transaction.transaction_date, "2026-09-12");
  const storedBill = db.prepare("SELECT status, account_id, payment_transaction_id, paid_at FROM bills WHERE id=?").get(bill.id);
  assert.deepEqual({ ...storedBill }, { status: "paid", account_id: a.secondAccount, payment_transaction_id: result.transactionId, paid_at: AT });
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE payment_method='conta_a_pagar'").get().total, 1);
});

test("duas tentativas concorrentes criam exatamente uma transaction", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const bill = insertBill(db, a);
  const attempts = await Promise.allSettled([
    payBill({ id: bill.id, accountId: a.account }, context(db, a)),
    payBill({ id: bill.id, accountId: a.account }, context(db, a)),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE payment_method='conta_a_pagar'").get().total, 1);
  assert.equal(db.prepare("SELECT status FROM bills WHERE id=?").get(bill.id).status, "paid");
});

test("falha na atualização da bill reverte a transaction do mesmo batch", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const bill = insertBill(db, a);
  db.exec("CREATE TRIGGER force_bill_payment_failure BEFORE UPDATE OF status ON bills WHEN NEW.status='paid' BEGIN SELECT RAISE(ABORT, 'forced payment failure'); END");
  await assert.rejects(payBill({ id: bill.id, accountId: a.account }, context(db, a)), /forced payment failure/);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE payment_method='conta_a_pagar'").get().total, 0);
  assert.equal(db.prepare("SELECT status, payment_transaction_id FROM bills WHERE id=?").get(bill.id).status, "pending");
  assert.equal(db.prepare("SELECT payment_transaction_id FROM bills WHERE id=?").get(bill.id).payment_transaction_id, null);
});

test("undo remove somente a transaction vinculada e restaura bill, saldo e analytics", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const bill = insertBill(db, a);
  db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,account_id,payment_method,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("unrelated", a.household, "expense", 500, "Outra", "2026-09-12", a.user, a.account, "cash", "confirmed", "dashboard", AT, AT);
  const paid = await payBill({ id: bill.id, accountId: a.account }, context(db, a));
  const paidEvents = db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT count(*) total FROM financial_events WHERE payment_method='conta_a_pagar'`).get(a.household, a.household);
  const paidBalance = db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all(a.household, "2026-09-12", a.household, "2026-09-12", a.household).find((row) => row.account_id === a.account).current_balance_cents;
  assert.equal(paidEvents.total, 1);
  assert.equal(paidBalance, 79_500);

  const undone = await undoBillPayment(bill.id, context(db, a));
  assert.equal(undone.transactionId, paid.transactionId);
  assert.deepEqual({ ...db.prepare("SELECT status, paid_at, payment_transaction_id FROM bills WHERE id=?").get(bill.id) }, { status: "pending", paid_at: null, payment_transaction_id: null });
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id=?").get(paid.transactionId).total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id='unrelated'").get().total, 1);
  const undoneEvents = db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT count(*) total FROM financial_events WHERE payment_method='conta_a_pagar'`).get(a.household, a.household);
  const undoneBalance = db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all(a.household, "2026-09-12", a.household, "2026-09-12", a.household).find((row) => row.account_id === a.account).current_balance_cents;
  assert.equal(undoneEvents.total, 0);
  assert.equal(undoneBalance, 99_500);
  await assert.rejects(undoBillPayment(bill.id, context(db, a)), assertBillError(409));
});

test("undo rejeita household diferente e vínculo inconsistente sem excluir dados", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const b = seedHousehold(db, "b");
  const bill = insertBill(db, a);
  const paid = await payBill({ id: bill.id, accountId: a.account }, context(db, a));
  await assert.rejects(undoBillPayment(bill.id, context(db, b)), assertBillError(404));
  db.prepare("UPDATE transactions SET amount_cents=amount_cents+1 WHERE id=?").run(paid.transactionId);
  await assert.rejects(undoBillPayment(bill.id, context(db, a)), assertBillError(409, "BILL_PAYMENT_INCONSISTENT"));
  assert.equal(db.prepare("SELECT status FROM bills WHERE id=?").get(bill.id).status, "paid");
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id=?").get(paid.transactionId).total, 1);
});

test("falha ao remover a transaction reverte toda a operação de undo", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const bill = insertBill(db, a);
  const paid = await payBill({ id: bill.id, accountId: a.account }, context(db, a));
  db.exec(`CREATE TRIGGER force_bill_undo_failure BEFORE DELETE ON transactions WHEN OLD.id='${paid.transactionId}' BEGIN SELECT RAISE(ABORT, 'forced undo failure'); END`);
  await assert.rejects(undoBillPayment(bill.id, context(db, a)), /forced undo failure/);
  const storedBill = db.prepare("SELECT status, payment_transaction_id FROM bills WHERE id=?").get(bill.id);
  assert.equal(storedBill.status, "paid");
  assert.equal(storedBill.payment_transaction_id, paid.transactionId);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id=?").get(paid.transactionId).total, 1);
});

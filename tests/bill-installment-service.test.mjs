import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BillInstallmentServiceError, createBillInstallmentSeries } from "../lib/bill-installment-service.ts";
import { cancelBillOccurrence, createBill, payBill, undoBillPayment, updateBillOccurrence } from "../lib/bill-service.ts";
import { billTiming, paidBillsForSelectedMonth } from "../lib/bill-ui-rules.mjs";

const AT = "2026-09-23T12:00:00.000Z";
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

class LocalStatement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new LocalStatement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  runSync() { const statement = this.db.prepare(this.sql); if (statement.columns().length) return { success: true, results: statement.all(...this.bindings), meta: { changes: 0 } }; const result = statement.run(...this.bindings); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
  async run() { return this.runSync(); }
}

class LocalD1 {
  constructor(db) { this.db = db; this.beforeStatement = null; }
  prepare(sql) { return new LocalStatement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (this.beforeStatement) this.beforeStatement(statements[index], index);
        results.push(statements[index].runSync());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function database(t) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) {
    const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const sql of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(sql);
  }
  t.after(() => { assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0); assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); db.close(); });
  return db;
}

function seedHousehold(db, suffix) {
  const ids = { user: `user-${suffix}`, household: `house-${suffix}`, category: `category-${suffix}`, categoryNoSubs: `category-no-subs-${suffix}`, subcategory: `subcategory-${suffix}`, account: `account-${suffix}`, inactiveAccount: `inactive-${suffix}` };
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(ids.user, ids.user, `${ids.user}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(ids.household, ids.household, ids.user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, ids.household, ids.user, "owner", "active", AT);
  for (const category of [ids.category, ids.categoryNoSubs]) db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(category, ids.household, category, "expense", 1, AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(ids.subcategory, ids.household, ids.category, ids.subcategory, 1, AT, AT);
  for (const [account, active] of [[ids.account, 1], [ids.inactiveAccount, 0]]) db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(account, ids.household, account, "bank", 100000, active, AT, AT);
  return ids;
}

function context(db, ids) { return { d1: new LocalD1(db), householdId: ids.household, userId: ids.user, timestamp: AT }; }

function input(ids, overrides = {}) {
  return { operationId: `operation-${crypto.randomUUID()}`, description: "Móveis", totalAmountCents: 500000, installmentCount: 3, firstDueDate: "2026-10-23", categoryId: ids.category, subcategoryId: ids.subcategory, accountId: ids.account, notes: "Contrato", ...overrides };
}

function counts(db) {
  return Object.fromEntries(["bill_installment_series", "bill_installment_occurrences", "bills", "transactions", "audit_logs"].map((table) => [table, db.prepare(`SELECT count(*) total FROM ${table}`).get().total]));
}

test("cria contrato, bills e associações em ordem sem gerar transaction", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  const result = await createBillInstallmentSeries(input(ids, { operationId: "create-series" }), context(db, ids));
  assert.equal(result.replayed, false); assert.equal(result.billIds.length, 3);
  assert.deepEqual(result.plan.map((item) => item.amountCents), [166666, 166667, 166667]);
  assert.deepEqual(result.plan.map((item) => item.dueDate), ["2026-10-23", "2026-11-23", "2026-12-23"]);
  const series = db.prepare("SELECT * FROM bill_installment_series WHERE id=?").get(result.seriesId);
  assert.equal(series.household_id, ids.household); assert.equal(series.total_amount_cents, 500000); assert.equal(series.configured_day, 23); assert.equal(series.idempotency_key, "create-series");
  const bills = db.prepare("SELECT id,description,amount_cents,due_date,recurrence,status,category_id,subcategory_id,account_id,notes,origin FROM bills ORDER BY due_date").all();
  assert.equal(bills.length, 3); assert.ok(bills.every((bill) => bill.description === "Móveis" && bill.recurrence === "none" && bill.status === "pending" && bill.category_id === ids.category && bill.subcategory_id === ids.subcategory && bill.account_id === ids.account && bill.notes === "Contrato" && bill.origin === "web"));
  assert.deepEqual(db.prepare("SELECT installment_number,bill_id FROM bill_installment_occurrences ORDER BY installment_number").all().map((row) => row.installment_number), [1, 2, 3]);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  const audit = db.prepare("SELECT action,entity_type,entity_id,new_data FROM audit_logs").get();
  assert.equal(audit.action, "create"); assert.equal(audit.entity_type, "bill_installment_series"); assert.equal(audit.entity_id, result.seriesId); assert.equal(JSON.parse(audit.new_data).plan.length, 3);
});

test("retry com mesma chave e payload retorna replay sem duplicar", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const request = input(ids, { operationId: "same-operation" });
  const first = await createBillInstallmentSeries(request, context(db, ids)); const replay = await createBillInstallmentSeries({ ...request }, context(db, ids));
  assert.equal(replay.replayed, true); assert.equal(replay.seriesId, first.seriesId); assert.deepEqual(replay.billIds, first.billIds); assert.deepEqual(counts(db), { bill_installment_series: 1, bill_installment_occurrences: 3, bills: 3, transactions: 0, audit_logs: 1 });
});

test("mesma chave com contrato diferente retorna conflito 409", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const request = input(ids, { operationId: "conflict-operation" });
  await createBillInstallmentSeries(request, context(db, ids));
  await assert.rejects(createBillInstallmentSeries({ ...request, notes: "diferente" }, context(db, ids)), (error) => error instanceof BillInstallmentServiceError && error.status === 409 && error.code === "BILL_INSTALLMENT_IDEMPOTENCY_CONFLICT");
  assert.equal(counts(db).bill_installment_series, 1);
});

test("falha intermediária faz rollback de série, bills, associações e auditoria", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const ctx = context(db, ids);
  ctx.d1.beforeStatement = (_statement, index) => { if (index === 4) throw new Error("forced middle failure"); };
  await assert.rejects(createBillInstallmentSeries(input(ids), ctx), /forced middle failure/);
  assert.deepEqual(counts(db), { bill_installment_series: 0, bill_installment_occurrences: 0, bills: 0, transactions: 0, audit_logs: 0 });
});

test("membership, categoria, subcategoria e conta respeitam household e atividade", async (t) => {
  const db = database(t); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  for (const overrides of [
    { categoryId: b.category, subcategoryId: b.subcategory },
    { subcategoryId: b.subcategory },
    { accountId: b.account },
    { accountId: a.inactiveAccount },
  ]) await assert.rejects(createBillInstallmentSeries(input(a, overrides), context(db, a)), (error) => error instanceof BillInstallmentServiceError && error.status === 400);
  db.prepare("UPDATE household_members SET status='inactive' WHERE household_id=? AND user_id=?").run(a.household, a.user);
  await assert.rejects(createBillInstallmentSeries(input(a), context(db, a)), (error) => error instanceof BillInstallmentServiceError && error.status === 403);
  assert.equal(counts(db).bill_installment_series, 0);
});

test("service rejeita total, quantidade, data e operationId inválidos", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  for (const overrides of [{ totalAmountCents: 1 }, { totalAmountCents: 100_000_000_001 }, { installmentCount: 1 }, { installmentCount: 121 }, { firstDueDate: "2027-02-29" }, { operationId: "" }]) {
    await assert.rejects(createBillInstallmentSeries(input(ids, overrides), context(db, ids)), (error) => error instanceof BillInstallmentServiceError && error.status === 400);
  }
  assert.equal(counts(db).bill_installment_series, 0);
});

test("pagamento, desconto, acréscimo e estorno permanecem isolados por parcela", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const ctx = context(db, ids);
  const created = await createBillInstallmentSeries(input(ids, { operationId: "payments", totalAmountCents: 30000, firstDueDate: "2026-08-23" }), ctx);
  const [first, second] = created.billIds;
  const discount = await payBill({ id: first, accountId: ids.account, paidAmountCents: 9500, paidOn: "2026-09-20", expectedAmountCents: 10000, operationId: "discount-payment", differenceTreatment: "discount" }, ctx);
  assert.equal(db.prepare("SELECT amount_cents FROM transactions WHERE id=?").get(discount.transactionId).amount_cents, 9500);
  assert.deepEqual(db.prepare("SELECT status FROM bills ORDER BY due_date").all().map((row) => row.status), ["paid", "pending", "pending"]);
  assert.equal(db.prepare("SELECT total_amount_cents FROM bill_installment_series WHERE id=?").get(created.seriesId).total_amount_cents, 30000);
  const firstBillForUi = { id: first, status: "paid", dueDate: "2026-08-23", payment: { paidOn: "2026-09-20" } };
  assert.deepEqual(paidBillsForSelectedMonth([firstBillForUi], "2026-08", "due").map((bill) => bill.id), [first]);
  assert.deepEqual(paidBillsForSelectedMonth([firstBillForUi], "2026-09", "payment").map((bill) => bill.id), [first]);
  await undoBillPayment(first, ctx);
  assert.equal(db.prepare("SELECT status FROM bills WHERE id=?").get(first).status, "pending"); assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id=?").get(discount.transactionId).total, 0);
  assert.equal(billTiming({ status: "pending", dueDate: "2026-08-23" }, "2026-09-23"), "overdue");
  const surcharge = await payBill({ id: second, accountId: ids.account, paidAmountCents: 10500, paidOn: "2026-09-20", expectedAmountCents: 10000, operationId: "surcharge-payment", differenceTreatment: null }, ctx);
  assert.equal(db.prepare("SELECT amount_cents FROM transactions WHERE id=?").get(surcharge.transactionId).amount_cents, 10500);
  assert.equal(db.prepare("SELECT status FROM bills WHERE id=?").get(first).status, "pending");
  assert.equal(db.prepare("SELECT amount_cents FROM bills WHERE id=?").get(created.billIds[2]).amount_cents, 10000);
});

test("edição e cancelamento individuais não alteram contrato nem outras parcelas", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const ctx = context(db, ids);
  const created = await createBillInstallmentSeries(input(ids, { operationId: "individual-actions", totalAmountCents: 30000 }), ctx);
  await updateBillOccurrence({ id: created.billIds[0], description: "Móveis ajustados", amountCents: 9000, dueDate: "2026-10-25", categoryId: ids.categoryNoSubs, subcategoryId: null, accountId: null, notes: null }, ctx);
  await cancelBillOccurrence(created.billIds[1], ctx);
  assert.equal(db.prepare("SELECT total_amount_cents FROM bill_installment_series WHERE id=?").get(created.seriesId).total_amount_cents, 30000);
  assert.deepEqual(db.prepare("SELECT amount_cents,status FROM bills ORDER BY due_date").all().map((row) => ({ ...row })), [{ amount_cents: 9000, status: "pending" }, { amount_cents: 10000, status: "cancelled" }, { amount_cents: 10000, status: "pending" }]);
});

test("recorrência existente continua separada do parcelamento", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const ctx = context(db, ids);
  const recurring = await createBill({ description: "Internet", amountCents: 11990, dueDate: "2026-10-10", categoryId: ids.categoryNoSubs, subcategoryId: null, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-12-10" }, ctx);
  assert.equal(recurring.ids.length, 3); assert.ok(recurring.seriesId);
  assert.equal(db.prepare("SELECT count(*) total FROM bill_installment_series").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM bill_installment_occurrences").get().total, 0);
});

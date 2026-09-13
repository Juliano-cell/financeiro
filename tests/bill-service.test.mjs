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

test("edição e cancelamento de série preservam ocorrências passadas e propagam subcategoria às futuras", async () => {
  const db = database();
  const a = seedHousehold(db, "a");
  const recurring = await createBill({ description: "Mensal", amountCents: 3000, dueDate: "2026-09-10", categoryId: a.category, subcategoryId: a.subcategory, accountId: null, recurrence: "monthly", recurrenceEndDate: "2026-11-10" }, context(db, a));
  await updateRecurringBillSeries({ id: recurring.seriesId, description: "Mensal atualizada", amountCents: 3500, dayOfMonth: 25, categoryId: a.otherCategory, subcategoryId: a.otherSubcategory, accountId: null, endsOn: "2026-11-25" }, context(db, a));
  const occurrences = db.prepare("SELECT due_date, description, category_id, subcategory_id, status FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.equal(occurrences[0].due_date, "2026-09-10");
  assert.equal(occurrences[0].description, "Mensal");
  assert.equal(occurrences[1].due_date, "2026-10-25");
  assert.equal(occurrences[1].category_id, a.otherCategory);
  assert.equal(occurrences[1].subcategory_id, a.otherSubcategory);
  assert.equal(db.prepare("SELECT subcategory_id FROM recurring_bill_series WHERE id=?").get(recurring.seriesId).subcategory_id, a.otherSubcategory);

  await cancelRecurringBillSeries(recurring.seriesId, context(db, a));
  const statuses = db.prepare("SELECT due_date, status FROM bills WHERE recurrence_series_id=? ORDER BY due_date").all(recurring.seriesId);
  assert.equal(statuses[0].status, "pending");
  assert.ok(statuses.slice(1).every((item) => item.status === "cancelled"));
  assert.equal(db.prepare("SELECT is_active FROM recurring_bill_series WHERE id=?").get(recurring.seriesId).is_active, 0);
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

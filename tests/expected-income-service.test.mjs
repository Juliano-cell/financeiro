import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  cancelExpectedIncome,
  createExpectedIncome,
  createRecurringExpectedIncome,
  ExpectedIncomeServiceError,
  materializeExpectedIncomeSeries,
  receiveExpectedIncome,
  reverseExpectedIncomeReceipt,
  updateExpectedIncome,
} from "../lib/expected-income-service.ts";
import {
  buildExpectedIncomeMaterializationPlan,
  canonicalExpectedIncomeRequest,
  expectedIncomeTiming,
} from "../lib/expected-income-rules.mjs";
import { CURRENT_ACCOUNT_BALANCES_SQL } from "../lib/finance-analytics.mjs";

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
  t.after(() => {
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    db.close();
  });
  return db;
}

function seedHousehold(db, suffix) {
  const ids = {
    user: `user-${suffix}`,
    household: `house-${suffix}`,
    account: `account-${suffix}`,
    otherAccount: `other-account-${suffix}`,
    inactiveAccount: `inactive-account-${suffix}`,
    incomeCategory: `income-${suffix}`,
    bothCategory: `both-${suffix}`,
    expenseCategory: `expense-${suffix}`,
    subcategory: `subcategory-${suffix}`,
  };
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(ids.user, ids.user, `${ids.user}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(ids.household, ids.household, ids.user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, ids.household, ids.user, "owner", "active", AT);
  for (const [account, active] of [[ids.account, 1], [ids.otherAccount, 1], [ids.inactiveAccount, 0]]) {
    db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(account, ids.household, account, "bank", 100000, active, AT, AT);
  }
  for (const [category, type] of [[ids.incomeCategory, "income"], [ids.bothCategory, "both"], [ids.expenseCategory, "expense"]]) {
    db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(category, ids.household, category, type, 1, AT, AT);
  }
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(ids.subcategory, ids.household, ids.incomeCategory, ids.subcategory, 1, AT, AT);
  return ids;
}

function context(db, ids, overrides = {}) {
  return { d1: new LocalD1(db), householdId: ids.household, userId: ids.user, timestamp: AT, ...overrides };
}

function uniqueInput(ids, overrides = {}) {
  return { operationId: `operation-${crypto.randomUUID()}`, description: "Diária Alessandra", expectedAmountCents: 20000, expectedDate: "2026-09-25", plannedAccountId: ids.account, categoryId: ids.incomeCategory, subcategoryId: ids.subcategory, notes: "Plantão", ...overrides };
}

function recurringInput(ids, overrides = {}) {
  return { operationId: `operation-${crypto.randomUUID()}`, description: "Salário", expectedAmountCents: 302000, configuredDay: 31, startsOn: "2026-10-31", endsOn: null, plannedAccountId: ids.account, categoryId: ids.bothCategory, subcategoryId: null, notes: null, ...overrides };
}

function balance(db, ids, accountId = ids.account, through = "2026-09-23") {
  return db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all(ids.household, through, ids.household, through, ids.household).find((row) => row.account_id === accountId).current_balance_cents;
}

function counts(db) {
  return Object.fromEntries(["expected_income_series", "expected_income_occurrences", "expected_income_operations", "transactions", "audit_logs"].map((table) => [table, db.prepare(`SELECT count(*) total FROM ${table}`).get().total]));
}

async function createOne(db, ids, overrides = {}) {
  return createExpectedIncome(uniqueInput(ids, overrides), context(db, ids));
}

test("regras puras cobrem 29/30/31, fevereiro comum/bissexto, virada do ano e ends_on", () => {
  const common = buildExpectedIncomeMaterializationPlan({ startsOn: "2027-01-31", configuredDay: 31, endsOn: "2027-05-31" });
  assert.deepEqual(common.occurrences.map((row) => row.expectedDate), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
  const leap = buildExpectedIncomeMaterializationPlan({ startsOn: "2028-01-31", configuredDay: 31, throughMonth: "2028-03" });
  assert.deepEqual(leap.occurrences.map((row) => row.expectedDate), ["2028-01-31", "2028-02-29", "2028-03-31"]);
  const year = buildExpectedIncomeMaterializationPlan({ startsOn: "2026-12-30", configuredDay: 30, throughMonth: "2027-02" });
  assert.deepEqual(year.occurrences.map((row) => row.expectedDate), ["2026-12-30", "2027-01-30", "2027-02-28"]);
  assert.throws(() => buildExpectedIncomeMaterializationPlan({ startsOn: "2027-02-27", configuredDay: 31 }), /não corresponde/iu);
});

test("fingerprint canônico independe da ordem das propriedades", () => {
  assert.equal(canonicalExpectedIncomeRequest("receive", { b: 2, a: 1 }), canonicalExpectedIncomeRequest("receive", { a: 1, b: 2 }));
});

test("create única grava pending, operation e audit sem transaction ou impacto no saldo", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const before = balance(db, ids);
  const result = await createExpectedIncome(uniqueInput(ids, { operationId: "create-one" }), context(db, ids));
  assert.equal(result.replayed, false);
  const row = db.prepare("SELECT * FROM expected_income_occurrences WHERE id=?").get(result.occurrenceId);
  assert.equal(row.status, "pending"); assert.equal(row.expected_amount_cents, 20000); assert.equal(row.series_id, null); assert.equal(row.received_transaction_id, null);
  assert.equal(balance(db, ids), before); assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT operation_type FROM expected_income_operations").get().operation_type, "create_occurrence");
  assert.equal(db.prepare("SELECT action FROM audit_logs WHERE entity_type='expected_income_occurrence'").get().action, "create");
});

test("create aceita conta planejada nula e categoria opcional", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  const result = await createOne(db, ids, { plannedAccountId: null, categoryId: null, subcategoryId: null, notes: null });
  const row = db.prepare("SELECT planned_account_id,category_id,subcategory_id FROM expected_income_occurrences WHERE id=?").get(result.occurrenceId);
  assert.deepEqual({ ...row }, { planned_account_id: null, category_id: null, subcategory_id: null });
});

test("create recorrente materializa 24 meses, snapshots independentes e cursor", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  const result = await createRecurringExpectedIncome(recurringInput(ids, { operationId: "series-24" }), context(db, ids));
  assert.equal(result.occurrences.length, 24); assert.equal(result.materializedThroughMonth, "2028-09");
  const series = db.prepare("SELECT configured_day,materialized_through_month FROM expected_income_series WHERE id=?").get(result.seriesId);
  assert.deepEqual({ ...series }, { configured_day: 31, materialized_through_month: "2028-09" });
  const dates = db.prepare("SELECT expected_date FROM expected_income_occurrences WHERE series_id=? ORDER BY expected_date LIMIT 5").all(result.seriesId).map((row) => row.expected_date);
  assert.deepEqual(dates, ["2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
});

test("ends_on limita ocorrências e cursor sem ultrapassar o contrato", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  const result = await createRecurringExpectedIncome(recurringInput(ids, { operationId: "bounded", endsOn: "2027-02-28" }), context(db, ids));
  assert.equal(result.occurrences.length, 5); assert.equal(result.materializedThroughMonth, "2027-02");
  assert.equal(db.prepare("SELECT max(expected_date) date FROM expected_income_occurrences").get().date, "2027-02-28");
});

test("retry de criação e série é seguro; payload diferente conflita", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const ctx = context(db, ids);
  const request = uniqueInput(ids, { operationId: "same-create" });
  const first = await createExpectedIncome(request, ctx); const replay = await createExpectedIncome({ ...request }, ctx);
  assert.equal(replay.replayed, true); assert.equal(replay.occurrenceId, first.occurrenceId);
  await assert.rejects(createExpectedIncome({ ...request, expectedAmountCents: 20001 }, ctx), (error) => error instanceof ExpectedIncomeServiceError && error.status === 409);
  const seriesRequest = recurringInput(ids, { operationId: "same-series", endsOn: "2026-12-31" });
  const series = await createRecurringExpectedIncome(seriesRequest, ctx); const seriesReplay = await createRecurringExpectedIncome({ ...seriesRequest }, ctx);
  assert.equal(seriesReplay.replayed, true); assert.equal(seriesReplay.seriesId, series.seriesId);
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_series").get().total, 1);
});

test("membership, conta, categorias income/both e subcategoria respeitam atividade e household", async (t) => {
  const db = database(t); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  assert.equal((await createOne(db, a, { categoryId: a.bothCategory, subcategoryId: null })).replayed, false);
  for (const overrides of [
    { plannedAccountId: a.inactiveAccount },
    { plannedAccountId: b.account },
    { categoryId: a.expenseCategory, subcategoryId: null },
    { categoryId: b.incomeCategory, subcategoryId: b.subcategory },
    { subcategoryId: b.subcategory },
  ]) await assert.rejects(createOne(db, a, overrides), (error) => error instanceof ExpectedIncomeServiceError && error.status === 400);
  db.prepare("UPDATE household_members SET status='inactive' WHERE household_id=? AND user_id=?").run(a.household, a.user);
  await assert.rejects(createOne(db, a), (error) => error instanceof ExpectedIncomeServiceError && error.status === 403);
});

test("overdue é derivado e nunca persistido", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const result = await createOne(db, ids, { expectedDate: "2026-09-20" });
  const row = db.prepare("SELECT status,expected_date FROM expected_income_occurrences WHERE id=?").get(result.occurrenceId);
  assert.equal(row.status, "pending"); assert.equal(expectedIncomeTiming(row.status, row.expected_date, "2026-09-23"), "overdue");
  assert.equal(expectedIncomeTiming("pending", "2026-09-23", "2026-09-23"), "pending");
});

test("receive preserva previsto e registra valores real igual, maior e menor", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  for (const [index, amount] of [20000, 22000, 18000].entries()) {
    const created = await createOne(db, ids, { operationId: `create-${index}`, expectedDate: `2026-09-${20 + index}` });
    const received = await receiveExpectedIncome({ operationId: `receive-${index}`, occurrenceId: created.occurrenceId, receivedAmountCents: amount, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
    const occurrence = db.prepare("SELECT expected_amount_cents,status,received_transaction_id FROM expected_income_occurrences WHERE id=?").get(created.occurrenceId);
    const transaction = db.prepare("SELECT amount_cents,type,status,payment_method FROM transactions WHERE id=?").get(received.transactionId);
    assert.equal(occurrence.expected_amount_cents, 20000); assert.equal(occurrence.status, "received"); assert.equal(occurrence.received_transaction_id, received.transactionId);
    assert.deepEqual({ ...transaction }, { amount_cents: amount, type: "income", status: "confirmed", payment_method: "conta_a_receber" });
  }
});

test("receivedDate pode ser antes, igual ou depois da prevista, mas nunca futura", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  for (const [index, receivedDate] of ["2026-09-20", "2026-09-22", "2026-09-23"].entries()) {
    const created = await createOne(db, ids, { operationId: `date-create-${index}`, expectedDate: "2026-09-22" });
    const received = await receiveExpectedIncome({ operationId: `date-receive-${index}`, occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate, actualAccountId: ids.account }, context(db, ids));
    assert.equal(db.prepare("SELECT transaction_date FROM transactions WHERE id=?").get(received.transactionId).transaction_date, receivedDate);
    assert.equal(db.prepare("SELECT expected_date FROM expected_income_occurrences WHERE id=?").get(created.occurrenceId).expected_date, "2026-09-22");
  }
  const future = await createOne(db, ids, { operationId: "future-create" });
  await assert.rejects(receiveExpectedIncome({ operationId: "future-receive", occurrenceId: future.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-24", actualAccountId: ids.account }, context(db, ids)), /não pode estar no futuro/iu);
});

test("conta planejada pode ser nula ou diferente da conta efetiva sem ser sobrescrita", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  for (const [index, planned] of [null, ids.account].entries()) {
    const created = await createOne(db, ids, { operationId: `account-create-${index}`, plannedAccountId: planned });
    const received = await receiveExpectedIncome({ operationId: `account-receive-${index}`, occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.otherAccount }, context(db, ids));
    assert.equal(db.prepare("SELECT planned_account_id FROM expected_income_occurrences WHERE id=?").get(created.occurrenceId).planned_account_id, planned);
    assert.equal(db.prepare("SELECT account_id FROM transactions WHERE id=?").get(received.transactionId).account_id, ids.otherAccount);
  }
});

test("receive rejeita conta inativa/de outro household e copia classificação planejada", async (t) => {
  const db = database(t); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  const created = await createOne(db, a);
  for (const account of [a.inactiveAccount, b.account]) await assert.rejects(receiveExpectedIncome({ operationId: `receive-${account}`, occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: account }, context(db, a)), /Conta de recebimento inválida/iu);
  const received = await receiveExpectedIncome({ operationId: "valid-receive", occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: a.account }, context(db, a));
  const transaction = db.prepare("SELECT category_id,subcategory_id,description,notes FROM transactions WHERE id=?").get(received.transactionId);
  assert.deepEqual({ ...transaction }, { category_id: a.incomeCategory, subcategory_id: a.subcategory, description: "Diária Alessandra", notes: "Plantão" });
});

test("classificação planejada permanece histórica se categoria e subcategoria forem desativadas", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const created = await createOne(db, ids, { operationId: "historical-classification" });
  db.prepare("UPDATE subcategories SET is_active=0 WHERE id=?").run(ids.subcategory);
  db.prepare("UPDATE categories SET is_active=0 WHERE id=?").run(ids.incomeCategory);
  const received = await receiveExpectedIncome({ operationId: "historical-receive", occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
  const transaction = db.prepare("SELECT category_id,subcategory_id FROM transactions WHERE id=?").get(received.transactionId);
  assert.deepEqual({ ...transaction }, { category_id: ids.incomeCategory, subcategory_id: ids.subcategory });
});

test("saldo só muda pela transaction real e retry de receive não duplica", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const before = balance(db, ids);
  const created = await createOne(db, ids, { expectedDate: "2026-09-20" }); assert.equal(balance(db, ids), before);
  const request = { operationId: "receive-once", occurrenceId: created.occurrenceId, receivedAmountCents: 22000, receivedDate: "2026-09-23", actualAccountId: ids.account };
  const first = await receiveExpectedIncome(request, context(db, ids)); const replay = await receiveExpectedIncome({ ...request }, context(db, ids));
  assert.equal(replay.replayed, true); assert.equal(replay.transactionId, first.transactionId);
  assert.equal(balance(db, ids), before + 22000); assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 1);
  await assert.rejects(receiveExpectedIncome({ ...request, operationId: "second-receive" }, context(db, ids)), (error) => error instanceof ExpectedIncomeServiceError && error.status === 409);
});

test("concorrência de receive permite somente um vencedor", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const created = await createOne(db, ids);
  const requests = ["race-a", "race-b"].map((operationId) => receiveExpectedIncome({ operationId, occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids)));
  const settled = await Promise.allSettled(requests);
  assert.equal(settled.filter((row) => row.status === "fulfilled").length, 1); assert.equal(settled.filter((row) => row.status === "rejected").length, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 1);
});

test("cancel pending é auditável/idempotente e received exige estorno", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  const created = await createOne(db, ids, { operationId: "cancel-create" });
  const request = { operationId: "cancel-once", occurrenceId: created.occurrenceId };
  const first = await cancelExpectedIncome(request, context(db, ids)); const replay = await cancelExpectedIncome({ ...request }, context(db, ids));
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
  const row = db.prepare("SELECT status,cancelled_at FROM expected_income_occurrences WHERE id=?").get(created.occurrenceId);
  assert.equal(row.status, "cancelled"); assert.ok(row.cancelled_at); assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  const receivedOccurrence = await createOne(db, ids, { operationId: "received-create" });
  await receiveExpectedIncome({ operationId: "received-pay", occurrenceId: receivedOccurrence.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
  await assert.rejects(cancelExpectedIncome({ operationId: "cancel-received", occurrenceId: receivedOccurrence.occurrenceId }, context(db, ids)), /Somente uma receita pendente/iu);
});

test("reverse preserva transaction, cria evento temporal, restaura pending e retry é seguro", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const before = balance(db, ids);
  const created = await createOne(db, ids, { expectedDate: "2026-09-20" });
  const received = await receiveExpectedIncome({ operationId: "reverse-receive", occurrenceId: created.occurrenceId, receivedAmountCents: 22000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
  const request = { operationId: "reverse-once", occurrenceId: created.occurrenceId, reversalDate: "2026-09-23" };
  const first = await reverseExpectedIncomeReceipt(request, context(db, ids)); const replay = await reverseExpectedIncomeReceipt({ ...request }, context(db, ids));
  assert.equal(first.transactionId, received.transactionId); assert.equal(replay.replayed, true); assert.equal(balance(db, ids), before);
  const row = db.prepare("SELECT status,received_transaction_id,expected_amount_cents,expected_date,planned_account_id FROM expected_income_occurrences WHERE id=?").get(created.occurrenceId);
  assert.equal(row.status, "pending"); assert.equal(row.received_transaction_id, null); assert.equal(row.expected_amount_cents, 20000); assert.equal(row.expected_date, "2026-09-20"); assert.equal(row.planned_account_id, ids.account);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id=?").get(received.transactionId).total, 1);
  assert.deepEqual(db.prepare("SELECT operation_type,financial_date FROM expected_income_operations WHERE transaction_id=? ORDER BY operation_type DESC").all(received.transactionId).map((operation) => ({ ...operation })), [{ operation_type: "reverse", financial_date: "2026-09-23" }, { operation_type: "receive", financial_date: "2026-09-23" }]);
  assert.equal(expectedIncomeTiming(row.status, row.expected_date, "2026-09-23"), "overdue");
});

test("reverse inconsistente não apaga outra transaction", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const created = await createOne(db, ids);
  const received = await receiveExpectedIncome({ operationId: "tamper-receive", occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
  db.exec("DROP TRIGGER expected_income_linked_transaction_update_guard");
  db.prepare("UPDATE transactions SET payment_method='other' WHERE id=?").run(received.transactionId);
  await assert.rejects(reverseExpectedIncomeReceipt({ operationId: "tamper-reverse", occurrenceId: created.occurrenceId, reversalDate: "2026-09-23" }, context(db, ids)), (error) => error instanceof ExpectedIncomeServiceError && error.code === "EXPECTED_INCOME_RECEIPT_INCONSISTENT");
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id=?").get(received.transactionId).total, 1);
});

test("novo recebimento após estorno cria outro ciclo sem apagar o histórico anterior", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "cycle"); const before = balance(db, ids);
  const created = await createOne(db, ids, { operationId: "cycle-create" });
  const first = await receiveExpectedIncome({ operationId: "cycle-receive-1", occurrenceId: created.occurrenceId, receivedAmountCents: 22000, receivedDate: "2026-09-22", actualAccountId: ids.account }, context(db, ids));
  await reverseExpectedIncomeReceipt({ operationId: "cycle-reverse-1", occurrenceId: created.occurrenceId, reversalDate: "2026-09-23" }, context(db, ids));
  const second = await receiveExpectedIncome({ operationId: "cycle-receive-2", occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
  assert.notEqual(first.transactionId, second.transactionId);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id IN (?,?)").get(first.transactionId, second.transactionId).total, 2);
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_operations WHERE occurrence_id=? AND operation_type IN ('receive','reverse')").get(created.occurrenceId).total, 3);
  assert.equal(balance(db, ids), before + 20000);
  assert.throws(() => db.prepare("UPDATE transactions SET amount_cents=1 WHERE id=?").run(first.transactionId), /managed by its occurrence/iu);
  assert.throws(() => db.prepare("DELETE FROM transactions WHERE id=?").run(first.transactionId), /managed by its occurrence/iu);
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_type='transaction' AND action='delete'").get().total, 0);
  await reverseExpectedIncomeReceipt({ operationId: "cycle-reverse-2", occurrenceId: created.occurrenceId, reversalDate: "2026-09-23" }, context(db, ids));
  assert.equal(balance(db, ids), before);
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_operations WHERE occurrence_id=? AND operation_type IN ('receive','reverse')").get(created.occurrenceId).total, 4);
});

test("concorrência de estorno produz um único evento compensatório e conflito seguro", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "reverse-race"); const created = await createOne(db, ids);
  const received = await receiveExpectedIncome({ operationId: "race-receive", occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
  const settled = await Promise.allSettled([
    reverseExpectedIncomeReceipt({ operationId: "race-reverse-a", occurrenceId: created.occurrenceId, reversalDate: "2026-09-23" }, context(db, ids)),
    reverseExpectedIncomeReceipt({ operationId: "race-reverse-b", occurrenceId: created.occurrenceId, reversalDate: "2026-09-23" }, context(db, ids)),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = settled.find((result) => result.status === "rejected");
  assert.ok(rejection?.reason instanceof ExpectedIncomeServiceError); assert.equal(rejection.reason.status, 409);
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_operations WHERE transaction_id=? AND operation_type='reverse'").get(received.transactionId).total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id=?").get(received.transactionId).total, 1);
});

test("edit pending preserva audit; received e cancelled ficam bloqueadas", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  const pending = await createOne(db, ids, { operationId: "edit-create" });
  const update = { operationId: "edit-pending", occurrenceId: pending.occurrenceId, description: "Diária ajustada", expectedAmountCents: 25000, expectedDate: "2026-10-01", plannedAccountId: null, categoryId: ids.bothCategory, subcategoryId: null, notes: "Ajuste" };
  await updateExpectedIncome(update, context(db, ids)); await updateExpectedIncome({ ...update }, context(db, ids));
  const row = db.prepare("SELECT description,expected_amount_cents,expected_date,planned_account_id,category_id,notes FROM expected_income_occurrences WHERE id=?").get(pending.occurrenceId);
  assert.deepEqual({ ...row }, { description: "Diária ajustada", expected_amount_cents: 25000, expected_date: "2026-10-01", planned_account_id: null, category_id: ids.bothCategory, notes: "Ajuste" });
  const received = await createOne(db, ids, { operationId: "edit-received-create" });
  await receiveExpectedIncome({ operationId: "edit-received-pay", occurrenceId: received.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
  const cancelled = await createOne(db, ids, { operationId: "edit-cancel-create" }); await cancelExpectedIncome({ operationId: "edit-cancel", occurrenceId: cancelled.occurrenceId }, context(db, ids));
  for (const id of [received.occurrenceId, cancelled.occurrenceId]) await assert.rejects(updateExpectedIncome({ ...update, operationId: `blocked-${id}`, occurrenceId: id }, context(db, ids)), /Somente uma receita pendente/iu);
});

test("materialização explícita estende cursor sem duplicar e sem depender de Cron", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const series = await createRecurringExpectedIncome(recurringInput(ids, { operationId: "extend-create" }), context(db, ids));
  const request = { operationId: "extend-series", seriesId: series.seriesId, throughMonth: "2030-09" };
  const result = await materializeExpectedIncomeSeries(request, context(db, ids)); const replay = await materializeExpectedIncomeSeries({ ...request }, context(db, ids));
  assert.equal(result.createdOccurrenceIds.length, 24); assert.equal(result.materializedThroughMonth, "2030-09"); assert.equal(replay.replayed, true);
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_occurrences WHERE series_id=?").get(series.seriesId).total, 48);
  assert.equal(db.prepare("SELECT materialized_through_month FROM expected_income_series WHERE id=?").get(series.seriesId).materialized_through_month, "2030-09");
  const creationReplay = await createRecurringExpectedIncome(recurringInput(ids, { operationId: "extend-create" }), context(db, ids));
  assert.equal(creationReplay.replayed, true); assert.equal(creationReplay.occurrences.length, 24); assert.equal(creationReplay.materializedThroughMonth, "2028-09");
  const source = readFileSync(new URL("../lib/expected-income-service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /scheduled\s*\(|cron/iu);
});

test("retry de materialização concorrente não duplica série/mês", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const series = await createRecurringExpectedIncome(recurringInput(ids, { operationId: "race-series" }), context(db, ids));
  const settled = await Promise.allSettled(["materialize-a", "materialize-b"].map((operationId) => materializeExpectedIncomeSeries({ operationId, seriesId: series.seriesId, throughMonth: "2030-09" }, context(db, ids))));
  assert.equal(settled.filter((row) => row.status === "fulfilled").length, 2);
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_occurrences WHERE series_id=?").get(series.seriesId).total, 48);
  assert.equal(db.prepare("SELECT count(DISTINCT occurrence_month) total FROM expected_income_occurrences WHERE series_id=?").get(series.seriesId).total, 48);
});

test("falha intermediária reverte operação, entidade e audit", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const ctx = context(db, ids);
  ctx.d1.beforeStatement = (_statement, index) => { if (index === 1) throw new Error("forced failure"); };
  await assert.rejects(createExpectedIncome(uniqueInput(ids, { operationId: "rollback" }), ctx), /forced failure/);
  assert.deepEqual(counts(db), { expected_income_series: 0, expected_income_occurrences: 0, expected_income_operations: 0, transactions: 0, audit_logs: 0 });
});

test("falha tardia reverte série, ocorrências, cursor, operation e audit", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const ctx = context(db, ids);
  ctx.d1.beforeStatement = (_statement, index) => { if (index === 8) throw new Error("forced series failure"); };
  await assert.rejects(createRecurringExpectedIncome(recurringInput(ids, { operationId: "series-rollback" }), ctx), /forced series failure/);
  assert.deepEqual(counts(db), { expected_income_series: 0, expected_income_occurrences: 0, expected_income_operations: 0, transactions: 0, audit_logs: 0 });
});

test("falhas tardias de receive e reverse não deixam estados intermediários", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const created = await createOne(db, ids, { operationId: "atomic-create" });
  const receiveContext = context(db, ids); receiveContext.d1.beforeStatement = (_statement, index) => { if (index === 2) throw new Error("forced receive failure"); };
  await assert.rejects(receiveExpectedIncome({ operationId: "atomic-receive-fail", occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, receiveContext), /forced receive failure/);
  assert.equal(db.prepare("SELECT status FROM expected_income_occurrences WHERE id=?").get(created.occurrenceId).status, "pending");
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_operations WHERE idempotency_key='atomic-receive-fail'").get().total, 0);

  const received = await receiveExpectedIncome({ operationId: "atomic-receive", occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
  const reverseContext = context(db, ids); reverseContext.d1.beforeStatement = (_statement, index) => { if (index === 2) throw new Error("forced reverse failure"); };
  await assert.rejects(reverseExpectedIncomeReceipt({ operationId: "atomic-reverse-fail", occurrenceId: created.occurrenceId, reversalDate: "2026-09-23" }, reverseContext), /forced reverse failure/);
  const row = db.prepare("SELECT status,received_transaction_id FROM expected_income_occurrences WHERE id=?").get(created.occurrenceId);
  assert.equal(row.status, "received"); assert.equal(row.received_transaction_id, received.transactionId);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id=?").get(received.transactionId).total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_operations WHERE idempotency_key='atomic-reverse-fail'").get().total, 0);
});

test("household isolation impede ler ou operar occurrence de outra família", async (t) => {
  const db = database(t); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b"); const created = await createOne(db, a);
  for (const action of [
    () => receiveExpectedIncome({ operationId: "foreign-receive", occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: b.account }, context(db, b)),
    () => cancelExpectedIncome({ operationId: "foreign-cancel", occurrenceId: created.occurrenceId }, context(db, b)),
    () => updateExpectedIncome({ ...uniqueInput(b, { operationId: "foreign-update" }), occurrenceId: created.occurrenceId }, context(db, b)),
  ]) await assert.rejects(action(), (error) => error instanceof ExpectedIncomeServiceError && error.status === 404);
  assert.equal(db.prepare("SELECT status FROM expected_income_occurrences WHERE id=?").get(created.occurrenceId).status, "pending");
});

test("auditoria registra create/update/receive/reverse/cancel/materialize sem secrets", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  const received = await createOne(db, ids, { operationId: "audit-create" });
  await updateExpectedIncome({ ...uniqueInput(ids, { operationId: "audit-update" }), occurrenceId: received.occurrenceId }, context(db, ids));
  await receiveExpectedIncome({ operationId: "audit-receive", occurrenceId: received.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
  await reverseExpectedIncomeReceipt({ operationId: "audit-reverse", occurrenceId: received.occurrenceId, reversalDate: "2026-09-23" }, context(db, ids));
  const cancelled = await createOne(db, ids, { operationId: "audit-cancel-create" }); await cancelExpectedIncome({ operationId: "audit-cancel", occurrenceId: cancelled.occurrenceId }, context(db, ids));
  const series = await createRecurringExpectedIncome(recurringInput(ids, { operationId: "audit-series" }), context(db, ids));
  await materializeExpectedIncomeSeries({ operationId: "audit-materialize", seriesId: series.seriesId, throughMonth: "2030-08" }, context(db, ids));
  const actions = new Set(db.prepare("SELECT action FROM audit_logs WHERE entity_type LIKE 'expected_income_%'").all().map((row) => row.action));
  for (const action of ["create", "update", "receive", "reverse", "cancel", "materialize"]) assert.ok(actions.has(action));
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM audit_logs").all()), /token|secret/iu);
});

test("CRUD genérico e banco protegem transaction vinculada", async (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const created = await createOne(db, ids);
  const received = await receiveExpectedIncome({ operationId: "protected-receive", occurrenceId: created.occurrenceId, receivedAmountCents: 20000, receivedDate: "2026-09-23", actualAccountId: ids.account }, context(db, ids));
  assert.throws(() => db.prepare("UPDATE transactions SET status='cancelled' WHERE id=?").run(received.transactionId), /managed by its occurrence/iu);
  assert.throws(() => db.prepare("DELETE FROM transactions WHERE id=?").run(received.transactionId), /managed by its occurrence/iu);
  const route = readFileSync(new URL("../app/api/finance/route.ts", import.meta.url), "utf8");
  await reverseExpectedIncomeReceipt({ operationId: "protected-reverse", occurrenceId: created.occurrenceId, reversalDate: "2026-09-23" }, context(db, ids));
  assert.throws(() => db.prepare("UPDATE transactions SET status='cancelled' WHERE id=?").run(received.transactionId), /managed by its occurrence/iu);
  assert.throws(() => db.prepare("DELETE FROM transactions WHERE id=?").run(received.transactionId), /managed by its occurrence/iu);
  assert.match(route, /expectedIncomeOperations\.transactionId/);
  assert.match(route, /recebimento histórico de uma receita prevista não pode ser (?:alterado|excluído)/iu);
});

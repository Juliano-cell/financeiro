import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATION = "0013_expected_income.sql";
const AT = "2026-09-23T12:00:00.000Z";
const HASH = "a".repeat(64);
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

function apply(db, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const sql of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(sql);
}

function database(t, through = MIGRATION) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations.filter((name) => name <= through)) apply(db, name);
  t.after(() => db.close());
  return db;
}

function seedHousehold(db, suffix) {
  const ids = {
    user: `user-${suffix}`,
    household: `house-${suffix}`,
    account: `account-${suffix}`,
    category: `category-${suffix}`,
    bothCategory: `both-${suffix}`,
    expenseCategory: `expense-${suffix}`,
    subcategory: `subcategory-${suffix}`,
  };
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(ids.user, ids.user, `${ids.user}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(ids.household, ids.household, ids.user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, ids.household, ids.user, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(ids.account, ids.household, ids.account, "bank", 0, 1, AT, AT);
  for (const [category, type] of [[ids.category, "income"], [ids.bothCategory, "both"], [ids.expenseCategory, "expense"]]) {
    db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(category, ids.household, category, type, 1, AT, AT);
  }
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(ids.subcategory, ids.household, ids.category, ids.subcategory, 1, AT, AT);
  return ids;
}

function operation(db, ids, values) {
  const row = { id: `op-${crypto.randomUUID()}`, key: `key-${crypto.randomUUID()}`, hash: HASH, type: "create_occurrence", series: null, occurrence: null, transaction: null, date: null, ...values };
  db.prepare(`INSERT INTO expected_income_operations(id,household_id,idempotency_key,request_hash,operation_type,series_id,occurrence_id,transaction_id,performed_by_user_id,financial_date,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, ids.household, row.key, row.hash, row.type, row.series, row.occurrence, row.transaction, ids.user, row.date, AT);
  return row;
}

function occurrence(db, ids, values = {}) {
  const row = { id: `income-${crypto.randomUUID()}`, series: null, month: null, description: "Diária", amount: 20000, date: "2026-09-25", account: ids.account, category: ids.category, subcategory: ids.subcategory, notes: null, ...values };
  const op = operation(db, ids, { type: "create_occurrence", occurrence: row.id, date: row.date });
  db.prepare(`INSERT INTO expected_income_occurrences(id,household_id,series_id,occurrence_month,description,expected_amount_cents,expected_date,planned_account_id,category_id,subcategory_id,notes,status,received_transaction_id,received_at,cancelled_at,last_operation_id,created_by_user_id,origin,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL,?,?,'web',?,?)`).run(row.id, ids.household, row.series, row.month, row.description, row.amount, row.date, row.account, row.category, row.subcategory, row.notes, op.id, ids.user, AT, AT);
  return row;
}

function transaction(db, ids, id, values = {}) {
  const row = { type: "income", status: "confirmed", ...values };
  db.prepare(`INSERT INTO transactions(id,household_id,type,amount_cents,description,category_id,subcategory_id,transaction_date,responsible_user_id,account_id,payment_method,status,origin,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?, 'conta_a_receber',?,'dashboard',?,?)`).run(id, ids.household, row.type, 20000, "Diária", ids.category, ids.subcategory, "2026-09-24", ids.user, ids.account, row.status, AT, AT);
}

function receive(db, ids, row, transactionId = `transaction-${crypto.randomUUID()}`) {
  transaction(db, ids, transactionId);
  const op = operation(db, ids, { type: "receive", occurrence: row.id, transaction: transactionId, date: "2026-09-24" });
  db.prepare("UPDATE expected_income_occurrences SET status='received',received_transaction_id=?,received_at=?,last_operation_id=?,updated_at=? WHERE id=?").run(transactionId, AT, op.id, AT, row.id);
  return { transactionId, op };
}

test("0013 sucede 0012 e aplica em upgrade completo com schema íntegro", (t) => {
  assert.equal(migrations[migrations.indexOf("0012_bill_installment_series.sql") + 1], MIGRATION);
  const db = database(t);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const name of ["expected_income_series", "expected_income_occurrences", "expected_income_operations"]) assert.ok(tables.has(name));
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
  for (const name of ["expected_income_occurrences_series_month_unique", "expected_income_occurrences_transaction_unique", "expected_income_operations_household_key_unique", "expected_income_operations_reverse_transaction_unique", "idx_expected_income_operations_household_transaction", "idx_expected_income_occurrences_household_status_date"]) assert.ok(indexes.has(name));
  const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((row) => row.name));
  for (const name of ["expected_income_operations_update_guard", "expected_income_operations_delete_guard", "expected_income_occurrences_lifecycle_guard", "expected_income_linked_transaction_update_guard", "expected_income_linked_transaction_delete_guard"]) assert.ok(triggers.has(name));
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("checks rejeitam estados híbridos, datas, valores e recorrência inválidos", (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  const base = occurrence(db, ids);
  assert.throws(() => db.prepare("UPDATE expected_income_occurrences SET status='received',received_at=? WHERE id=?").run(AT, base.id), /CHECK|lifecycle/iu);
  for (const values of [{ amount: 0 }, { date: "2027-02-29" }, { description: "" }]) {
    assert.throws(() => occurrence(db, ids, values), /CHECK|invalid expected/iu);
  }
  const seriesId = "series-invalid";
  const op = operation(db, ids, { type: "create_series", series: seriesId, date: "2026-02-28" });
  const insert = db.prepare(`INSERT INTO expected_income_series(id,household_id,description,expected_amount_cents,recurrence,configured_day,starts_on,planned_account_id,category_id,subcategory_id,is_active,materialized_through_month,last_operation_id,created_by_user_id,origin,created_at,updated_at)
    VALUES(?,?,?,?,'monthly',?,?,?,?,?,1,?,?,?,?,?,?)`);
  assert.throws(() => insert.run(seriesId, ids.household, "Salário", 302000, 31, "2026-02-27", ids.account, ids.category, ids.subcategory, "2026-02", op.id, ids.user, "web", AT, AT), /CHECK/iu);
});

test("isolamento de household, natureza da categoria e subcategoria são impostos no banco", (t) => {
  const db = database(t); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  for (const values of [
    { account: b.account },
    { category: b.category, subcategory: b.subcategory },
    { category: a.expenseCategory, subcategory: null },
    { subcategory: b.subcategory },
  ]) assert.throws(() => occurrence(db, a, values), /FOREIGN KEY|invalid expected/iu);
});

test("ledger é único por household, imutável e valida fingerprint", (t) => {
  const db = database(t); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  const first = operation(db, a, { key: "same", occurrence: "future-a" });
  assert.throws(() => operation(db, a, { key: "same", occurrence: "future-b" }), /UNIQUE/iu);
  assert.doesNotThrow(() => operation(db, b, { key: "same", occurrence: "future-b" }));
  assert.throws(() => db.prepare("UPDATE expected_income_operations SET request_hash=? WHERE id=?").run("b".repeat(64), first.id), /immutable/iu);
  assert.throws(() => db.prepare("DELETE FROM expected_income_operations WHERE id=?").run(first.id), /immutable/iu);
  assert.throws(() => operation(db, a, { key: "bad-hash", occurrence: "future-c", id: "bad", hash: "bad" }), /CHECK/iu);
});

test("ledger bloqueia delete direto sem impedir cascade legítimo do household", (t) => {
  const db = database(t); const ids = seedHousehold(db, "cascade");
  const row = occurrence(db, ids);
  assert.throws(() => db.prepare("DELETE FROM expected_income_operations WHERE occurrence_id=?").run(row.id), /immutable/iu);
  assert.doesNotThrow(() => db.prepare("DELETE FROM households WHERE id=?").run(ids.household));
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_operations WHERE household_id=?").get(ids.household).total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_occurrences WHERE household_id=?").get(ids.household).total, 0);
});

test("transaction recebida exige income confirmed, mesmo household e vínculo único", (t) => {
  const db = database(t); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  const first = occurrence(db, a); const second = occurrence(db, a);
  transaction(db, a, "expense", { type: "expense" });
  assert.throws(() => operation(db, a, { type: "receive", occurrence: first.id, transaction: "expense", date: "2026-09-24" }), /invalid expected income operation target/iu);
  transaction(db, b, "foreign");
  assert.throws(() => operation(db, a, { type: "receive", occurrence: first.id, transaction: "foreign", date: "2026-09-24" }), /invalid expected income operation target/iu);
  const linked = receive(db, a, first, "receipt");
  const secondReceive = operation(db, a, { type: "receive", occurrence: second.id, transaction: linked.transactionId, date: "2026-09-24" });
  assert.throws(() => db.prepare("UPDATE expected_income_occurrences SET status='received',received_transaction_id=?,received_at=?,last_operation_id=?,updated_at=? WHERE id=?").run(linked.transactionId, AT, secondReceive.id, AT, second.id), /UNIQUE/iu);
});

test("transaction vinculada não pode ser editada ou excluída pelo CRUD genérico", (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const row = occurrence(db, ids); const linked = receive(db, ids, row, "receipt");
  assert.throws(() => db.prepare("UPDATE transactions SET amount_cents=amount_cents+1 WHERE id=?").run(linked.transactionId), /managed by its occurrence/iu);
  assert.throws(() => db.prepare("DELETE FROM transactions WHERE id=?").run(linked.transactionId), /managed by its occurrence/iu);
});

test("FK do ledger preserva integridade sem impedir cascade legítimo do household", (t) => {
  const db = database(t); const ids = seedHousehold(db, "cascade-receipt"); const row = occurrence(db, ids); receive(db, ids, row, "receipt-cascade");
  assert.doesNotThrow(() => db.prepare("DELETE FROM households WHERE id=?").run(ids.household));
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE household_id=?").get(ids.household).total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM expected_income_operations WHERE household_id=?").get(ids.household).total, 0);
});

test("estorno controlado preserva e protege a transaction histórica após voltar a pending", (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const row = occurrence(db, ids); const linked = receive(db, ids, row, "receipt");
  transaction(db, ids, "unrelated");
  assert.throws(() => operation(db, ids, { type: "reverse", occurrence: row.id, transaction: linked.transactionId, date: "2026-09-23" }), /invalid expected income operation target/iu);
  const reverse = operation(db, ids, { type: "reverse", occurrence: row.id, transaction: linked.transactionId, date: "2026-09-24" });
  db.prepare("UPDATE expected_income_occurrences SET status='pending',received_transaction_id=NULL,received_at=NULL,last_operation_id=?,updated_at=? WHERE id=?").run(reverse.id, AT, row.id);
  assert.throws(() => db.prepare("DELETE FROM transactions WHERE id=?").run(linked.transactionId), /managed by its occurrence/iu);
  assert.throws(() => operation(db, ids, { type: "reverse", occurrence: row.id, transaction: linked.transactionId, date: "2026-09-24" }), /UNIQUE|invalid expected income operation target/iu);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id='unrelated'").get().total, 1);
  assert.equal(db.prepare("SELECT status,received_transaction_id FROM expected_income_occurrences WHERE id=?").get(row.id).status, "pending");
});

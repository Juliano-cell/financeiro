import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATION = "0012_bill_installment_series.sql";
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
const AT = "2026-09-23T12:00:00.000Z";
const fingerprint = "a".repeat(64);

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
  const user = `user-${suffix}`; const household = `house-${suffix}`; const category = `category-${suffix}`; const account = `account-${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, `${user}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, household, user, "owner", "active", AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(category, household, category, "expense", 1, AT, AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(account, household, account, "bank", 0, 1, AT, AT);
  return { user, household, category, account };
}

function insertSeries(db, ids, overrides = {}) {
  const row = {
    id: `series-${crypto.randomUUID()}`,
    description: "Móveis",
    total: 500000,
    count: 3,
    firstDueDate: "2026-10-23",
    configuredDay: 23,
    category: ids.category,
    subcategory: null,
    account: ids.account,
    notes: null,
    key: `key-${crypto.randomUUID()}`,
    fingerprint,
    origin: "web",
    ...overrides,
  };
  db.prepare(`INSERT INTO bill_installment_series(id,household_id,description,total_amount_cents,installment_count,first_due_date,configured_day,category_id,subcategory_id,account_id,notes,idempotency_key,request_fingerprint,created_by_user_id,origin,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, ids.household, row.description, row.total, row.count, row.firstDueDate, row.configuredDay, row.category, row.subcategory, row.account, row.notes, row.key, row.fingerprint, ids.user, row.origin, AT, AT);
  return row;
}

function insertBill(db, ids, id, recurrence = "none", recurrenceSeriesId = null) {
  db.prepare(`INSERT INTO bills(id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,recurrence_series_id,status,created_by_user_id,origin,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'pending',?,'web',?,?)`).run(id, ids.household, "Móveis", 166666, ids.category, "2026-10-23", ids.account, recurrence, recurrenceSeriesId, ids.user, AT, AT);
}

test("0012 aplica após 0011 e cria schema, índices e triggers íntegros", (t) => {
  const db = database(t);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  assert.ok(tables.has("bill_installment_series"));
  assert.ok(tables.has("bill_installment_occurrences"));
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
  assert.ok(indexes.has("bills_household_id_unique"));
  assert.ok(indexes.has("bill_installment_series_household_key_unique"));
  assert.ok(indexes.has("idx_bill_installment_occurrences_household_bill"));
  const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((row) => row.name));
  for (const name of ["bill_installment_series_subcategory_insert", "bill_installment_series_identity_update", "bill_installment_occurrences_insert_guard", "bill_installment_occurrences_identity_update", "bill_installment_bill_recurrence_update"]) assert.ok(triggers.has(name));
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("series exige total, quantidade, data, dia, fingerprint e chave válidos", (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  for (const overrides of [
    { total: 0 }, { total: 1, count: 2 }, { count: 1 }, { count: 121 },
    { firstDueDate: "2027-02-29", configuredDay: 29 }, { configuredDay: 24 },
    { fingerprint: "bad" }, { key: "" }, { description: "" }, { origin: "invalid" },
  ]) assert.throws(() => insertSeries(db, ids, overrides), /CHECK constraint failed/iu);
});

test("idempotency key é única somente dentro do household", (t) => {
  const db = database(t); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  insertSeries(db, a, { key: "same" });
  assert.throws(() => insertSeries(db, a, { key: "same" }), /UNIQUE constraint failed/iu);
  assert.doesNotThrow(() => insertSeries(db, b, { key: "same", category: b.category, account: b.account }));
});

test("occurrence exige mesma household, bill não recorrente e número dentro da série", (t) => {
  const db = database(t); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  const series = insertSeries(db, a); insertBill(db, a, "bill-a"); insertBill(db, b, "bill-b");
  db.prepare("INSERT INTO bill_installment_occurrences(household_id,series_id,bill_id,installment_number,created_at) VALUES(?,?,?,?,?)").run(a.household, series.id, "bill-a", 1, AT);
  assert.throws(() => db.prepare("INSERT INTO bill_installment_occurrences(household_id,series_id,bill_id,installment_number,created_at) VALUES(?,?,?,?,?)").run(a.household, series.id, "bill-b", 2, AT), /FOREIGN KEY|invalid bill installment/iu);
  insertBill(db, a, "bill-out-of-range");
  assert.throws(() => db.prepare("INSERT INTO bill_installment_occurrences(household_id,series_id,bill_id,installment_number,created_at) VALUES(?,?,?,?,?)").run(a.household, series.id, "bill-out-of-range", 4, AT), /invalid bill installment/iu);

  db.prepare("INSERT INTO recurring_bill_series(id,household_id,description,amount_cents,category_id,account_id,day_of_month,starts_on,is_active,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("recurring", a.household, "Internet", 1000, a.category, a.account, 10, "2026-10-10", 1, a.user, "web", AT, AT);
  insertBill(db, a, "bill-recurring", "monthly", "recurring");
  assert.throws(() => db.prepare("INSERT INTO bill_installment_occurrences(household_id,series_id,bill_id,installment_number,created_at) VALUES(?,?,?,?,?)").run(a.household, series.id, "bill-recurring", 2, AT), /invalid bill installment/iu);
});

test("bill pertence no máximo a uma série e número não pode duplicar", (t) => {
  const db = database(t); const ids = seedHousehold(db, "a");
  const first = insertSeries(db, ids); const second = insertSeries(db, ids); insertBill(db, ids, "bill-1"); insertBill(db, ids, "bill-2");
  const insert = db.prepare("INSERT INTO bill_installment_occurrences(household_id,series_id,bill_id,installment_number,created_at) VALUES(?,?,?,?,?)");
  insert.run(ids.household, first.id, "bill-1", 1, AT);
  assert.throws(() => insert.run(ids.household, second.id, "bill-1", 1, AT), /UNIQUE constraint failed/iu);
  assert.throws(() => insert.run(ids.household, first.id, "bill-2", 1, AT), /UNIQUE constraint failed/iu);
});

test("contrato, associação e natureza não recorrente são imutáveis", (t) => {
  const db = database(t); const ids = seedHousehold(db, "a"); const series = insertSeries(db, ids); insertBill(db, ids, "bill-1");
  db.prepare("INSERT INTO bill_installment_occurrences(household_id,series_id,bill_id,installment_number,created_at) VALUES(?,?,?,?,?)").run(ids.household, series.id, "bill-1", 1, AT);
  assert.throws(() => db.prepare("UPDATE bill_installment_series SET total_amount_cents=total_amount_cents+1 WHERE id=?").run(series.id), /contract is immutable/iu);
  assert.throws(() => db.prepare("UPDATE bill_installment_occurrences SET installment_number=2 WHERE bill_id='bill-1'").run(), /occurrence is immutable/iu);
  assert.throws(() => db.prepare("UPDATE bills SET recurrence='monthly', recurrence_series_id='missing' WHERE id='bill-1'").run(), /must remain non-recurring/iu);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migrationNames = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

function applyMigration(db, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
}

function databaseThrough(name = migrationNames.at(-1)) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of migrationNames) {
    applyMigration(db, migration);
    if (migration === name) break;
  }
  return db;
}

function seedHousehold(db, suffix) {
  const at = "2026-09-13T12:00:00.000Z";
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `Usuário ${suffix}`, `${suffix}@example.com`, at, at);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `Casa ${suffix}`, `u${suffix}`, at, at);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", at);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`a${suffix}`, `h${suffix}`, `Conta ${suffix}`, "bank", at, at);
  db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`c${suffix}`, `h${suffix}`, `Categoria ${suffix}`, "expense", at, at);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`s${suffix}`, `h${suffix}`, `c${suffix}`, `Subcategoria ${suffix}`, at, at);
}

function insertSeries(db, { id, householdId, categoryId, subcategoryId = null, userId }) {
  db.prepare("INSERT INTO recurring_bill_series(id,household_id,description,amount_cents,category_id,subcategory_id,day_of_month,starts_on,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, householdId, id, 1000, categoryId, subcategoryId, 10, "2026-09-01", userId, "2026-09-13T12:00:00.000Z", "2026-09-13T12:00:00.000Z");
}

function insertBill(db, { id, householdId, categoryId, subcategoryId = null, seriesId = null, paymentTransactionId = null, userId }) {
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,subcategory_id,due_date,recurrence,recurrence_series_id,status,payment_transaction_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, householdId, id, 1000, categoryId, subcategoryId, "2026-09-10", seriesId ? "monthly" : "none", seriesId, paymentTransactionId ? "paid" : "pending", paymentTransactionId, userId, "2026-09-13T12:00:00.000Z", "2026-09-13T12:00:00.000Z");
}

test("0003 preserva dados legados e adiciona colunas nullable, referências e índices", () => {
  const db = databaseThrough("0002_finance_evolution.sql");
  seedHousehold(db, "a");
  db.prepare("INSERT INTO recurring_bill_series(id,household_id,description,amount_cents,category_id,day_of_month,starts_on,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("legacy-series", "ha", "Série legada", 1000, "ca", 10, "2026-09-01", "ua", "2026-09-13T12:00:00.000Z", "2026-09-13T12:00:00.000Z");
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,due_date,recurrence,recurrence_series_id,status,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("legacy-bill", "ha", "Legado", 1000, "ca", "2026-09-10", "monthly", "legacy-series", "pending", "ua", "2026-09-13T12:00:00.000Z", "2026-09-13T12:00:00.000Z");
  const before = {
    bills: db.prepare("SELECT count(*) total FROM bills").get().total,
    series: db.prepare("SELECT count(*) total FROM recurring_bill_series").get().total,
    subcategories: db.prepare("SELECT count(*) total FROM subcategories").get().total,
  };

  applyMigration(db, "0003_bill_subcategories.sql");

  const billColumn = db.prepare("PRAGMA table_info(bills)").all().find((column) => column.name === "subcategory_id");
  const seriesColumn = db.prepare("PRAGMA table_info(recurring_bill_series)").all().find((column) => column.name === "subcategory_id");
  assert.equal(billColumn.notnull, 0);
  assert.equal(seriesColumn.notnull, 0);
  assert.equal(db.prepare("SELECT subcategory_id FROM bills WHERE id='legacy-bill'").get().subcategory_id, null);
  assert.equal(db.prepare("SELECT subcategory_id FROM recurring_bill_series WHERE id='legacy-series'").get().subcategory_id, null);
  assert.deepEqual({
    bills: db.prepare("SELECT count(*) total FROM bills").get().total,
    series: db.prepare("SELECT count(*) total FROM recurring_bill_series").get().total,
    subcategories: db.prepare("SELECT count(*) total FROM subcategories").get().total,
  }, before);

  const billForeignKeys = db.prepare("PRAGMA foreign_key_list(bills)").all();
  const seriesForeignKeys = db.prepare("PRAGMA foreign_key_list(recurring_bill_series)").all();
  assert.ok(billForeignKeys.some((key) => key.from === "subcategory_id" && key.table === "subcategories"));
  assert.ok(seriesForeignKeys.some((key) => key.from === "subcategory_id" && key.table === "subcategories"));
  for (const indexName of ["subcategories_household_category_name_unique", "bills_payment_transaction_unique", "idx_bills_household_subcategory_status", "idx_recurring_bill_series_household_subcategory"]) {
    assert.equal(db.prepare("SELECT count(*) total FROM sqlite_master WHERE type='index' AND name=?").get(indexName).total, 1);
  }
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("0003 bloqueia subcategorias duplicadas sem diferenciar maiúsculas e minúsculas", () => {
  const db = databaseThrough();
  seedHousehold(db, "a");
  assert.throws(() => db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("duplicate", "ha", "ca", "SUBCATEGORIA A", "2026-09-13T12:00:00.000Z", "2026-09-13T12:00:00.000Z"), /UNIQUE/);
});

test("0003 impede relações de subcategoria entre households ou categorias", () => {
  const db = databaseThrough();
  seedHousehold(db, "a");
  seedHousehold(db, "b");
  const at = "2026-09-13T12:00:00.000Z";
  db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("ca2", "ha", "Outra A", "expense", at, at);
  assert.throws(() => db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("cross", "ha", "cb", "Inválida", at, at), /another household/);

  insertBill(db, { id: "valid-bill", householdId: "ha", categoryId: "ca", subcategoryId: "sa", userId: "ua" });
  assert.throws(() => insertBill(db, { id: "cross-bill", householdId: "ha", categoryId: "ca", subcategoryId: "sb", userId: "ua" }), /does not belong/);
  assert.throws(() => insertBill(db, { id: "mismatch-bill", householdId: "ha", categoryId: "ca2", subcategoryId: "sa", userId: "ua" }), /does not belong/);
  assert.throws(() => db.prepare("UPDATE bills SET subcategory_id=? WHERE id=?").run("sb", "valid-bill"), /does not belong/);

  insertSeries(db, { id: "valid-series", householdId: "ha", categoryId: "ca", subcategoryId: "sa", userId: "ua" });
  assert.throws(() => insertSeries(db, { id: "cross-series", householdId: "ha", categoryId: "ca", subcategoryId: "sb", userId: "ua" }), /does not belong/);
  assert.throws(() => insertSeries(db, { id: "mismatch-series", householdId: "ha", categoryId: "ca2", subcategoryId: "sa", userId: "ua" }), /does not belong/);
  assert.throws(() => db.prepare("UPDATE recurring_bill_series SET category_id=? WHERE id=?").run("ca2", "valid-series"), /does not belong/);
});

test("0003 permite vários NULLs e impede reutilizar payment_transaction_id", () => {
  const db = databaseThrough();
  seedHousehold(db, "a");
  const at = "2026-09-13T12:00:00.000Z";
  db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,category_id,subcategory_id,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tx", "ha", "expense", 1000, "Pagamento", "ca", "sa", "2026-09-13", "ua", "aa", "confirmed", "dashboard", at, at);
  insertBill(db, { id: "null-a", householdId: "ha", categoryId: "ca", userId: "ua" });
  db.prepare("UPDATE bills SET due_date='2026-09-11' WHERE id='null-a'").run();
  insertBill(db, { id: "null-b", householdId: "ha", categoryId: "ca", userId: "ua" });
  db.prepare("UPDATE bills SET due_date='2026-09-12' WHERE id='null-b'").run();
  insertBill(db, { id: "paid-a", householdId: "ha", categoryId: "ca", subcategoryId: "sa", paymentTransactionId: "tx", userId: "ua" });
  assert.throws(() => insertBill(db, { id: "paid-b", householdId: "ha", categoryId: "ca", subcategoryId: "sa", paymentTransactionId: "tx", userId: "ua" }), /UNIQUE/);
});

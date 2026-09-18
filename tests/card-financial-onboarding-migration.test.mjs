import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { cardImportBatches, cardInvoiceAdjustments, cardPurchaseImportMetadata } from "../db/schema.ts";

const MIGRATION = "0006_card_financial_onboarding.sql";
const AT = "2026-09-18T12:00:00.000Z";
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

function applyMigration(db, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
}

function database(t, { migrate = true } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations.filter((name) => name < MIGRATION)) applyMigration(db, name);
  if (migrate) applyMigration(db, MIGRATION);
  return db;
}

function seed(db, suffix = "a") {
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `House ${suffix}`, `u${suffix}`, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`a${suffix}`, `h${suffix}`, `Account ${suffix}`, "bank", AT, AT);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`card${suffix}`, `h${suffix}`, `Card ${suffix}`, "Bank", `User ${suffix}`, 100000, 5, 12, AT, AT);
}

function healthy(db) {
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
}

function snapshot(db) {
  const excluded = new Set(["card_import_batches", "card_invoice_adjustments", "card_purchase_import_metadata"]);
  const result = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    if (excluded.has(name)) continue;
    const safe = name.replaceAll('"', '""');
    result[name] = db.prepare(`SELECT * FROM "${safe}" ORDER BY rowid`).all();
  }
  return result;
}

function insertBatch(db, changes = {}) {
  const row = { id: "batch", household: "ha", card: "carda", user: "ua", key: "key", fingerprint: "fingerprint", month: "2026-10", declared: 140000, opening: 130000, purchases: 1, installments: 6, status: "pending", completedAt: null, ...changes };
  db.prepare(`INSERT INTO card_import_batches
    (id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,
     declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at,completed_at,voided_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(row.id, row.household, row.card, row.user, row.key, row.fingerprint, row.month, row.declared, row.opening, row.purchases, row.installments, row.status, AT, row.completedAt);
}

function insertCard(db, id = "other-card", household = "ha", holder = "User a") {
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, household, `Card ${id}`, "Bank", holder, 100000, 5, 12, AT, AT);
}

function insertInvoice(db, id = "invoice", card = "carda", month = "2026-10") {
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, "ha", card, month, `${month}-12`, `${month}-05`, "open", AT, AT);
}

function insertPurchase(db, id = "purchase", card = "carda", installments = 1) {
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "ha", card, `Purchase ${id}`, 10000, "2026-09-01", installments, "active", "ua", "system", AT, AT);
}

function insertInstallment(db, id = "part", purchase = "purchase", invoice = "invoice", number = 1, count = 1) {
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, "ha", purchase, invoice, number, count, 10000, "pending", AT, AT);
}

function insertAdjustment(db, changes = {}) {
  const row = { id: "opening", household: "ha", invoice: "invoice", batch: "batch", amount: 140000, status: "active", user: "ua", createdAt: AT, voidedAt: null, ...changes };
  db.prepare("INSERT INTO card_invoice_adjustments(id,household_id,invoice_id,import_batch_id,kind,amount_cents,status,created_by_user_id,created_at,voided_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(row.id, row.household, row.invoice, row.batch, "opening_balance", row.amount, row.status, row.user, row.createdAt, row.voidedAt);
}

function insertMetadata(db, changes = {}) {
  const row = { id: "metadata", household: "ha", purchase: "purchase", batch: "batch", first: 5, count: 10, total: 100000, date: "2026-01-10", importedAt: AT, ...changes };
  db.prepare("INSERT INTO card_purchase_import_metadata(id,household_id,purchase_id,import_batch_id,first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date,imported_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(row.id, row.household, row.purchase, row.batch, row.first, row.count, row.total, row.date, row.importedAt);
}

test("0006 aplica em banco vazio após 0000–0005 e mantém integridade", (t) => {
  const db = database(t);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const name of ["card_import_batches", "card_invoice_adjustments", "card_purchase_import_metadata"]) assert.ok(tables.has(name));
  healthy(db);
});

test("upgrade 0005→0006 preserva fatos, totais e snapshots legados sem backfill", (t) => {
  const db = database(t, { migrate: false });
  seed(db);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)").run("invoice", "ha", "carda", "2026-10", "2026-10-12", "2026-10-05", "open", AT, AT);
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("purchase", "ha", "carda", "Legacy", 10000, "2026-09-01", 1, "active", "ua", "web", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("part", "ha", "purchase", "invoice", 1, 1, 10000, "pending", AT, AT);
  const before = snapshot(db);
  healthy(db);
  applyMigration(db, MIGRATION);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM card_invoice_adjustments").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM card_purchase_import_metadata").get().n, 0);
  healthy(db);
});

test("0006 recusa legado cross-card em vez de corrigi-lo silenciosamente", (t) => {
  const db = database(t, { migrate: false });
  seed(db);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("other-card", "ha", "Other", "Bank", "User a", 100000, 5, 12, AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("invoice", "ha", "other-card", "2026-10", "2026-10-12", "open", AT, AT);
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("purchase", "ha", "carda", "Mismatch", 100, "2026-09-01", 1, "active", "ua", "web", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("part", "ha", "purchase", "invoice", 1, 1, 100, "pending", AT, AT);
  assert.throws(() => applyMigration(db, MIGRATION), /migration_0006_cross_card_guard_check/iu);
  assert.equal(db.prepare("SELECT card_id FROM card_purchases WHERE id='purchase'").get().card_id, "carda");
  assert.equal(db.prepare("SELECT card_id FROM card_invoices WHERE id='invoice'").get().card_id, "other-card");
});

test("hardening impede cross-card por INSERT, REPLACE, UPDATE e UPDATE OR REPLACE em todas as direções", (t) => {
  const db = database(t);
  seed(db);
  insertCard(db);
  insertInvoice(db);
  insertInvoice(db, "other-invoice", "other-card");
  insertPurchase(db);
  insertPurchase(db, "other-purchase", "other-card");
  const insert = "INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)";
  assert.throws(() => db.prepare(insert).run("bad", "ha", "purchase", "other-invoice", 1, 1, 100, "pending", AT, AT), /same card/iu);
  insertInstallment(db, "good");
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO card_installments
    (id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at)
    VALUES('replace-new','ha','purchase','other-invoice',2,2,100,'pending',?,?)`).run(AT, AT), /same card/iu);
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO card_installments
    (id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at)
    VALUES('good','ha','purchase','other-invoice',1,1,100,'pending',?,?)`).run(AT, AT), /cannot be replaced|same card/iu);
  assert.throws(() => db.prepare("UPDATE card_purchases SET card_id='other-card' WHERE id='purchase'").run(), /cannot move/iu);
  assert.throws(() => db.prepare("UPDATE OR REPLACE card_purchases SET card_id='other-card' WHERE id='purchase'").run(), /cannot move/iu);
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO card_purchases
    (id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at)
    VALUES('purchase','ha','other-card','Replaced',100,'2026-09-01',1,'active','ua','system',?,?)`).run(AT, AT), /cannot be replaced/iu);
  assert.throws(() => db.prepare("UPDATE card_invoices SET card_id='other-card' WHERE id='invoice'").run(), /cannot move/iu);
  assert.throws(() => db.prepare("UPDATE OR REPLACE card_invoices SET card_id='other-card' WHERE id='invoice'").run(), /cannot move/iu);
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO card_invoices
    (id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at)
    VALUES('invoice','ha','other-card','2026-11','2026-11-12','2026-11-05','open',?,?)`).run(AT, AT), /cannot be replaced/iu);
  assert.throws(() => db.prepare("UPDATE card_installments SET purchase_id='other-purchase' WHERE id='good'").run(), /same card/iu);
  assert.throws(() => db.prepare("UPDATE OR REPLACE card_installments SET invoice_id='other-invoice' WHERE id='good'").run(), /same card/iu);
  assert.deepEqual({ ...db.prepare("SELECT purchase_id,invoice_id FROM card_installments WHERE id='good'").get() }, { purchase_id: "purchase", invoice_id: "invoice" });
  assert.equal(db.prepare("SELECT card_id FROM card_purchases WHERE id='purchase'").get().card_id, "carda");
  assert.equal(db.prepare("SELECT card_id FROM card_invoices WHERE id='invoice'").get().card_id, "carda");
  healthy(db);
});

test("batch, metadata e adjustment isolam household e identidade financeira", (t) => {
  const db = database(t);
  seed(db, "a"); seed(db, "b");
  insertBatch(db);
  assert.throws(() => insertBatch(db, { id: "cross", household: "ha", card: "cardb", key: "cross" }), /FOREIGN KEY/iu);
  assert.throws(() => insertBatch(db, { id: "duplicate-card", key: "other" }), /cannot be replaced|UNIQUE/iu);
  assert.throws(() => insertBatch(db, { id: "duplicate-key", card: "cardb" }), /cannot be replaced|UNIQUE|FOREIGN KEY/iu);
  assert.throws(() => db.prepare("DELETE FROM card_import_batches WHERE id='batch'").run(), /cannot be deleted/iu);
});

test("metadata exige purchase system do mesmo cartão e mapeamento físico remanescente", (t) => {
  const db = database(t);
  seed(db);
  insertBatch(db);
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("purchase", "ha", "carda", "Imported", 60000, "2026-09-18", 6, "active", "ua", "system", AT, AT);
  const insert = "INSERT INTO card_purchase_import_metadata(id,household_id,purchase_id,import_batch_id,first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date,imported_at) VALUES(?,?,?,?,?,?,?,?,?)";
  assert.throws(() => db.prepare(insert).run("bad", "ha", "purchase", "batch", 4, 10, 100000, null, AT), /does not match/iu);
  db.prepare(insert).run("metadata", "ha", "purchase", "batch", 5, 10, 100000, "2026-01-10", AT);
  assert.throws(() => db.prepare("UPDATE card_purchase_import_metadata SET original_total_cents=90000 WHERE id='metadata'").run(), /immutable/iu);
  assert.throws(() => db.prepare("DELETE FROM card_purchase_import_metadata WHERE id='metadata'").run(), /cannot be deleted/iu);
});

test("metadata financeira não pode ser substituída, atualizada nem anexada após conclusão", (t) => {
  const db = database(t);
  seed(db);
  insertBatch(db, { purchases: 1, installments: 6 });
  insertPurchase(db, "purchase", "carda", 6);
  insertMetadata(db);
  const replace = (first, count, total, date) => db.prepare(`INSERT OR REPLACE INTO card_purchase_import_metadata
    (id,household_id,purchase_id,import_batch_id,first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date,imported_at)
    VALUES('metadata','ha','purchase','batch',?,?,?,?,?)`).run(first, count, total, date, AT);
  assert.throws(() => replace(6, 11, 100000, "2026-01-10"), /cannot be replaced/iu);
  assert.throws(() => replace(5, 10, 1, "2026-01-10"), /cannot be replaced/iu);
  assert.throws(() => replace(5, 10, 100000, null), /cannot be replaced/iu);
  for (const sql of [
    "UPDATE card_purchase_import_metadata SET first_original_installment_number=6,original_installment_count=11 WHERE id='metadata'",
    "UPDATE OR REPLACE card_purchase_import_metadata SET original_total_cents=1 WHERE id='metadata'",
    "UPDATE OR REPLACE card_purchase_import_metadata SET original_purchase_date=NULL WHERE id='metadata'",
  ]) assert.throws(() => db.prepare(sql).run(), /immutable/iu);
  assert.deepEqual(
    { ...db.prepare("SELECT first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date FROM card_purchase_import_metadata WHERE id='metadata'").get() },
    { first_original_installment_number: 5, original_installment_count: 10, original_total_cents: 100000, original_purchase_date: "2026-01-10" },
  );
  assert.throws(() => db.prepare("DELETE FROM card_purchase_import_metadata WHERE id='metadata'").run(), /cannot be deleted/iu);
  healthy(db);
});

test("opening balance pertence à invoice inicial e não aceita zero ou delete", (t) => {
  const db = database(t);
  seed(db);
  insertBatch(db, { purchases: 0, installments: 0, opening: 140000 });
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)").run("invoice", "ha", "carda", "2026-10", "2026-10-12", "2026-10-05", "open", AT, AT);
  const insert = "INSERT INTO card_invoice_adjustments(id,household_id,invoice_id,import_batch_id,kind,amount_cents,status,created_by_user_id,created_at,voided_at) VALUES(?,?,?,?,?,?,?,?,?,?)";
  assert.throws(() => db.prepare(insert).run("zero", "ha", "invoice", "batch", "opening_balance", 0, "active", "ua", AT, null), /does not match|CHECK/iu);
  db.prepare(insert).run("opening", "ha", "invoice", "batch", "opening_balance", 140000, "active", "ua", AT, null);
  assert.throws(() => db.prepare(insert).run("duplicate", "ha", "invoice", "batch", "opening_balance", 1, "active", "ua", AT, null), /cannot be replaced|does not match|UNIQUE/iu);
  assert.throws(() => db.prepare("DELETE FROM card_invoice_adjustments WHERE id='opening'").run(), /cannot be deleted/iu);
  healthy(db);
});

test("opening balance aceita somente o valor exato do batch e não permite reuso após void", (t) => {
  for (const amount of [129999, 130001, 1]) {
    const db = database(t);
    seed(db, `wrong${amount}`);
    insertBatch(db, { household: `hwrong${amount}`, card: `cardwrong${amount}`, user: `uwrong${amount}`, id: `batch-${amount}`, key: `key-${amount}`, opening: 130000, purchases: 0, installments: 0 });
    db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(`invoice-${amount}`, `hwrong${amount}`, `cardwrong${amount}`, "2026-10", "2026-10-12", "open", AT, AT);
    assert.throws(() => insertAdjustment(db, { id: `adjustment-${amount}`, household: `hwrong${amount}`, invoice: `invoice-${amount}`, batch: `batch-${amount}`, user: `uwrong${amount}`, amount }), /does not match/iu);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM card_invoice_adjustments").get().n, 0);
  }

  const db = database(t);
  seed(db);
  insertBatch(db, { opening: 130000, purchases: 0, installments: 0 });
  insertInvoice(db);
  insertAdjustment(db, { amount: 130000 });
  db.prepare("UPDATE card_invoice_adjustments SET status='voided',voided_at=? WHERE id='opening'").run(AT);
  assert.throws(() => insertAdjustment(db, { id: "replacement", amount: 130000 }), /cannot be replaced/iu);
  assert.throws(() => db.prepare("UPDATE card_invoice_adjustments SET status='active',voided_at=NULL WHERE id='opening'").run(), /cannot be changed/iu);
  assert.equal(db.prepare("SELECT status FROM card_invoice_adjustments WHERE id='opening'").get().status, "voided");
  healthy(db);
});

test("opening balance não pode ser estornado abaixo de pagamentos ativos", (t) => {
  const db = database(t);
  seed(db);
  insertBatch(db, { purchases: 0, installments: 0, opening: 140000 });
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("invoice", "ha", "carda", "2026-10", "2026-10-12", "2026-10-05", "open", AT, AT);
  db.prepare("INSERT INTO card_invoice_adjustments(id,household_id,invoice_id,import_batch_id,kind,amount_cents,status,created_by_user_id,created_at,voided_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("opening", "ha", "invoice", "batch", "opening_balance", 140000, "active", "ua", AT, null);
  db.prepare("INSERT INTO invoice_payment_operations(id,household_id,idempotency_key,kind,invoice_id,account_id,created_by_user_id,amount_cents,occurred_on,reversed_payment_id,request_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("operation", "ha", "payment", "payment", "invoice", "aa", "ua", 1, "2026-09-18", null, "fixture", AT);
  db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at,operation_id) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("payment", "ha", "invoice", "aa", 1, "2026-09-18", "ua", AT, "operation");
  assert.throws(
    () => db.prepare("UPDATE card_invoice_adjustments SET status='voided',voided_at=? WHERE id='opening'").run(AT),
    /cannot be voided below active payments/iu,
  );
  assert.deepEqual(
    { ...db.prepare("SELECT status,voided_at FROM card_invoice_adjustments WHERE id='opening'").get() },
    { status: "active", voided_at: null },
  );
  healthy(db);
});

test("adjustment não pode ser reduzido por REPLACE ou UPDATE OR REPLACE abaixo do já pago", (t) => {
  const db = database(t);
  seed(db);
  insertBatch(db, { purchases: 0, installments: 0, opening: 140000 });
  insertInvoice(db);
  insertAdjustment(db);
  db.prepare("INSERT INTO invoice_payment_operations(id,household_id,idempotency_key,kind,invoice_id,account_id,created_by_user_id,amount_cents,occurred_on,reversed_payment_id,request_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("operation", "ha", "payment", "payment", "invoice", "aa", "ua", 100000, "2026-09-18", null, "fixture", AT);
  db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at,operation_id) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("payment", "ha", "invoice", "aa", 100000, "2026-09-18", "ua", AT, "operation");
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO card_invoice_adjustments
    (id,household_id,invoice_id,import_batch_id,kind,amount_cents,status,created_by_user_id,created_at,voided_at)
    VALUES('opening','ha','invoice','batch','opening_balance',1,'active','ua',?,NULL)`).run(AT), /cannot be replaced|does not match/iu);
  assert.throws(() => db.prepare("UPDATE OR REPLACE card_invoice_adjustments SET amount_cents=1 WHERE id='opening'").run(), /immutable/iu);
  assert.throws(() => db.prepare("UPDATE card_invoice_adjustments SET status='voided',voided_at=? WHERE id='opening'").run(AT), /below active payments/iu);
  assert.deepEqual({ ...db.prepare("SELECT amount_cents,status,voided_at FROM card_invoice_adjustments WHERE id='opening'").get() }, { amount_cents: 140000, status: "active", voided_at: null });
  assert.equal(db.prepare("SELECT SUM(amount_cents) n FROM invoice_payments WHERE invoice_id='invoice'").get().n, 100000);
  healthy(db);
});

test("todos os campos identitários do adjustment são imutáveis por UPDATE e INSERT OR REPLACE", (t) => {
  const db = database(t);
  seed(db); seed(db, "b");
  insertBatch(db, { purchases: 0, installments: 0, opening: 140000 });
  insertInvoice(db);
  insertAdjustment(db);
  const updates = [
    ["id", "'changed-id'"], ["household_id", "'hb'"], ["invoice_id", "'changed-invoice'"],
    ["import_batch_id", "'changed-batch'"], ["kind", "'changed-kind'"], ["amount_cents", "1"],
    ["created_by_user_id", "'ub'"], ["created_at", "'2026-09-19T00:00:00.000Z'"],
  ];
  for (const [column, value] of updates) {
    assert.throws(() => db.prepare(`UPDATE card_invoice_adjustments SET ${column}=${value} WHERE id='opening'`).run(), /immutable|CHECK/iu, column);
    assert.throws(() => db.prepare(`UPDATE OR REPLACE card_invoice_adjustments SET ${column}=${value} WHERE id='opening'`).run(), /immutable|CHECK/iu, `OR REPLACE ${column}`);
  }
  const base = { id: "opening", household: "ha", invoice: "invoice", batch: "batch", kind: "opening_balance", amount: 140000, user: "ua", createdAt: AT };
  for (const [field, value] of [
    ["household", "hb"], ["invoice", "changed-invoice"], ["batch", "changed-batch"], ["kind", "changed-kind"],
    ["amount", 1], ["user", "ub"], ["createdAt", "2026-09-19T00:00:00.000Z"],
  ]) {
    const row = { ...base, [field]: value };
    assert.throws(() => db.prepare(`INSERT OR REPLACE INTO card_invoice_adjustments
      (id,household_id,invoice_id,import_batch_id,kind,amount_cents,status,created_by_user_id,created_at,voided_at)
      VALUES(?,?,?,?,?,?,?,?,?,NULL)`).run(row.id, row.household, row.invoice, row.batch, row.kind, row.amount, "active", row.user, row.createdAt), /cannot be replaced|does not match|CHECK/iu, String(field));
  }
  assert.deepEqual(
    { ...db.prepare("SELECT id,household_id,invoice_id,import_batch_id,kind,amount_cents,created_by_user_id,created_at FROM card_invoice_adjustments WHERE id='opening'").get() },
    { id: "opening", household_id: "ha", invoice_id: "invoice", import_batch_id: "batch", kind: "opening_balance", amount_cents: 140000, created_by_user_id: "ua", created_at: AT },
  );
  healthy(db);
});

test("batch concluído não pode ser substituído nem reescrever fatos financeiros", (t) => {
  const db = database(t);
  seed(db);
  insertCard(db);
  insertBatch(db, { declared: 0, opening: 0, purchases: 0, installments: 0 });
  insertInvoice(db);
  db.prepare("UPDATE card_import_batches SET status='completed',completed_at=? WHERE id='batch'").run(AT);
  const attempts = [
    "UPDATE card_import_batches SET request_fingerprint='changed' WHERE id='batch'",
    "UPDATE OR REPLACE card_import_batches SET declared_invoice_total_cents=1 WHERE id='batch'",
    "UPDATE OR REPLACE card_import_batches SET card_id='other-card' WHERE id='batch'",
  ];
  for (const sql of attempts) assert.throws(() => db.prepare(sql).run(), /immutable/iu);
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO card_import_batches
    (id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,
     declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at,completed_at,voided_at)
    VALUES('batch','ha','other-card','ua','changed-key','changed-fingerprint','2026-11',1,1,0,0,'pending',?,NULL,NULL)`).run(AT), /cannot be replaced/iu);
  assert.deepEqual(
    { ...db.prepare("SELECT card_id,request_fingerprint,declared_invoice_total_cents,status,completed_at FROM card_import_batches WHERE id='batch'").get() },
    { card_id: "carda", request_fingerprint: "fingerprint", declared_invoice_total_cents: 0, status: "completed", completed_at: AT },
  );
  assert.throws(() => db.prepare("DELETE FROM card_import_batches WHERE id='batch'").run(), /cannot be deleted/iu);
  insertPurchase(db, "late-purchase");
  assert.throws(() => insertMetadata(db, { id: "late", purchase: "late-purchase", first: 1, count: 1 }), /does not match/iu);
  healthy(db);
});

test("colisões de IDs protegidos nunca apagam purchase, invoice, installment, batch, metadata ou adjustment", (t) => {
  const db = database(t);
  seed(db);
  insertBatch(db, { purchases: 1, installments: 1, opening: 130000 });
  insertInvoice(db);
  insertPurchase(db);
  insertInstallment(db);
  insertMetadata(db, { first: 1, count: 1 });
  insertAdjustment(db, { amount: 130000 });
  assert.throws(() => insertBatch(db, { fingerprint: "replacement" }), /cannot be replaced/iu);
  assert.throws(() => insertMetadata(db, { total: 1 }), /cannot be replaced|does not match/iu);
  assert.throws(() => insertAdjustment(db, { amount: 1 }), /cannot be replaced|does not match/iu);
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO card_purchases
    (id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at)
    VALUES('purchase','ha','carda','Changed',1,'2026-09-02',1,'active','ua','system',?,?)`).run(AT, AT), /cannot be replaced/iu);
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO card_invoices
    (id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at)
    VALUES('invoice','ha','carda','2026-11','2026-11-12','2026-11-05','open',?,?)`).run(AT, AT), /cannot be replaced/iu);
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO card_installments
    (id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at)
    VALUES('part','ha','purchase','invoice',1,1,1,'pending',?,?)`).run(AT, AT), /cannot be replaced/iu);
  assert.equal(db.prepare("SELECT description FROM card_purchases WHERE id='purchase'").get().description, "Purchase purchase");
  assert.equal(db.prepare("SELECT reference_month FROM card_invoices WHERE id='invoice'").get().reference_month, "2026-10");
  assert.equal(db.prepare("SELECT amount_cents FROM card_installments WHERE id='part'").get().amount_cents, 10000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM card_purchase_import_metadata").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM card_invoice_adjustments").get().n, 1);
  healthy(db);
});

test("schema Drizzle permanece alinhado às três tabelas da 0006", () => {
  const batch = getTableConfig(cardImportBatches);
  const adjustment = getTableConfig(cardInvoiceAdjustments);
  const metadata = getTableConfig(cardPurchaseImportMetadata);
  assert.equal(batch.name, "card_import_batches");
  assert.equal(adjustment.name, "card_invoice_adjustments");
  assert.equal(metadata.name, "card_purchase_import_metadata");
  assert.ok(batch.columns.some((column) => column.name === "opening_balance_cents"));
  assert.ok(adjustment.columns.some((column) => column.name === "voided_at"));
  assert.ok(metadata.columns.some((column) => column.name === "first_original_installment_number"));
});

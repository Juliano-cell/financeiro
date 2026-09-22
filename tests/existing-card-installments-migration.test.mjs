import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATION = "0010_existing_card_installments.sql";
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
const AT = "2026-09-18T12:00:00.000Z";

function apply(db, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const sql of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(sql);
}

function database(t, through = MIGRATION) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations.filter((name) => name <= through)) apply(db, name);
  t.after(() => db.close()); return db;
}

function seedCompletedInitial(db) {
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("user", "User", "user@example.com", AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run("house", "House", "user", AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run("member", "house", "user", "owner", "active", AT);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("card", "house", "Card", "Bank", "User", 100000, 5, 12, 1, AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("invoice", "house", "card", "2026-10", "2026-10-12", "2026-10-05", "open", AT, AT);
  db.prepare(`INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("batch", "house", "card", "user", "initial-key", "fingerprint", "2026-10", 10000, 0, 1, 1, "pending", AT);
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("purchase", "house", "card", "Existing", 10000, "2026-09-01", 1, "active", "user", "system", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("installment", "house", "purchase", "invoice", 1, 1, 10000, "pending", AT, AT);
  db.prepare("INSERT INTO card_purchase_import_metadata(id,household_id,purchase_id,import_batch_id,first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date,imported_at) VALUES(?,?,?,?,?,?,?,?,?)").run("metadata", "house", "purchase", "batch", 10, 10, 100000, "2025-12-01", AT);
  db.prepare("UPDATE card_import_batches SET status='completed', completed_at=? WHERE id='batch'").run(AT);
}

test("0010 aplica em banco limpo após 0000–0009 com FK e integridade válidas", (t) => {
  const db = database(t);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(db.prepare("SELECT dflt_value FROM pragma_table_info('card_import_batches') WHERE name='import_kind'").get().dflt_value, "'initial_state'");
});

test("upgrade 0009→0010 preserva batch, metadata e fatos existentes como initial_state", (t) => {
  const db = database(t, "0009_notification_transport_state.sql");
  seedCompletedInitial(db);
  const before = {
    batch: { ...db.prepare("SELECT * FROM card_import_batches WHERE id='batch'").get() },
    metadata: { ...db.prepare("SELECT * FROM card_purchase_import_metadata WHERE id='metadata'").get() },
    purchase: { ...db.prepare("SELECT * FROM card_purchases WHERE id='purchase'").get() },
    installment: { ...db.prepare("SELECT * FROM card_installments WHERE id='installment'").get() },
  };
  apply(db, MIGRATION);
  const upgraded = { ...db.prepare("SELECT * FROM card_import_batches WHERE id='batch'").get() };
  assert.equal(upgraded.import_kind, "initial_state"); delete upgraded.import_kind;
  assert.deepEqual(upgraded, before.batch);
  assert.deepEqual({ ...db.prepare("SELECT * FROM card_purchase_import_metadata WHERE id='metadata'").get() }, before.metadata);
  assert.deepEqual({ ...db.prepare("SELECT * FROM card_purchases WHERE id='purchase'").get() }, before.purchase);
  assert.deepEqual({ ...db.prepare("SELECT * FROM card_installments WHERE id='installment'").get() }, before.installment);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0); assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("0010 cria índices parciais corretos e mantém somente um initial_state", (t) => {
  const db = database(t, "0009_notification_transport_state.sql"); seedCompletedInitial(db); apply(db, MIGRATION);
  const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='card_import_batches'").all();
  assert.ok(indexes.some((row) => row.name === "card_import_batches_initial_card_unique" && /import_kind.*initial_state/iu.test(row.sql)));
  assert.ok(indexes.some((row) => row.name === "card_import_batches_pending_card_unique" && /status.*pending/iu.test(row.sql)));
  assert.ok(!indexes.some((row) => row.name === "card_import_batches_active_card_unique"));
  assert.throws(() => db.prepare(`INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,import_kind,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("second-initial", "house", "card", "user", "second-key", "second-fp", "initial_state", "2026-10", 10000, 0, 0, 0, "pending", AT), /financial identity|unique/iu);
});

test("existing_installments exige opening zero e import_kind permanece imutável", (t) => {
  const db = database(t, "0009_notification_transport_state.sql"); seedCompletedInitial(db); apply(db, MIGRATION);
  const insert = db.prepare(`INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,import_kind,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  assert.throws(() => insert.run("bad-opening", "house", "card", "user", "bad-key", "bad-fp", "existing_installments", "2026-10", 10000, 1, 0, 0, "pending", AT), /cannot create opening balance/iu);
  insert.run("supplemental", "house", "card", "user", "supplemental-key", "supplemental-fp", "existing_installments", "2026-10", 10000, 0, 0, 0, "pending", AT);
  assert.throws(() => db.exec("UPDATE card_import_batches SET import_kind='initial_state' WHERE id='supplemental'"), /financial identity is immutable/iu);
});

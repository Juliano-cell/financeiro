import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATION = "0011_card_opening_balance_allocations.sql";
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

function seedBase(db) {
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("user", "User", "user@example.com", AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run("house", "House", "user", AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run("member", "house", "user", "owner", "active", AT);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("card", "house", "Card", "Bank", "User", 100000, 5, 12, 1, AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("invoice", "house", "card", "2026-10", "2026-10-12", "2026-10-05", "open", AT, AT);
}

function seedCompletedOpening(db) {
  seedBase(db);
  db.prepare(`INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,import_kind,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("initial", "house", "card", "user", "initial-key", "initial-fp", "initial_state", "2026-10", 10000, 10000, 0, 0, "pending", AT);
  db.prepare("INSERT INTO card_invoice_adjustments(id,household_id,invoice_id,import_batch_id,kind,amount_cents,status,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("opening", "house", "invoice", "initial", "opening_balance", 10000, "active", "user", AT);
  db.prepare("UPDATE card_import_batches SET status='completed',completed_at=? WHERE id='initial'").run(AT);
}

function seedSource(db, suffix, amount) {
  db.prepare(`INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,import_kind,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`source-${suffix}`, "house", "card", "user", `source-key-${suffix}`, `source-fp-${suffix}`, "existing_installments", "2026-10", 10000, 0, 1, 1, "pending", AT);
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`purchase-${suffix}`, "house", "card", `Purchase ${suffix}`, amount, "2026-09-01", 1, "active", "user", "system", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(`installment-${suffix}`, "house", `purchase-${suffix}`, "invoice", 1, 1, amount, "pending", AT, AT);
  db.prepare("INSERT INTO card_purchase_import_metadata(id,household_id,purchase_id,import_batch_id,first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date,imported_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(`metadata-${suffix}`, "house", `purchase-${suffix}`, `source-${suffix}`, 1, 1, amount, "2026-09-01", AT);
}

function insertAllocation(db, suffix, amount) {
  return db.prepare("INSERT INTO card_opening_balance_allocations(id,household_id,opening_adjustment_id,initial_import_batch_id,source_import_batch_id,invoice_id,purchase_id,installment_id,amount_cents,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(`allocation-${suffix}`, "house", "opening", "initial", `source-${suffix}`, "invoice", `purchase-${suffix}`, `installment-${suffix}`, amount, "user", AT);
}

test("0011 aplica em banco limpo após 0000–0010 com FK e integridade válidas", (t) => {
  const db = database(t);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pragma_table_info('card_opening_balance_allocations')").get().n, 11);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("upgrade 0010→0011 não faz backfill nem altera fatos existentes", (t) => {
  const db = database(t, "0010_existing_card_installments.sql");
  seedBase(db);
  const before = { ...db.prepare("SELECT * FROM card_invoices WHERE id='invoice'").get() };
  apply(db, MIGRATION);
  assert.deepEqual({ ...db.prepare("SELECT * FROM card_invoices WHERE id='invoice'").get() }, before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM card_opening_balance_allocations").get().n, 0);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("allocation válida conclui lote, preserva opening original e mantém total efetivo", (t) => {
  const db = database(t); seedCompletedOpening(db); seedSource(db, "one", 5000); insertAllocation(db, "one", 5000);
  db.prepare("UPDATE card_import_batches SET status='completed',completed_at=? WHERE id='source-one'").run(AT);
  assert.equal(db.prepare("SELECT amount_cents FROM card_invoice_adjustments WHERE id='opening'").get().amount_cents, 10000);
  const effective = db.prepare(`SELECT COALESCE((SELECT SUM(amount_cents) FROM card_installments WHERE invoice_id='invoice'),0)+COALESCE((SELECT SUM(amount_cents) FROM card_invoice_adjustments WHERE invoice_id='invoice' AND status='active'),0)-COALESCE((SELECT SUM(amount_cents) FROM card_opening_balance_allocations WHERE invoice_id='invoice'),0) total`).get().total;
  assert.equal(effective, 10000);
});

test("constraints e triggers bloqueiam relação inválida, duplicidade, excesso, update e delete", (t) => {
  const db = database(t); seedCompletedOpening(db); seedSource(db, "one", 5000); insertAllocation(db, "one", 5000);
  db.prepare("UPDATE card_import_batches SET status='completed',completed_at=? WHERE id='source-one'").run(AT);
  assert.throws(() => db.prepare("UPDATE card_opening_balance_allocations SET amount_cents=4000 WHERE id='allocation-one'").run(), /immutable/iu);
  assert.throws(() => db.prepare("DELETE FROM card_opening_balance_allocations WHERE id='allocation-one'").run(), /cannot be deleted/iu);
  assert.throws(() => db.prepare("INSERT INTO card_opening_balance_allocations(id,household_id,opening_adjustment_id,initial_import_batch_id,source_import_batch_id,invoice_id,purchase_id,installment_id,amount_cents,created_by_user_id,created_at) VALUES('bad','house','missing','initial','source-one','invoice','purchase-one','installment-one',5000,'user',?)").run(AT), /financial facts|foreign key|exceeds residual/iu);
  assert.throws(() => db.prepare("INSERT INTO card_opening_balance_allocations(id,household_id,opening_adjustment_id,initial_import_batch_id,source_import_batch_id,invoice_id,purchase_id,installment_id,amount_cents,created_by_user_id,created_at) VALUES('duplicate','house','opening','initial','source-one','invoice','purchase-one','installment-one',5000,'user',?)").run(AT), /unique|financial facts|financial identity/iu);
  seedSource(db, "two", 6000);
  assert.throws(() => insertAllocation(db, "two", 6000), /exceeds residual/iu);
});

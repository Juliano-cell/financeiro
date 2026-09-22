import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

register(`data:text/javascript,${encodeURIComponent(`
  import { existsSync, statSync } from "node:fs";
  import { dirname, extname, resolve as resolvePath } from "node:path";
  import { fileURLToPath, pathToFileURL } from "node:url";
  const root = ${JSON.stringify(process.cwd())};
  function file(path) { return (extname(path) ? [path] : [path, path + ".ts", path + ".mjs", path + ".tsx", resolvePath(path, "index.ts")]).find(p => existsSync(p) && statSync(p).isFile()); }
  export async function resolve(specifier, context, next) {
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);

const { addExistingCardInstallment, configureCardCurrentState, CardOnboardingError } = await import("../lib/card-onboarding-service.ts?existing-installments-tests");
const { resolveInstallmentDisplay } = await import("../lib/card-onboarding-ui-rules.mjs?existing-installments-tests");
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
const AT = "2026-09-18T12:00:00.000Z";

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  runSync() { const statement = this.db.prepare(this.sql); const result = statement.columns().length ? { changes: 0 } : statement.run(...this.bindings); return { success: true, results: [], meta: { changes: result.changes } }; }
  async run() { return this.runSync(); }
}

class LocalD1 {
  constructor(db) { this.db = db; this.beforeStatement = null; }
  prepare(sql) { return new Statement(this.db, sql); }
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

function seedHousehold(db, suffix) {
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `House ${suffix}`, `u${suffix}`, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(`account-${suffix}`, `h${suffix}`, `Account ${suffix}`, "bank", 200000, 1, AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`category-${suffix}`, `h${suffix}`, `Category ${suffix}`, "expense", 1, AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`subcategory-${suffix}`, `h${suffix}`, `category-${suffix}`, `Subcategory ${suffix}`, 1, AT, AT);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(`card-${suffix}`, `h${suffix}`, `Card ${suffix}`, "Bank", `User ${suffix}`, 500000, 5, 12, 1, AT, AT);
}

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) for (const sql of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(sql);
  seedHousehold(db, "a"); seedHousehold(db, "b");
  const d1 = new LocalD1(db);
  const context = { d1, householdId: "ha", userId: "ua", timestamp: AT };
  t.after(() => { assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0); db.close(); });
  return { db, d1, context };
}

const initial = { cardId: "card-a", initialReferenceMonth: "2026-10", declaredCurrentInvoiceTotalCents: 140000, idempotencyKey: "initial", commitments: [] };
const supplemental = {
  cardId: "card-a", firstReferenceMonth: "2026-10", idempotencyKey: "supplemental-1",
  commitment: { description: "Compra esquecida", installmentAmountCents: 10000, originalInstallmentCount: 12, firstOriginalInstallmentNumber: 10, originalTotalCents: 120000, originalPurchaseDate: "2025-11-10", categoryId: "category-a", subcategoryId: "subcategory-a", notes: "Importada depois" },
};

async function configured(t) { const fixture = setup(t); await configureCardCurrentState(initial, fixture.context); return fixture; }
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

test("primeiro parcelamento complementar cria somente 10/12–12/12 e preserva opening balance", async (t) => {
  const f = await configured(t);
  const beforeAdjustment = f.db.prepare("SELECT id, amount_cents FROM card_invoice_adjustments").get();
  const result = await addExistingCardInstallment(supplemental, f.context);
  assert.equal(result.importedPurchaseCount, 1); assert.equal(result.importedInstallmentCount, 3); assert.equal(result.openingBalanceCents, 0);
  const batch = f.db.prepare("SELECT import_kind, opening_balance_cents, status FROM card_import_batches WHERE id=?").get(result.batchId);
  assert.deepEqual({ ...batch }, { import_kind: "existing_installments", opening_balance_cents: 0, status: "completed" });
  const metadata = f.db.prepare("SELECT first_original_installment_number first, original_installment_count total FROM card_purchase_import_metadata WHERE import_batch_id=?").get(result.batchId);
  const physical = f.db.prepare("SELECT installment_number n, installment_count c FROM card_installments WHERE purchase_id=(SELECT purchase_id FROM card_purchase_import_metadata WHERE import_batch_id=?) ORDER BY n").all(result.batchId);
  assert.deepEqual(physical.map((part) => resolveInstallmentDisplay({ physicalNumber: part.n, physicalCount: part.c, origin: "system", metadataValid: true, firstOriginalNumber: metadata.first, originalCount: metadata.total })), [{ installmentNumber: 10, installmentCount: 12 }, { installmentNumber: 11, installmentCount: 12 }, { installmentNumber: 12, installmentCount: 12 }]);
  assert.deepEqual(f.db.prepare("SELECT id, amount_cents FROM card_invoice_adjustments").get(), beforeAdjustment);
  assert.equal(count(f.db, "card_invoice_adjustments"), 1);
});

test("segundo e terceiro batches complementares são permitidos e segundo initial_state continua proibido", async (t) => {
  const f = await configured(t);
  await addExistingCardInstallment(supplemental, f.context);
  await addExistingCardInstallment({ ...supplemental, idempotencyKey: "supplemental-2", commitment: { ...supplemental.commitment, description: "Outra compra", firstOriginalInstallmentNumber: 11 } }, f.context);
  await addExistingCardInstallment({ ...supplemental, idempotencyKey: "supplemental-3", commitment: { ...supplemental.commitment, description: "Terceira compra", firstOriginalInstallmentNumber: 12 } }, f.context);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_import_batches WHERE import_kind='existing_installments' AND status='completed'").get().n, 3);
  await assert.rejects(configureCardCurrentState({ ...initial, idempotencyKey: "second-initial" }, f.context), (error) => error instanceof CardOnboardingError && error.code === "CARD_ONBOARDING_INELIGIBLE");
});

test("invoice existente é reutilizada, futuras são criadas uma vez e totais são derivados", async (t) => {
  const f = await configured(t);
  const initialInvoiceId = f.db.prepare("SELECT id FROM card_invoices WHERE reference_month='2026-10'").get().id;
  await addExistingCardInstallment(supplemental, f.context);
  assert.equal(f.db.prepare("SELECT id FROM card_invoices WHERE reference_month='2026-10'").get().id, initialInvoiceId);
  assert.deepEqual(f.db.prepare("SELECT reference_month month, COUNT(*) n FROM card_invoices GROUP BY reference_month ORDER BY month").all().map((row) => ({ ...row })), [{ month: "2026-10", n: 1 }, { month: "2026-11", n: 1 }, { month: "2026-12", n: 1 }]);
  const total = f.db.prepare(`SELECT COALESCE((SELECT SUM(amount_cents) FROM card_installments WHERE invoice_id=i.id AND status<>'cancelled'),0)+COALESCE((SELECT SUM(amount_cents) FROM card_invoice_adjustments WHERE invoice_id=i.id AND status='active'),0) total FROM card_invoices i WHERE reference_month='2026-10'`).get().total;
  assert.equal(total, 150000);
});

test("invoice existente preserva snapshot histórico após mudança de vencimento do cartão", async (t) => {
  const f = await configured(t);
  const original = { ...f.db.prepare("SELECT id, due_date, closes_on FROM card_invoices WHERE reference_month='2026-10'").get() };
  f.db.prepare("UPDATE credit_cards SET closing_day=10, due_day=20, updated_at=? WHERE id='card-a'").run("2026-09-18T13:00:00.000Z");
  await addExistingCardInstallment(supplemental, { ...f.context, timestamp: "2026-09-18T13:00:00.000Z" });
  assert.deepEqual({ ...f.db.prepare("SELECT id, due_date, closes_on FROM card_invoices WHERE reference_month='2026-10'").get() }, original);
  assert.deepEqual({ ...f.db.prepare("SELECT due_date, closes_on FROM card_invoices WHERE reference_month='2026-11'").get() }, { due_date: "2026-11-20", closes_on: "2026-11-10" });
});

test("inclusão não movimenta contas, transactions ou pagamentos", async (t) => {
  const f = await configured(t);
  const balance = f.db.prepare("SELECT initial_balance_cents FROM accounts WHERE id='account-a'").get().initial_balance_cents;
  await addExistingCardInstallment(supplemental, f.context);
  assert.equal(f.db.prepare("SELECT initial_balance_cents FROM accounts WHERE id='account-a'").get().initial_balance_cents, balance);
  assert.equal(count(f.db, "transactions"), 0); assert.equal(count(f.db, "invoice_payments"), 0); assert.equal(count(f.db, "invoice_payment_operations"), 0);
});

test("retry é idempotente e mesma chave com payload diferente conflita", async (t) => {
  const f = await configured(t);
  const first = await addExistingCardInstallment(supplemental, f.context);
  const replay = await addExistingCardInstallment(supplemental, f.context);
  assert.equal(replay.batchId, first.batchId); assert.equal(replay.replayed, true); assert.equal(count(f.db, "card_purchases"), 1);
  await assert.rejects(addExistingCardInstallment({ ...supplemental, commitment: { ...supplemental.commitment, description: "Mudou" } }, f.context), (error) => error.code === "CARD_ONBOARDING_IDEMPOTENCY_CONFLICT");
});

test("cartão inativo, outro household e membership inativa são rejeitados", async (t) => {
  const f = await configured(t);
  f.db.exec("UPDATE credit_cards SET is_active=0 WHERE id='card-a'");
  await assert.rejects(addExistingCardInstallment(supplemental, f.context), (error) => error.code === "CARD_IMPORT_CARD_NOT_FOUND");
  f.db.exec("UPDATE credit_cards SET is_active=1 WHERE id='card-a'");
  await assert.rejects(addExistingCardInstallment({ ...supplemental, cardId: "card-b" }, f.context), (error) => error.code === "CARD_IMPORT_CARD_NOT_FOUND");
  f.db.exec("UPDATE household_members SET status='inactive' WHERE id='ma'");
  await assert.rejects(addExistingCardInstallment(supplemental, f.context), (error) => error.status === 403);
});

test("ciclo fechado rejeita e falha intermediária reverte tudo", async (t) => {
  const closed = await configured(t);
  closed.db.exec("UPDATE card_invoices SET status='closed' WHERE reference_month='2026-10'");
  const beforeClosed = count(closed.db, "card_import_batches");
  await assert.rejects(addExistingCardInstallment(supplemental, closed.context), (error) => error.code === "CARD_IMPORT_INVOICE_CLOSED");
  assert.equal(count(closed.db, "card_import_batches"), beforeClosed);

  const failed = await configured(t);
  const before = Object.fromEntries(["card_import_batches", "card_purchases", "card_installments", "card_invoices", "card_purchase_import_metadata", "audit_logs"].map((table) => [table, count(failed.db, table)]));
  failed.d1.beforeStatement = (_statement, index) => { if (index === 4) throw new Error("forced intermediate failure"); };
  await assert.rejects(addExistingCardInstallment(supplemental, failed.context), /forced intermediate failure/iu);
  assert.deepEqual(Object.fromEntries(Object.keys(before).map((table) => [table, count(failed.db, table)])), before);
});

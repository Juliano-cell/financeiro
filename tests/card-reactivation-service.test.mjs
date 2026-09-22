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

const { configureCardCurrentState } = await import("../lib/card-onboarding-service.ts?reactivation-tests");
const { deactivateCard, reactivateCard, CardServiceError } = await import("../lib/card-service.ts?reactivation-tests");
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
const AT = "2026-09-18T12:00:00.000Z";

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  runSync() { const result = this.db.prepare(this.sql).run(...this.bindings); return { success: true, results: [], meta: { changes: result.changes } }; }
  async run() { return this.runSync(); }
}
class LocalD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) { this.db.exec("BEGIN IMMEDIATE"); try { const results = statements.map((statement) => statement.runSync()); this.db.exec("COMMIT"); return results; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
}

function setup(t) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) for (const sql of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(sql);
  for (const suffix of ["a", "b"]) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
    db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `House ${suffix}`, `u${suffix}`, AT, AT);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", AT);
    db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(`card-${suffix}`, `h${suffix}`, `Card ${suffix}`, "Bank", `User ${suffix}`, 500000, 5, 12, 1, AT, AT);
  }
  const d1 = new LocalD1(db); const context = { d1, householdId: "ha", userId: "ua", timestamp: AT };
  t.after(() => { assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0); db.close(); });
  return { db, context };
}

const financialTables = ["card_purchases", "card_installments", "card_invoices", "card_import_batches", "card_purchase_import_metadata", "card_invoice_adjustments", "invoice_payments", "invoice_payment_operations"];
const snapshot = (db) => Object.fromEntries(financialTables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row }))]));

test("ativo → inativo → reativado preserva todos os fatos financeiros", async (t) => {
  const f = setup(t);
  await configureCardCurrentState({ cardId: "card-a", initialReferenceMonth: "2026-10", declaredCurrentInvoiceTotalCents: 140000, idempotencyKey: "initial", commitments: [{ description: "Anterior", installmentAmountCents: 10000, firstOriginalInstallmentNumber: 10, originalInstallmentCount: 12 }] }, f.context);
  const before = snapshot(f.db);
  const deactivated = await deactivateCard("card-a", f.context); assert.equal(deactivated.inactivated, true); assert.equal(f.db.prepare("SELECT is_active FROM credit_cards WHERE id='card-a'").get().is_active, 0);
  const result = await reactivateCard("card-a", f.context); assert.equal(result.reactivated, true); assert.equal(result.replayed, false); assert.equal(f.db.prepare("SELECT is_active FROM credit_cards WHERE id='card-a'").get().is_active, 1);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='reactivate' AND entity_id='card-a'").get().n, 1);
});

test("reativar cartão já ativo e segunda reativação são idempotentes sem auditoria duplicada", async (t) => {
  const f = setup(t);
  const active = await reactivateCard("card-a", f.context); assert.equal(active.replayed, true); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='reactivate'").get().n, 0);
  await deactivateCard("card-a", f.context); await reactivateCard("card-a", f.context); const second = await reactivateCard("card-a", f.context);
  assert.equal(second.replayed, true); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='reactivate'").get().n, 1);
});

test("outro household e membership inativa não podem reativar", async (t) => {
  const f = setup(t); f.db.exec("UPDATE credit_cards SET is_active=0");
  await assert.rejects(reactivateCard("card-b", f.context), (error) => error instanceof CardServiceError && error.code === "CARD_NOT_FOUND");
  f.db.exec("UPDATE household_members SET status='inactive' WHERE id='ma'");
  await assert.rejects(reactivateCard("card-a", f.context), (error) => error instanceof CardServiceError && error.code === "CARD_MEMBERSHIP");
  assert.equal(f.db.prepare("SELECT is_active FROM credit_cards WHERE id='card-a'").get().is_active, 0);
});

test("UI separa ativos/inativos, reativa e mantém inativos fora de novas compras", () => {
  const source = readFileSync(new URL("../app/advanced-finance.tsx", import.meta.url), "utf8");
  assert.match(source, /Cartões ativos/u); assert.match(source, /Cartões inativos \(/u); assert.match(source, /Reativar cartão/u);
  assert.match(source, /data\.cards\.filter\(\(item\) => item\.isActive\).*\.map/su);
  assert.match(source, /card\.isActive && .*CardExistingInstallmentAction/su);
});

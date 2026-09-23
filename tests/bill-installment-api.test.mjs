import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { digestToken } from "../lib/auth-crypto.mjs";

const runtime = globalThis.__telegramHandlerTestEnv ?? {};
globalThis.__telegramHandlerTestEnv = runtime;
register(`data:text/javascript,${encodeURIComponent(`
  import { existsSync, statSync } from "node:fs";
  import { dirname, extname, resolve as resolvePath } from "node:path";
  import { fileURLToPath, pathToFileURL } from "node:url";
  const root = ${JSON.stringify(process.cwd())};
  function file(path) { return (extname(path) ? [path] : [path, path + ".ts", path + ".mjs", path + ".tsx", resolvePath(path, "index.ts")]).find(p => existsSync(p) && statSync(p).isFile()); }
  export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { shortCircuit: true, url: "data:text/javascript,export const env=globalThis.__telegramHandlerTestEnv" };
    if (specifier === "next/headers") return { shortCircuit: true, url: "data:text/javascript,export async function cookies(){const value=globalThis.__billInstallmentApiCookie ?? globalThis.__cardOnboardingApiCookie ?? globalThis.__notificationPreferencesApiCookie ?? globalThis.__invoiceTestCookie;return {get:()=>value ? {value} : undefined}}" };
    if (specifier === "next/server") return next("next/server.js", context);
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);

const route = await import("../app/api/finance/advanced/route.ts?bill-installment-api");
const COOKIE = "bill-installment-api-session";
const SESSION_ID = await digestToken(COOKIE);
const AT = "2026-09-23T12:00:00.000Z";
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async raw() { const statement = this.db.prepare(this.sql); const columns = statement.columns().map((column) => column.name); return statement.all(...this.bindings).map((row) => columns.map((column) => row[column])); }
  runSync() { const statement = this.db.prepare(this.sql); if (statement.columns().length) return { success: true, results: statement.all(...this.bindings), meta: { changes: 0 } }; const result = statement.run(...this.bindings); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
  async run() { return this.runSync(); }
}

class LocalD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const results = statements.map((statement) => statement.runSync()); this.db.exec("COMMIT"); return results; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function seedHousehold(db, suffix) {
  const user = `user-${suffix}`; const household = `house-${suffix}`; const category = `category-${suffix}`; const subcategory = `subcategory-${suffix}`; const account = `account-${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, `${user}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, household, user, "owner", "active", AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(category, household, category, "expense", 1, AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(subcategory, household, category, subcategory, 1, AT, AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(account, household, account, "bank", 100000, 1, AT, AT);
  return { user, household, category, subcategory, account };
}

function setTestCookie(value) {
  globalThis.__billInstallmentApiCookie = value;
  globalThis.__accountStatementApiCookie = value;
  globalThis.__cardOnboardingApiCookie = value;
  globalThis.__notificationPreferencesApiCookie = value;
  globalThis.__invoiceTestCookie = value;
}

function setup(t) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) {
    const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const sql of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(sql);
  }
  const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)").run(SESSION_ID, a.user, "2027-12-01T00:00:00.000Z", AT, AT);
  runtime.DB = new LocalD1(db); setTestCookie(COOKIE);
  t.after(() => { setTestCookie(undefined); assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0); assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); db.close(); });
  return { db, a, b };
}

const payload = {
  action: "create_installment_bill_series",
  operationId: "installment-api-operation",
  description: "Móveis",
  totalAmountCents: 500000,
  installmentCount: 3,
  firstDueDate: "2026-10-23",
  categoryId: "category-a",
  subcategoryId: "subcategory-a",
  accountId: "account-a",
  notes: "Contrato",
};

async function post(body = payload, options = {}) {
  const response = await route.POST(new Request("https://fixture.invalid/api/finance/advanced", { method: "POST", headers: { origin: "https://fixture.invalid", "content-type": "application/json", ...options.headers }, body: options.raw ?? JSON.stringify(body) }));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function get(month = "2026-10") {
  const response = await route.GET(new Request(`https://fixture.invalid/api/finance/advanced?month=${month}`));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("API rejeita ausência de sessão e origem inválida", async (t) => {
  setup(t); setTestCookie(undefined);
  assert.equal((await post()).status, 401); assert.equal((await get()).status, 401);
  setTestCookie(COOKIE);
  assert.equal((await post(payload, { headers: { origin: "https://attacker.invalid" } })).status, 403);
});

test("API valida payload estrito, limites e data civil", async (t) => {
  const f = setup(t);
  for (const invalid of [
    { ...payload, extra: true }, { ...payload, operationId: "" }, { ...payload, totalAmountCents: 1 },
    { ...payload, totalAmountCents: 100_000_000_001 }, { ...payload, installmentCount: 1 },
    { ...payload, installmentCount: 121 }, { ...payload, firstDueDate: "2027-02-29" },
  ]) assert.equal((await post(invalid)).status, 400);
  assert.equal(f.db.prepare("SELECT count(*) total FROM bill_installment_series").get().total, 0);
});

test("API cria série e retorna somente contrato público e plano", async (t) => {
  const f = setup(t); const result = await post();
  assert.equal(result.status, 201); assert.equal(result.headers.get("cache-control"), "private, no-store"); assert.equal(result.body.replayed, false);
  assert.equal(result.body.billIds.length, 3); assert.deepEqual(result.body.plan.map((item) => item.amountCents), [166666, 166667, 166667]); assert.ok(result.body.plan.every((item) => item.billId));
  assert.doesNotMatch(JSON.stringify(result.body), /fingerprint|idempotency|installment-api-operation/iu);
  assert.equal(f.db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
});

test("API retorna replay e conflito idempotente", async (t) => {
  const f = setup(t); const first = await post(); const replay = await post();
  assert.equal(first.status, 201); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.seriesId, first.body.seriesId); assert.deepEqual(replay.body.billIds, first.body.billIds);
  const conflict = await post({ ...payload, notes: "diferente" }); assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "BILL_INSTALLMENT_IDEMPOTENCY_CONFLICT");
  assert.equal(f.db.prepare("SELECT count(*) total FROM bill_installment_series").get().total, 1);
});

test("API bloqueia relações de outro household", async (t) => {
  const f = setup(t);
  for (const changes of [
    { categoryId: f.b.category, subcategoryId: f.b.subcategory },
    { subcategoryId: f.b.subcategory },
    { accountId: f.b.account },
  ]) assert.equal((await post({ ...payload, operationId: crypto.randomUUID(), ...changes })).status, 400);
  assert.equal(f.db.prepare("SELECT count(*) total FROM bill_installment_series").get().total, 0);
});

test("GET enriquece bills parceladas em lote e mantém bill normal com installment null", async (t) => {
  const f = setup(t); const created = await post();
  f.db.prepare(`INSERT INTO bills(id,household_id,description,amount_cents,category_id,subcategory_id,due_date,account_id,recurrence,status,created_by_user_id,origin,created_at,updated_at)
    VALUES('normal','house-a','Normal',1000,'category-a','subcategory-a','2026-10-20','account-a','none','pending','user-a','web',?,?)`).run(AT, AT);
  const result = await get(); assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "private, no-store");
  const normal = result.body.bills.find((bill) => bill.id === "normal"); assert.equal(normal.installment, null);
  const parcelled = result.body.bills.filter((bill) => created.body.billIds.includes(bill.id)); assert.equal(parcelled.length, 3);
  assert.deepEqual(parcelled.map((bill) => bill.installment.number), [1, 2, 3]);
  assert.ok(parcelled.every((bill) => bill.installment.seriesId === created.body.seriesId && bill.installment.count === 3 && bill.installment.originalTotalCents === 500000 && bill.installment.firstDueDate === "2026-10-23"));
});

test("GET e POST não expõem séries de outro household", async (t) => {
  const f = setup(t); await post();
  f.db.prepare(`INSERT INTO bill_installment_series(id,household_id,description,total_amount_cents,installment_count,first_due_date,configured_day,category_id,subcategory_id,account_id,idempotency_key,request_fingerprint,created_by_user_id,origin,created_at,updated_at)
    VALUES('foreign-series','house-b','Foreign',200,2,'2026-10-10',10,'category-b','subcategory-b','account-b','foreign-key',?,'user-b','web',?,?)`).run("b".repeat(64), AT, AT);
  const result = await get(); assert.equal(result.status, 200); assert.doesNotMatch(JSON.stringify(result.body), /foreign-series|Foreign/);
});

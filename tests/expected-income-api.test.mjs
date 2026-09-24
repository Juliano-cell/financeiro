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
    if (specifier === "next/headers") return { shortCircuit: true, url: "data:text/javascript,export async function cookies(){const value=globalThis.__expectedIncomeApiCookie;return {get:()=>value ? {value} : undefined}}" };
    if (specifier === "next/server") return next("next/server.js", context);
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);

const route = await import("../app/api/finance/expected-income/route.ts?expected-income-api");
const COOKIE = "expected-income-api-session";
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
  constructor(db) { this.db = db; this.sql = []; }
  prepare(sql) { this.sql.push(sql); return new Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const results = statements.map((statement) => statement.runSync()); this.db.exec("COMMIT"); return results; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function seedHousehold(db, suffix) {
  const user = `user-${suffix}`; const household = `house-${suffix}`; const account = `account-${suffix}`; const otherAccount = `account-${suffix}-other`; const category = `category-${suffix}`; const subcategory = `subcategory-${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, `${user}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, household, user, "owner", "active", AT);
  for (const id of [account, otherAccount]) db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, household, id, "bank", 0, 1, AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(category, household, category, "income", 1, AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(subcategory, household, category, subcategory, 1, AT, AT);
  return { user, household, account, otherAccount, category, subcategory };
}

function setTestCookie(value) {
  globalThis.__expectedIncomeApiCookie = value;
  globalThis.__accountStatementApiCookie = value;
  globalThis.__forecastApiCookie = value;
  globalThis.__billInstallmentApiCookie = value;
  globalThis.__cardOnboardingApiCookie = value;
  globalThis.__notificationPreferencesApiCookie = value;
  globalThis.__invoiceTestCookie = value;
}

function setup(t) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) for (const sql of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(sql);
  const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)").run(SESSION_ID, a.user, "2027-12-01T00:00:00.000Z", AT, AT);
  const d1 = new LocalD1(db); runtime.DB = d1; setTestCookie(COOKIE);
  t.after(() => { setTestCookie(undefined); assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0); assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); db.close(); });
  return { db, d1, a, b };
}

const base = { action: "create_occurrence", operationId: "create-one", description: "Salário", expectedAmountCents: 20000, expectedDate: "2026-09-30", plannedAccountId: "account-a", categoryId: "category-a", subcategoryId: "subcategory-a", notes: "Prevista" };
async function post(body = base, options = {}) {
  const response = await route.POST(new Request("https://fixture.invalid/api/finance/expected-income", { method: "POST", headers: { origin: "https://fixture.invalid", "content-type": "application/json", ...options.headers }, body: options.raw ?? JSON.stringify(body) }));
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function get(query = "") { const response = await route.GET(new Request(`https://fixture.invalid/api/finance/expected-income${query}`)); return { status: response.status, headers: response.headers, body: await response.json() }; }

test("GET e POST exigem sessão e POST exige same-origin", async (t) => {
  setup(t); setTestCookie(undefined);
  assert.equal((await get()).status, 401); assert.equal((await post()).status, 401);
  setTestCookie(COOKIE);
  assert.equal((await post(base, { headers: { origin: "https://attacker.invalid" } })).status, 403);
});

test("schemas estritos exigem operationId, rejeitam householdId e payload inválido", async (t) => {
  const f = setup(t);
  for (const invalid of [{ ...base, operationId: "" }, { ...base, householdId: f.b.household }, { ...base, expectedDate: "2026-02-30" }, { ...base, expectedAmountCents: 0 }, { ...base, subcategoryId: "subcategory-a", categoryId: null }]) assert.equal((await post(invalid)).status, 400);
  assert.equal(f.db.prepare("SELECT count(*) total FROM expected_income_occurrences").get().total, 0);
});

test("cria ocorrência única, replay idempotente e conflito seguro", async (t) => {
  const f = setup(t); const first = await post(); const replay = await post();
  assert.equal(first.status, 201); assert.equal(first.headers.get("cache-control"), "private, no-store, max-age=0"); assert.equal(first.body.replayed, false);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.occurrenceId, first.body.occurrenceId);
  const conflict = await post({ ...base, description: "Outro" }); assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "EXPECTED_INCOME_IDEMPOTENCY_CONFLICT");
  assert.equal(f.db.prepare("SELECT count(*) total FROM expected_income_occurrences").get().total, 1);
});

test("criação aceita classificação opcional canônica e rejeita subcategoria sem categoria", async (t) => {
  const f = setup(t);
  const noClassification = await post({ ...base, operationId: "no-classification", categoryId: null, subcategoryId: null });
  assert.equal(noClassification.status, 201);
  const categoryOnly = await post({ ...base, operationId: "category-only", categoryId: f.a.category, subcategoryId: null });
  assert.equal(categoryOnly.status, 201);
  const complete = await post({ ...base, operationId: "complete-classification", categoryId: f.a.category, subcategoryId: f.a.subcategory });
  assert.equal(complete.status, 201);
  const manipulated = await post({ ...base, operationId: "subcategory-without-category", categoryId: null, subcategoryId: f.a.subcategory });
  assert.equal(manipulated.status, 400);
  assert.equal(f.db.prepare("SELECT count(*) total FROM expected_income_occurrences").get().total, 3);
  const unclassified = f.db.prepare("SELECT category_id,subcategory_id FROM expected_income_occurrences WHERE id=?").get(noClassification.body.occurrenceId);
  assert.equal(unclassified.category_id, null); assert.equal(unclassified.subcategory_id, null);
});

test("GET isola household, deriva atraso e enriquece tudo em uma consulta sem N+1", async (t) => {
  const f = setup(t); await post({ ...base, expectedDate: "2020-01-01" });
  f.db.prepare(`INSERT INTO expected_income_operations(id,household_id,idempotency_key,request_hash,operation_type,occurrence_id,performed_by_user_id,financial_date,created_at) VALUES('foreign-operation','house-b','foreign-create',?,'create_occurrence','foreign','user-b','2020-01-01',?)`).run("a".repeat(64), AT);
  f.db.prepare(`INSERT INTO expected_income_occurrences(id,household_id,description,expected_amount_cents,expected_date,status,last_operation_id,created_by_user_id,origin,created_at,updated_at) VALUES('foreign','house-b','Segredo',100,'2020-01-01','pending','foreign-operation','user-b','web',?,?)`).run(AT, AT);
  f.d1.sql.length = 0; const result = await get();
  assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "private, no-store, max-age=0"); assert.equal(result.body.occurrences.length, 1); assert.equal(result.body.occurrences[0].timing, "overdue");
  assert.doesNotMatch(JSON.stringify(result.body), /Segredo|house-b/u);
  assert.equal(f.d1.sql.filter((sql) => /FROM expected_income_occurrences o/u.test(sql)).length, 1);
  assert.equal((await get("?householdId=house-b")).status, 400);
});

test("cria série mensal canônica e materializa extensão explícita", async (t) => {
  const f = setup(t); const recurring = await post({ action: "create_recurring_series", operationId: "series-one", description: "Contrato", expectedAmountCents: 302000, startsOn: "2026-01-31", configuredDay: 31, endsOn: null, plannedAccountId: null, categoryId: null, subcategoryId: null, notes: null });
  assert.equal(recurring.status, 201); assert.deepEqual(recurring.body.occurrences.slice(0, 3).map((item) => item.expectedDate), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  const extended = await post({ action: "materialize_series", operationId: "extend-one", seriesId: recurring.body.seriesId, throughMonth: "2028-01" });
  assert.equal(extended.status, 200); assert.equal(extended.body.materializedThroughMonth, "2028-01"); assert.equal(f.db.prepare("SELECT count(*) total FROM expected_income_series").get().total, 1);
});

test("edita e cancela somente pending, com relações restritas ao household", async (t) => {
  const f = setup(t); const created = await post();
  const updated = await post({ action: "update_occurrence", operationId: "update-one", occurrenceId: created.body.occurrenceId, description: "Salário ajustado", expectedAmountCents: 21000, expectedDate: "2026-10-01", plannedAccountId: null, categoryId: null, subcategoryId: null, notes: null });
  assert.equal(updated.status, 200); assert.equal(f.db.prepare("SELECT description FROM expected_income_occurrences WHERE id=?").get(created.body.occurrenceId).description, "Salário ajustado");
  const invalidRelation = await post({ ...base, operationId: "foreign-relation", plannedAccountId: f.b.account }); assert.equal(invalidRelation.status, 400);
  assert.equal((await post({ action: "cancel_occurrence", operationId: "cancel-one", occurrenceId: created.body.occurrenceId })).status, 200);
  assert.equal((await post({ action: "update_occurrence", operationId: "late-update", occurrenceId: created.body.occurrenceId, description: "Não", expectedAmountCents: 1, expectedDate: "2026-10-01", plannedAccountId: null, categoryId: null, subcategoryId: null, notes: null })).status, 409);
});

test("recebe com valor/data/conta reais diferentes e estorna de modo idempotente", async (t) => {
  const f = setup(t); const created = await post();
  const received = await post({ action: "receive_occurrence", operationId: "receive-one", occurrenceId: created.body.occurrenceId, receivedAmountCents: 22000, receivedDate: "2026-09-20", actualAccountId: f.a.otherAccount });
  assert.equal(received.status, 200); const transaction = f.db.prepare("SELECT amount_cents,transaction_date,account_id FROM transactions WHERE id=?").get(received.body.transactionId); assert.equal(transaction.amount_cents, 22000); assert.equal(transaction.transaction_date, "2026-09-20"); assert.equal(transaction.account_id, f.a.otherAccount);
  assert.equal((await post({ action: "receive_occurrence", operationId: "future", occurrenceId: created.body.occurrenceId, receivedAmountCents: 22000, receivedDate: "2999-01-01", actualAccountId: f.a.account })).status, 400);
  assert.equal((await post({ action: "reverse_receipt", operationId: "reverse-without-date", occurrenceId: created.body.occurrenceId })).status, 400);
  assert.equal((await post({ action: "reverse_receipt", operationId: "reverse-before", occurrenceId: created.body.occurrenceId, reversalDate: "2026-09-19" })).status, 400);
  assert.equal((await post({ action: "reverse_receipt", operationId: "reverse-future", occurrenceId: created.body.occurrenceId, reversalDate: "2999-01-01" })).status, 400);
  const reversed = await post({ action: "reverse_receipt", operationId: "reverse-one", occurrenceId: created.body.occurrenceId, reversalDate: "2026-09-23" }); const replay = await post({ action: "reverse_receipt", operationId: "reverse-one", occurrenceId: created.body.occurrenceId, reversalDate: "2026-09-23" });
  assert.equal(reversed.status, 200); assert.equal(replay.body.replayed, true); assert.equal(f.db.prepare("SELECT count(*) total FROM transactions").get().total, 1); assert.equal(f.db.prepare("SELECT status FROM expected_income_occurrences WHERE id=?").get(created.body.occurrenceId).status, "pending");
});

test("erros internos não expõem SQL, stack ou detalhes de banco", async (t) => {
  const f = setup(t); const original = f.d1.batch; f.d1.batch = async () => { throw new Error("SQLITE secret_table SELECT password stack"); };
  const result = await post(); f.d1.batch = original;
  assert.equal(result.status, 500); assert.doesNotMatch(JSON.stringify(result.body), /SQLITE|secret_table|password|stack/iu);
});

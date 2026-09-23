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
    if (specifier === "next/headers") return { shortCircuit: true, url: "data:text/javascript,export async function cookies(){const value=globalThis.__forecastApiCookie ?? globalThis.__accountStatementApiCookie ?? globalThis.__billInstallmentApiCookie ?? globalThis.__cardOnboardingApiCookie ?? globalThis.__notificationPreferencesApiCookie ?? globalThis.__invoiceTestCookie;return {get:()=>value ? {value} : undefined}}" };
    if (specifier === "next/server") return next("next/server.js", context);
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);

const route = await import("../app/api/finance/forecast/route.ts?forecast-api-tests");
const COOKIE = "forecast-api-session";
const SESSION_ID = await digestToken(COOKIE);
const AT = "2026-09-15T15:00:00.000Z";

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async raw() {
    const statement = this.db.prepare(this.sql);
    const columns = statement.columns().map((column) => column.name);
    return statement.all(...this.bindings).map((row) => columns.map((column) => row[column]));
  }
  async run() { const result = this.db.prepare(this.sql).run(...this.bindings); return { success: true, results: [], meta: { changes: result.changes } }; }
}

class LocalD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.all())); }
}

function household(db, suffix, initialBalance) {
  const value = { user: `user-${suffix}`, household: `house-${suffix}`, account: `account-${suffix}` };
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(value.user, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(value.household, `House ${suffix}`, value.user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, value.household, value.user, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(value.account, value.household, `Account ${suffix}`, "bank", initialBalance, 1, AT, AT);
  return value;
}

function setup(t) {
  const NativeDate = globalThis.Date;
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [AT])); }
    static now() { return NativeDate.parse(AT); }
  };
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  const a = household(db, "a", 20_000);
  const b = household(db, "b", 9_999_999);
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)").run(SESSION_ID, a.user, "2027-12-01T00:00:00.000Z", AT, AT);
  db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("future-a", a.household, "income", 30_000, "Future A", "2026-10-01", a.user, a.account, "confirmed", "dashboard", AT, AT);
  db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("private-b", b.household, "income", 8_888_888, "Private B", "2026-10-01", b.user, b.account, "confirmed", "dashboard", AT, AT);
  runtime.DB = new LocalD1(db);
  globalThis.__forecastApiCookie = COOKIE;
  globalThis.__accountStatementApiCookie = COOKIE;
  t.after(() => {
    globalThis.Date = NativeDate;
    globalThis.__forecastApiCookie = undefined;
    globalThis.__accountStatementApiCookie = undefined;
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
  });
  return { db, a, b };
}

async function get(query = "") {
  const response = await route.GET(new Request(`https://fixture.invalid/api/finance/forecast${query ? `?${query}` : ""}`));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function assertPrivate(headers) {
  assert.equal(headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(headers.get("pragma"), "no-cache");
  assert.equal(headers.get("vary"), "Cookie");
}

test("endpoint sem autenticação retorna 401 e protege o cache", async t => {
  setup(t);
  globalThis.__forecastApiCookie = undefined;
  globalThis.__accountStatementApiCookie = undefined;
  const result = await get();
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: "Não autenticado" });
  assertPrivate(result.headers);
});

test("household vem somente da sessão e dados de outra família nunca contaminam o retorno", async t => {
  const f = setup(t);
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.body.horizon.months, 6);
  assert.equal(result.body.currentBalanceCents, 20_000);
  assert.equal(result.body.knownFutureIncomeCents, 30_000);
  assert.match(JSON.stringify(result.body), /Future A/u);
  assert.doesNotMatch(JSON.stringify(result.body), /Private B|private-b|8888888|9999999/u);
  assertPrivate(result.headers);
  const injected = await get(`householdId=${f.b.household}`);
  assert.equal(injected.status, 400);
  assert.doesNotMatch(JSON.stringify(injected.body), new RegExp(f.b.household, "u"));
});

test("months aceita default, 1 e 24; rejeita inválidos, desconhecidos e repetidos", async t => {
  setup(t);
  assert.equal((await get()).body.horizon.months, 6);
  assert.equal((await get("months=1")).body.horizon.months, 1);
  assert.equal((await get("months=24")).body.horizon.months, 24);
  for (const query of ["months=0", "months=25", "months=-1", "months=1.5", "months=1e1", "months=06", "months=", "foo=1", "months=6&months=7"]) {
    const result = await get(query);
    assert.equal(result.status, 400, query);
    assertPrivate(result.headers);
  }
});

test("ausência de household ativo falha fechado sem escolher household do cliente", async t => {
  const f = setup(t);
  f.db.prepare("UPDATE household_members SET status='inactive' WHERE household_id=?").run(f.a.household);
  const result = await get();
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "Nenhuma família ativa encontrada." });
});

test("GET é estritamente read-only e a rota não expõe métodos mutáveis", async t => {
  const f = setup(t);
  const before = f.db.prepare("SELECT total_changes() AS value").get().value;
  const result = await get("months=6");
  const after = f.db.prepare("SELECT total_changes() AS value").get().value;
  assert.equal(result.status, 200);
  assert.equal(after, before);
  const source = readFileSync(new URL("../app/api/finance/forecast/route.ts", import.meta.url), "utf8");
  assert.match(source, /export async function GET/u);
  assert.doesNotMatch(source, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.doesNotMatch(source, /householdId.*searchParams/u);
});

test("erro interno é sanitizado e nunca devolve SQL ou caminhos", async t => {
  setup(t);
  const original = runtime.DB;
  runtime.DB = { prepare() { throw new Error("SELECT secret FROM private_table at C:\\project\\route.ts"); } };
  const result = await get();
  runtime.DB = original;
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: "Não foi possível carregar a previsão financeira." });
  assert.doesNotMatch(JSON.stringify(result.body), /SELECT|private_table|route\.ts/u);
});

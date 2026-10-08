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

const route = await import("../app/api/finance/chatgpt-summary/route.ts?summary-api-tests");
const COOKIE = "summary-api-session";
const SESSION_ID = await digestToken(COOKIE);
const AT = "2026-10-08T15:00:00.000Z";

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
  for (const suffix of ["a", "b"]) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`user-${suffix}`, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
    db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`house-${suffix}`, `House ${suffix}`, `user-${suffix}`, "2026-01-01T00:00:00.000Z", AT);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, `house-${suffix}`, `user-${suffix}`, "owner", "active", AT);
  }
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("private-account", "house-b", "Conta privada B", "bank", 9_999_999, 1, AT, AT);
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)").run(SESSION_ID, "user-a", "2027-12-01T00:00:00.000Z", AT, AT);
  runtime.DB = new LocalD1(db);
  globalThis.__cardOnboardingApiCookie = COOKIE;
  t.after(() => {
    globalThis.Date = NativeDate;
    globalThis.__cardOnboardingApiCookie = undefined;
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
  });
  return db;
}

async function get(query = "") {
  const response = await route.GET(new Request(`https://fixture.invalid/api/finance/chatgpt-summary${query ? `?${query}` : ""}`));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function assertPrivate(headers) {
  assert.equal(headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(headers.get("pragma"), "no-cache");
  assert.equal(headers.get("vary"), "Cookie");
}

test("ausência de sessão retorna 401 com cache privado", async t => {
  setup(t);
  globalThis.__cardOnboardingApiCookie = undefined;
  const result = await get();
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: "Não autenticado" });
  assertPrivate(result.headers);
});

test("mês padrão vem do corte de São Paulo e household é derivado no servidor", async t => {
  setup(t);
  const result = await get();
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ["asOfDate", "generatedAt", "month", "summaryText", "warnings"]);
  assert.equal(result.body.month, "2026-10");
  assert.equal(result.body.asOfDate, "2026-10-08");
  assert.match(result.body.summaryText, /R\$\s*0,00/u);
  assert.doesNotMatch(JSON.stringify(result.body), /Conta privada B|9999999|house-b|user-b/u);
  assertPrivate(result.headers);
});

test("parâmetros inválidos, repetidos, desconhecidos e identidades do cliente são rejeitados", async t => {
  setup(t);
  for (const query of [
    "month=", "month=2026-00", "month=2026-13", "month=2026-09", "month=2028-10",
    "month=2026-10&month=2026-11", "foo=1", "householdId=house-b", "userId=user-b",
  ]) {
    const result = await get(query);
    assert.equal(result.status, 400, query);
    assertPrivate(result.headers);
    assert.doesNotMatch(JSON.stringify(result.body), /house-b|user-b/u);
  }
});

test("GET é read-only, não expõe métodos mutáveis nem snapshots brutos", async t => {
  const db = setup(t);
  const before = db.prepare("SELECT total_changes() AS value").get().value;
  const result = await get("month=2026-10");
  const after = db.prepare("SELECT total_changes() AS value").get().value;
  assert.equal(result.status, 200);
  assert.equal(after, before);
  const source = readFileSync(new URL("../app/api/finance/chatgpt-summary/route.ts", import.meta.url), "utf8");
  assert.match(source, /export async function GET/u);
  assert.doesNotMatch(source, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.doesNotMatch(source, /householdId.*searchParams|userId.*searchParams/u);
  assert.doesNotMatch(JSON.stringify(result.body), /accounts|transactions|bills|cards|projection|internalId/u);
});

test("ausência de household ativo falha fechado", async t => {
  const db = setup(t);
  db.prepare("UPDATE household_members SET status='inactive' WHERE household_id='house-a'").run();
  const result = await get();
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "Nenhuma família ativa encontrada." });
});

test("erro interno é sanitizado sem SQL, caminho ou segredo", async t => {
  setup(t);
  const original = runtime.DB;
  runtime.DB = { prepare() { throw new Error("SELECT token FROM private_table at C:\\secret\\route.ts"); } };
  const result = await get();
  runtime.DB = original;
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: "Não foi possível gerar o resumo financeiro." });
  assert.doesNotMatch(JSON.stringify(result.body), /SELECT|token|private_table|route\.ts/iu);
});

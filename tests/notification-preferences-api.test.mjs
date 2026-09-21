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
    if (specifier === "next/headers") return { shortCircuit: true, url: "data:text/javascript,export async function cookies(){const value=globalThis.__notificationPreferencesApiCookie;return {get:()=>value ? {value} : undefined}}" };
    if (specifier === "next/server") return next("next/server.js", context);
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);

const route = await import("../app/api/notifications/preferences/route.ts?notification-preferences-api");
const COOKIE = "notification-preferences-session";
const SESSION_ID = await digestToken(COOKIE);
const AT = "2026-09-20T12:00:00.000Z";
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async raw() { const statement = this.db.prepare(this.sql); const columns = statement.columns().map((column) => column.name); return statement.all(...this.bindings).map((row) => columns.map((column) => row[column])); }
  async run() {
    const statement = this.db.prepare(this.sql);
    if (statement.columns().length) return { success: true, results: statement.all(...this.bindings), meta: { changes: 0 } };
    const result = statement.run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class LocalD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function seed(db) {
  for (const [user, household, role] of [["user-a", "house-a", "owner"], ["user-c", "house-b", "owner"]]) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, `${user}@example.com`, AT, AT);
    db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(household, household, user, AT, AT);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${user}`, household, user, role, "active", AT);
  }
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("user-b", "user-b", "user-b@example.com", AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run("member-user-b", "house-a", "user-b", "member", "active", AT);
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)").run(SESSION_ID, "user-a", "2027-12-01T00:00:00.000Z", AT, AT);
}

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) {
    for (const sql of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(sql);
  }
  seed(db);
  runtime.DB = new LocalD1(db);
  globalThis.__notificationPreferencesApiCookie = COOKIE;
  globalThis.__accountStatementApiCookie = COOKIE;
  globalThis.__cardOnboardingApiCookie = COOKIE;
  globalThis.__invoiceTestCookie = COOKIE;
  t.after(() => {
    globalThis.__notificationPreferencesApiCookie = undefined;
    globalThis.__accountStatementApiCookie = undefined;
    globalThis.__cardOnboardingApiCookie = undefined;
    globalThis.__invoiceTestCookie = undefined;
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
  });
  return db;
}

const validPayload = {
  channel: "telegram",
  enabled: true,
  billDueTomorrow: true,
  billDueToday: true,
  billOverdue: true,
  preferredLocalTime: "09:00",
  timezone: "America/Sao_Paulo",
};

async function get() {
  const response = await route.GET(new Request("https://fixture.invalid/api/notifications/preferences"));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function post(payload = validPayload, options = {}) {
  const response = await route.POST(new Request("https://fixture.invalid/api/notifications/preferences", {
    method: "POST",
    headers: { origin: "https://fixture.invalid", "content-type": "application/json", ...options.headers },
    body: options.raw ?? JSON.stringify(payload),
  }));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("sem sessão rejeita GET e POST", async (t) => {
  setup(t);
  globalThis.__notificationPreferencesApiCookie = undefined;
  globalThis.__accountStatementApiCookie = undefined;
  globalThis.__cardOnboardingApiCookie = undefined;
  globalThis.__invoiceTestCookie = undefined;
  assert.equal((await get()).status, 401);
  assert.equal((await post()).status, 401);
});

test("usuário ativo lê somente a própria preferência", async (t) => {
  const db = setup(t);
  db.prepare("INSERT INTO user_notification_preferences(household_id,user_id,channel,enabled,bill_due_today,preferred_local_time,timezone,created_at,updated_at) VALUES(?,?,'telegram',1,0,'08:30','America/Sao_Paulo',?,?)")
    .run("house-a", "user-a", AT, AT);
  db.prepare("INSERT INTO user_notification_preferences(household_id,user_id,channel,enabled,preferred_local_time,timezone,created_at,updated_at) VALUES(?,?,'telegram',0,'10:15','America/Sao_Paulo',?,?)")
    .run("house-a", "user-b", AT, AT);
  const result = await get();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { exists: true, channel: "telegram", enabled: true, billDueTomorrow: true, billDueToday: false, billOverdue: true, preferredLocalTime: "08:30", timezone: "America/Sao_Paulo" });
});

test("ausência de preferência retorna defaults desativados sem gravar", async (t) => {
  const db = setup(t);
  const result = await get();
  assert.deepEqual(result.body, { exists: false, channel: "telegram", enabled: false, billDueTomorrow: true, billDueToday: true, billOverdue: true, preferredLocalTime: "09:00", timezone: "America/Sao_Paulo" });
  assert.equal(db.prepare("SELECT count(*) total FROM user_notification_preferences").get().total, 0);
});

test("usuário salva a própria preferência sem criar outbox", async (t) => {
  const db = setup(t);
  const result = await post({ ...validPayload, billDueToday: false, preferredLocalTime: "07:45" });
  assert.equal(result.status, 200);
  assert.equal(result.body.exists, true);
  assert.deepEqual({ ...db.prepare("SELECT household_id,user_id,enabled,bill_due_today,preferred_local_time,upcoming_digest FROM user_notification_preferences").get() }, { household_id: "house-a", user_id: "user-a", enabled: 1, bill_due_today: 0, preferred_local_time: "07:45", upcoming_digest: 0 });
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 0);
});

test("household e user vêm exclusivamente da sessão", async (t) => {
  const db = setup(t);
  const result = await post({ ...validPayload, householdId: "house-b", userId: "user-b" });
  assert.equal(result.status, 400);
  assert.equal(db.prepare("SELECT count(*) total FROM user_notification_preferences").get().total, 0);
});

test("tentativa de alterar outro usuário é rejeitada sem afetá-lo", async (t) => {
  const db = setup(t);
  db.prepare("INSERT INTO user_notification_preferences(household_id,user_id,channel,enabled,created_at,updated_at) VALUES('house-a','user-b','telegram',0,?,?)").run(AT, AT);
  assert.equal((await post({ ...validPayload, userId: "user-b" })).status, 400);
  assert.equal(db.prepare("SELECT enabled FROM user_notification_preferences WHERE user_id='user-b'").get().enabled, 0);
});

test("membership inativa é rejeitada", async (t) => {
  const db = setup(t);
  db.prepare("UPDATE household_members SET status='inactive' WHERE household_id='house-a' AND user_id='user-a'").run();
  assert.equal((await get()).status, 403);
  assert.equal((await post()).status, 403);
});

test("payload ausente, extra ou malformado é rejeitado", async (t) => {
  setup(t);
  assert.equal((await post({ enabled: true })).status, 400);
  assert.equal((await post(validPayload, { raw: "{" })).status, 400);
});

test("horário inválido é rejeitado", async (t) => {
  setup(t);
  assert.equal((await post({ ...validPayload, preferredLocalTime: "25:00" })).status, 400);
});

test("timezone diferente do suportado é rejeitado", async (t) => {
  setup(t);
  assert.equal((await post({ ...validPayload, timezone: "UTC" })).status, 400);
});

test("channel diferente de telegram é rejeitado", async (t) => {
  setup(t);
  assert.equal((await post({ ...validPayload, channel: "push" })).status, 400);
});

test("booleans não sofrem coerção", async (t) => {
  setup(t);
  assert.equal((await post({ ...validPayload, enabled: "true" })).status, 400);
  assert.equal((await post({ ...validPayload, billDueTomorrow: 1 })).status, 400);
});

test("upcoming_digest não pode ser ativado por payload malicioso", async (t) => {
  const db = setup(t);
  assert.equal((await post({ ...validPayload, upcomingDigest: true })).status, 400);
  assert.equal(db.prepare("SELECT count(*) total FROM user_notification_preferences").get().total, 0);
});

test("GET e POST usam cache privado e no-store", async (t) => {
  setup(t);
  assert.match((await get()).headers.get("cache-control"), /private.*no-store/iu);
  assert.match((await post()).headers.get("cache-control"), /private.*no-store/iu);
});

test("write exige same-origin", async (t) => {
  const db = setup(t);
  assert.equal((await post(validPayload, { headers: { origin: "https://evil.invalid" } })).status, 403);
  assert.equal(db.prepare("SELECT count(*) total FROM user_notification_preferences").get().total, 0);
});

test("salvar duas vezes mantém um único estado consistente", async (t) => {
  const db = setup(t);
  assert.equal((await post(validPayload)).status, 200);
  assert.equal((await post({ ...validPayload, enabled: false, billOverdue: false, preferredLocalTime: "10:30" })).status, 200);
  assert.deepEqual({ ...db.prepare("SELECT count(*) total,enabled,bill_overdue,preferred_local_time,upcoming_digest FROM user_notification_preferences").get() }, { total: 1, enabled: 0, bill_overdue: 0, preferred_local_time: "10:30", upcoming_digest: 0 });
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 0);
});

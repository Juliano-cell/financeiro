import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { digestToken } from "../lib/auth-crypto.mjs";
import {
  FUTURE_GENERIC_TRANSACTION_ERROR_CODE,
  futureGenericTransactionViolation,
  genericTransactionDateDecision,
  genericTransactionToday,
} from "../lib/generic-transaction-date-rules.mjs";

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
    if (specifier === "next/headers") return { shortCircuit: true, url: "data:text/javascript,export async function cookies(){return {get:()=>globalThis.__futureTransactionCookie ? {value:globalThis.__futureTransactionCookie} : undefined}}" };
    if (specifier === "next/server") return next("next/server.js", context);
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);

const finance = await import("../app/api/finance/route.ts?future-transaction-containment");
const COOKIE = "future-transaction-session";
const SESSION_ID = await digestToken(COOKIE);
const CLOCK = "2026-09-23T15:00:00.000Z";

function setTestCookie(value) {
  globalThis.__futureTransactionCookie = value;
  globalThis.__expectedIncomeApiCookie = value;
  globalThis.__accountStatementApiCookie = value;
  globalThis.__forecastApiCookie = value;
  globalThis.__billInstallmentApiCookie = value;
  globalThis.__cardOnboardingApiCookie = value;
  globalThis.__notificationPreferencesApiCookie = value;
  globalThis.__invoiceTestCookie = value;
}

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async raw() { const statement = this.db.prepare(this.sql); const names = statement.columns().map(column => column.name); return statement.all(...this.bindings).map(row => names.map(name => row[name])); }
  runSync() { const value = this.db.prepare(this.sql).run(...this.bindings); return { success: true, results: [], meta: { changes: value.changes } }; }
  async run() { return this.runSync(); }
}

class LocalD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const results = statements.map(statement => statement.runSync()); this.db.exec("COMMIT"); return results; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

async function setup(t) {
  const NativeDate = globalThis.Date;
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [CLOCK])); }
    static now() { return NativeDate.parse(CLOCK); }
  };
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter(file => file.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) db.exec(statement);
  }
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("user", "User", "user@example.com", CLOCK, CLOCK);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run("house", "House", "user", CLOCK, CLOCK);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run("member", "house", "user", "owner", "active", CLOCK);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("account", "house", "Account", "bank", CLOCK, CLOCK);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("other-account", "house", "Other", "bank", CLOCK, CLOCK);
  db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("expense-category", "house", "Expense", "expense", CLOCK, CLOCK);
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)").run(SESSION_ID, "user", "2027-12-01T00:00:00.000Z", CLOCK, CLOCK);
  runtime.DB = new LocalD1(db);
  setTestCookie(COOKIE);
  t.after(() => {
    globalThis.Date = NativeDate;
    setTestCookie(undefined);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
  });
  return db;
}

async function action(actionName, fields = {}) {
  const response = await finance.POST(new Request("https://fixture.invalid/api/finance", {
    method: "POST",
    headers: { origin: "https://fixture.invalid", "content-type": "application/json" },
    body: JSON.stringify({ action: actionName, ...fields }),
  }));
  return { status: response.status, body: await response.json() };
}

function transactionFields(overrides = {}) {
  const type = overrides.type ?? "income";
  return {
    type,
    amountCents: 10000,
    description: "Fixture",
    categoryId: type === "expense" ? "expense-category" : null,
    subcategoryId: null,
    transactionDate: "2026-09-23",
    transactionTime: null,
    accountId: "account",
    paymentMethod: "pix",
    status: "confirmed",
    notes: null,
    ...overrides,
  };
}

function insertLegacy(db, id, transactionDate = "2026-10-10") {
  db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "house", "income", 10000, id, transactionDate, "user", "account", "confirmed", "dashboard", CLOCK, CLOCK);
}

test("dia financeiro de São Paulo respeita virada diária, mensal e anual", () => {
  assert.equal(genericTransactionToday(new Date("2026-09-24T02:59:59.999Z")), "2026-09-23");
  assert.equal(genericTransactionToday(new Date("2026-09-24T03:00:00.000Z")), "2026-09-24");
  assert.equal(genericTransactionToday(new Date("2027-01-01T02:59:59.999Z")), "2026-12-31");
  assert.equal(genericTransactionToday(new Date("2027-01-01T03:00:00.000Z")), "2027-01-01");
});

test("matriz de domínio bloqueia novo futuro e preserva somente legado já futuro", () => {
  for (const transactionDate of ["2026-09-22", "2026-09-23"]) assert.equal(genericTransactionDateDecision({ transactionDate, today: "2026-09-23" }).allowed, true);
  assert.equal(genericTransactionDateDecision({ transactionDate: "2026-09-24", today: "2026-09-23" }).allowed, false);
  assert.equal(genericTransactionDateDecision({ transactionDate: "2026-10-20", today: "2026-09-23", existingTransactionDate: "2026-10-10" }).allowed, true);
  assert.equal(genericTransactionDateDecision({ transactionDate: "2026-10-20", today: "2026-09-23", existingTransactionDate: "2026-09-23" }).allowed, false);
  assert.deepEqual(futureGenericTransactionViolation({ type: "income", transactionDate: "2026-09-24", today: "2026-09-23" }), { code: FUTURE_GENERIC_TRANSACTION_ERROR_CODE, message: "Para planejar uma receita futura, use Entradas previstas.", planningTarget: "expected_income" });
  assert.deepEqual(futureGenericTransactionViolation({ type: "expense", transactionDate: "2026-09-24", today: "2026-09-23" }), { code: FUTURE_GENERIC_TRANSACTION_ERROR_CODE, message: "Para planejar uma despesa futura, use Contas.", planningTarget: "bill" });
});

test("API bloqueia novas transactions futuras em todos os status sem persistir", async t => {
  const db = await setup(t);
  for (const type of ["income", "expense"]) for (const status of ["confirmed", "pending", "cancelled"]) {
    const result = await action("create_transaction", transactionFields({ type, status, transactionDate: "2026-09-24" }));
    assert.equal(result.status, 400);
    assert.equal(result.body.code, FUTURE_GENERIC_TRANSACTION_ERROR_CODE);
    assert.equal(result.body.planningTarget, type === "income" ? "expected_income" : "bill");
    assert.match(result.body.error, type === "income" ? /Entradas previstas/u : /Contas/u);
  }
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  for (const type of ["income", "expense"]) for (const transactionDate of ["2026-09-22", "2026-09-23"]) {
    assert.equal((await action("create_transaction", transactionFields({ type, transactionDate }))).status, 200);
  }
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 4);
});

test("edição comum permite hoje/passado e impede passado/hoje de voltar ao futuro", async t => {
  const db = await setup(t);
  insertLegacy(db, "current", "2026-09-23");
  insertLegacy(db, "past", "2026-09-22");
  const currentFuture = await action("update_transaction", transactionFields({ id: "current", transactionDate: "2026-09-24" }));
  const pastFuture = await action("update_transaction", transactionFields({ id: "past", transactionDate: "2026-09-24" }));
  for (const result of [currentFuture, pastFuture]) {
    assert.equal(result.status, 400);
    assert.deepEqual(Object.keys(result.body).sort(), ["code", "error", "planningTarget"]);
    assert.equal(result.body.code, FUTURE_GENERIC_TRANSACTION_ERROR_CODE);
  }
  assert.equal(db.prepare("SELECT transaction_date FROM transactions WHERE id='current'").get().transaction_date, "2026-09-23");
  assert.equal(db.prepare("SELECT transaction_date FROM transactions WHERE id='past'").get().transaction_date, "2026-09-22");
  assert.equal((await action("update_transaction", transactionFields({ id: "current", transactionDate: "2026-09-23" }))).status, 200);
  assert.equal((await action("update_transaction", transactionFields({ id: "past", transactionDate: "2026-09-23" }))).status, 200);
});

test("legado futuro pode permanecer, avançar, mudar campos/status, voltar ao presente e ser excluído", async t => {
  const db = await setup(t);
  for (const id of ["remain", "advance", "fields", "return", "past", "delete"]) insertLegacy(db, id);
  assert.equal((await action("update_transaction", transactionFields({ id: "remain", transactionDate: "2026-10-10" }))).status, 200);
  assert.equal((await action("update_transaction", transactionFields({ id: "advance", transactionDate: "2026-11-15" }))).status, 200);
  assert.equal((await action("update_transaction", transactionFields({ id: "fields", transactionDate: "2026-10-10", description: "Alterado", status: "cancelled", amountCents: 12345, accountId: "other-account" }))).status, 200);
  assert.equal((await action("update_transaction", transactionFields({ id: "return", transactionDate: "2026-09-23", status: "pending" }))).status, 200);
  assert.equal((await action("update_transaction", transactionFields({ id: "past", transactionDate: "2026-09-22" }))).status, 200);
  assert.equal((await action("delete_transaction", { id: "delete" })).status, 200);
  assert.deepEqual({ ...db.prepare("SELECT transaction_date,description,status,amount_cents,account_id FROM transactions WHERE id='fields'").get() }, { transaction_date: "2026-10-10", description: "Alterado", status: "cancelled", amount_cents: 12345, account_id: "other-account" });
  assert.equal(db.prepare("SELECT transaction_date,status FROM transactions WHERE id='return'").get().transaction_date, "2026-09-23");
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id='delete'").get().total, 0);
});

test("proteções de bill e expected income continuam precedendo qualquer flexibilidade do legado", async t => {
  const db = await setup(t);
  insertLegacy(db, "bill-linked");
  insertLegacy(db, "expected-linked");
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,due_date,recurrence,status,payment_transaction_id,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("bill", "house", "Bill", 10000, "2026-10-10", "none", "pending", "bill-linked", "user", "web", CLOCK, CLOCK);
  db.prepare("INSERT INTO expected_income_operations(id,household_id,idempotency_key,request_hash,operation_type,occurrence_id,performed_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("initial-operation", "house", "initial-operation-key", "b".repeat(64), "create_occurrence", "occurrence", "user", CLOCK);
  db.prepare("INSERT INTO expected_income_occurrences(id,household_id,description,expected_amount_cents,expected_date,status,last_operation_id,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run("occurrence", "house", "Expected", 10000, "2026-10-10", "pending", "initial-operation", "user", "web", CLOCK, CLOCK);
  db.prepare("INSERT INTO expected_income_operations(id,household_id,idempotency_key,request_hash,operation_type,occurrence_id,transaction_id,performed_by_user_id,financial_date,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("expected-operation", "house", "expected-operation-key", "a".repeat(64), "receive", "occurrence", "expected-linked", "user", "2026-10-10", CLOCK);

  for (const id of ["bill-linked", "expected-linked"]) {
    assert.equal((await action("update_transaction", transactionFields({ id, transactionDate: "2026-10-20" }))).status, 409);
    assert.equal((await action("delete_transaction", { id })).status, 409);
  }
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id IN ('bill-linked','expected-linked')").get().total, 2);
});

test("UI e integrações usam a contenção canônica e sinalizam o legado", () => {
  const ui = readFileSync(new URL("../app/finance-app.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/finance/route.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../lib/finance-service.ts", import.meta.url), "utf8");
  const telegram = readFileSync(new URL("../lib/telegram-handler.ts", import.meta.url), "utf8");
  assert.match(ui, /max=\{isCardPurchase \? undefined : today\}/u);
  assert.match(ui, /max=\{legacyFuture \? undefined : today\}/u);
  assert.match(ui, /Lançamento futuro legado/u);
  assert.match(ui, /Este lançamento foi criado antes da nova regra de planejamento/u);
  assert.match(route, /existingTransactionDate: before\.transactionDate/u);
  assert.match(route, /isFutureLegacy: item\.transactionDate > today/u);
  assert.match(service, /futureGenericTransactionViolation/u);
  assert.match(telegram, /date > genericTransactionToday\(\)/u);
});

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
    if (specifier === "next/headers") return { shortCircuit: true, url: "data:text/javascript,export async function cookies(){const value=globalThis.__accountStatementApiCookie ?? globalThis.__cardOnboardingApiCookie ?? globalThis.__invoiceTestCookie;return {get:()=>value ? {value} : undefined}}" };
    if (specifier === "next/server") return next("next/server.js", context);
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);

const route = await import("../app/api/finance/account-statement/route.ts?api-tests");
const COOKIE = "account-statement-api-session";
const SESSION_ID = await digestToken(COOKIE);
const AT = "2026-09-20T12:00:00.000Z";

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
}

function seedHousehold(db, suffix) {
  const values = { user: `user-${suffix}`, household: `house-${suffix}`, account: `account-${suffix}` };
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(values.user, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(values.household, `House ${suffix}`, values.user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(`member-${suffix}`, values.household, values.user, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(values.account, values.household, `Account ${suffix}`, "bank", 10_000, 1, AT, AT);
  return values;
}

function transaction(db, values) {
  db.prepare(`INSERT INTO transactions(
    id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,
    account_id,payment_method,status,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.id, values.household, values.type, values.amount, values.description, values.date,
    values.user, values.account, values.paymentMethod ?? null, values.status ?? "confirmed", "dashboard", AT, AT,
  );
}

function operation(db, values) {
  db.prepare(`INSERT INTO invoice_payment_operations(
    id,household_id,idempotency_key,kind,invoice_id,account_id,created_by_user_id,
    amount_cents,occurred_on,reversed_payment_id,request_fingerprint,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.id, values.household, `${values.id}-key`, values.kind, values.invoice, values.account,
    values.user, values.amount, values.date, values.reversedPaymentId ?? null, `${values.id}-fingerprint`, AT,
  );
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
  const a = seedHousehold(db, "a");
  const b = seedHousehold(db, "b");
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("account-inactive", a.household, "Inactive", "bank", 500, 0, AT, AT);
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)")
    .run(SESSION_ID, a.user, "2027-12-01T00:00:00.000Z", AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run("category-a", a.household, "Bills", "expense", AT, AT);
  for (let index = 0; index < 55; index += 1) {
    transaction(db, {
      id: `expense-${String(index).padStart(2, "0")}`, household: a.household, type: "expense", amount: 10,
      description: `Expense ${index}`, date: index === 0 ? "2026-08-22" : "2026-09-10", user: a.user, account: a.account,
    });
  }
  transaction(db, { id: "income-a", household: a.household, type: "income", amount: 5_000, description: "Income", date: "2026-09-11", user: a.user, account: a.account });
  transaction(db, { id: "paid-bill-transaction", household: a.household, type: "expense", amount: 200, description: "Paid bill", date: "2026-09-12", user: a.user, account: a.account });
  transaction(db, { id: "pending-a", household: a.household, type: "expense", amount: 999, description: "Pending", date: "2026-09-12", user: a.user, account: a.account, status: "pending" });
  transaction(db, { id: "inactive-history", household: a.household, type: "expense", amount: 100, description: "Inactive history", date: "2026-09-12", user: a.user, account: "account-inactive" });
  transaction(db, { id: "private-b", household: b.household, type: "income", amount: 99_999, description: "Private", date: "2026-09-11", user: b.user, account: b.account });
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,status,paid_at,payment_transaction_id,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("paid-bill-a", a.household, "Paid bill", 200, "category-a", "2026-09-12", a.account, "none", "paid", "2026-09-12", "paid-bill-transaction", a.user, "web", AT, AT);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("card-a", a.household, "Card A", "Bank", "A", 100_000, 5, 12, AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("invoice-a", a.household, "card-a", "2026-09", "2026-09-25", "2026-09-18", "open", AT, AT);
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("purchase-a", a.household, "card-a", "Card purchase", 1_000, "2026-09-10", 1, "active", a.user, "web", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("installment-a", a.household, "purchase-a", "invoice-a", 1, 1, 1_000, "pending", AT, AT);
  db.prepare("INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("batch-a", a.household, "card-a", a.user, "batch-key", "fingerprint", "2026-09", 1_500, 500, 0, 0, "pending", AT);
  db.prepare("INSERT INTO card_invoice_adjustments(id,household_id,invoice_id,import_batch_id,kind,amount_cents,status,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("opening-a", a.household, "invoice-a", "batch-a", "opening_balance", 500, "active", a.user, AT);
  db.prepare("UPDATE card_import_batches SET status='completed', completed_at=? WHERE id='batch-a'").run(AT);
  operation(db, { id: "payment-operation", household: a.household, kind: "payment", invoice: "invoice-a", account: a.account, user: a.user, amount: 1_000, date: "2026-09-19" });
  db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at,operation_id) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("payment-a", a.household, "invoice-a", a.account, 1_000, "2026-09-19", a.user, AT, "payment-operation");
  operation(db, { id: "reversal-a", household: a.household, kind: "reversal", invoice: "invoice-a", account: a.account, user: a.user, amount: 1_000, date: "2026-09-20", reversedPaymentId: "payment-a" });

  runtime.DB = new LocalD1(db);
  globalThis.__accountStatementApiCookie = COOKIE;
  t.after(() => {
    globalThis.Date = NativeDate;
    globalThis.__accountStatementApiCookie = undefined;
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
  });
  return { db, a, b };
}

async function get(query = "") {
  const response = await route.GET(new Request(`https://fixture.invalid/api/finance/account-statement${query ? `?${query}` : ""}`));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function query(changes = {}) {
  return new URLSearchParams({ accountId: "account-a", period: "custom", from: "2026-09-01", to: "2026-09-20", ...changes }).toString();
}

function assertPrivate(headers) {
  assert.equal(headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(headers.get("pragma"), "no-cache");
  assert.equal(headers.get("vary"), "Cookie");
}

test("API exige sessão e sempre protege respostas privadas", async (t) => {
  setup(t);
  globalThis.__accountStatementApiCookie = undefined;
  const result = await get(query());
  assert.equal(result.status, 401);
  assertPrivate(result.headers);
});

test("sessão válida deriva household no servidor e não aceita householdId do cliente", async (t) => {
  const f = setup(t);
  const ok = await get(query());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.account.id, f.a.account);
  assert.ok(!JSON.stringify(ok.body).includes("Private"));
  const injected = await get(`${query()}&householdId=${f.b.household}`);
  assert.equal(injected.status, 400);
  assertPrivate(injected.headers);
  f.db.prepare("UPDATE household_members SET status='removed' WHERE id='member-a'").run();
  assert.equal((await get(query())).status, 403);
});

test("accountId ausente, vazio, inválido e conta inexistente são rejeitados sem vazamento", async (t) => {
  setup(t);
  assert.equal((await get("period=this_month")).status, 400);
  assert.equal((await get("accountId=&period=this_month")).status, 400);
  assert.equal((await get("accountId=%00bad&period=this_month")).status, 400);
  const missing = await get("accountId=does-not-exist&period=this_month");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "Conta não encontrada.", code: "ACCOUNT_STATEMENT_ACCOUNT_NOT_FOUND" });
});

test("conta de outro household é indistinguível de inexistente e conta inativa local é consultável", async (t) => {
  const f = setup(t);
  const foreign = await get(`accountId=${f.b.account}&period=this_month`);
  assert.equal(foreign.status, 404);
  assert.ok(!JSON.stringify(foreign.body).includes(f.b.account));
  const inactive = await get("accountId=account-inactive&period=this_month");
  assert.equal(inactive.status, 200);
  assert.equal(inactive.body.account.isActive, false);
  assert.equal(inactive.body.items[0].entityId, "inactive-history");
});

test("períodos predefinidos usam a data financeira brasileira sem projeção futura", async (t) => {
  setup(t);
  const month = await get("accountId=account-a&period=this_month");
  assert.equal(month.status, 200);
  assert.deepEqual(month.body.period, { from: "2026-09-01", to: "2026-09-20" });
  const thirty = await get("accountId=account-a&period=last_30_days");
  assert.equal(thirty.status, 200);
  assert.deepEqual(thirty.body.period, { from: "2026-08-22", to: "2026-09-20" });
  assert.equal((await get("accountId=account-a&period=this_month&from=2026-01-01")).status, 400);
});

test("custom exige datas civis válidas, ordenadas e não futuras", async (t) => {
  setup(t);
  for (const value of [
    "accountId=account-a&period=custom&to=2026-09-20",
    "accountId=account-a&period=custom&from=2026-09-01",
    "accountId=account-a&period=custom&from=2026-02-30&to=2026-09-20",
    "accountId=account-a&period=custom&from=2026-09-20&to=2026-09-19",
    "accountId=account-a&period=custom&from=2026-09-01&to=2026-09-21",
  ]) assert.equal((await get(value)).status, 400, value);
});

test("eventType filtra itens sem alterar a reconciliação completa", async (t) => {
  setup(t);
  const all = await get(query({ eventType: "all" }));
  for (const eventType of ["income", "expense", "invoice_payment", "invoice_payment_reversal"]) {
    const filtered = await get(query({ eventType }));
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.items.length > 0);
    assert.ok(filtered.body.items.every((item) => item.eventType === eventType));
    assert.deepEqual(filtered.body.summary, all.body.summary);
  }
  assert.equal((await get(query({ eventType: "settlement" }))).status, 400);
});

test("pagamento e reversão são separados sem duplicar bill, compra, parcela ou opening balance", async (t) => {
  setup(t);
  const result = await get(query());
  const ids = result.body.items.map((item) => item.entityId);
  assert.equal(ids.filter((id) => id === "payment-a").length, 1);
  assert.equal(ids.filter((id) => id === "reversal-a").length, 1);
  assert.equal(ids.filter((id) => id === "paid-bill-transaction").length, 1);
  for (const excluded of ["paid-bill-a", "purchase-a", "installment-a", "opening-a", "pending-a"]) assert.ok(!ids.includes(excluded));
  assert.equal(result.body.items.find((item) => item.entityId === "payment-a").signedAmountCents, -1_000);
  assert.equal(result.body.items.find((item) => item.entityId === "reversal-a").signedAmountCents, 1_000);
});

test("limit é estrito, default 50, máximo 100 e paginação/cursor são preservados", async (t) => {
  setup(t);
  const first = await get(query());
  assert.equal(first.body.items.length, 50);
  assert.equal(first.body.hasMore, true);
  assert.ok(first.body.nextCursor);
  const second = await get(query({ cursor: first.body.nextCursor }));
  assert.equal(second.status, 200);
  assert.equal(new Set([...first.body.items, ...second.body.items].map((item) => item.id)).size, first.body.items.length + second.body.items.length);
  assert.equal((await get(query({ limit: "100" }))).status, 200);
  for (const invalid of ["0", "-1", "101", "1.5", "1e2"]) assert.equal((await get(query({ limit: invalid }))).status, 400);
});

test("cursor malformado ou de outro escopo retorna 400 e nunca reinicia silenciosamente", async (t) => {
  setup(t);
  assert.equal((await get(query({ cursor: "invalid*" }))).status, 400);
  const first = await get(query({ limit: "1" }));
  assert.ok(first.body.nextCursor);
  assert.equal((await get(query({ limit: "1", cursor: first.body.nextCursor, eventType: "expense" }))).status, 400);
});

test("parâmetros desconhecidos, repetidos e ambíguos falham fechado", async (t) => {
  setup(t);
  assert.equal((await get(`${query()}&unknown=x`)).status, 400);
  assert.equal((await get(`${query()}&accountId=account-a`)).status, 400);
  assert.equal((await get(`${query({ eventType: "all" })}&eventType=income`)).status, 400);
});

test("erro interno é sanitizado e a API permanece somente leitura", async (t) => {
  const f = setup(t);
  const before = f.db.prepare("SELECT total_changes() AS value").get().value;
  const ok = await get(query({ limit: "1" }));
  assert.equal(ok.status, 200);
  const after = f.db.prepare("SELECT total_changes() AS value").get().value;
  assert.equal(after, before);
  const original = runtime.DB;
  runtime.DB = { prepare() { throw new Error("SELECT secret FROM private_table at C:\\project\\route.ts"); } };
  const failed = await get(query());
  runtime.DB = original;
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: "Não foi possível carregar o extrato da conta." });
  assert.doesNotMatch(JSON.stringify(failed.body), /SELECT|private_table|route\.ts/u);
  const source = readFileSync(new URL("../app/api/finance/account-statement/route.ts", import.meta.url), "utf8");
  assert.match(source, /export async function GET/u);
  assert.doesNotMatch(source, /export async function (?:POST|PUT|PATCH|DELETE)/u);
});

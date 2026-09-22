import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { digestToken } from "../lib/auth-crypto.mjs";

// Only runtime adapters are replaced: cookies, D1 transport and Telegram HTTP.
// Authentication, routes, Drizzle and financial services execute their real code.
const runtime = globalThis.__telegramHandlerTestEnv ?? {};
globalThis.__telegramHandlerTestEnv = runtime;
register(`data:text/javascript,${encodeURIComponent(`
  import { existsSync, statSync } from "node:fs";
  import { dirname, extname, resolve as resolvePath } from "node:path";
  import { fileURLToPath, pathToFileURL } from "node:url";
  const root = ${JSON.stringify(process.cwd())};
  function file(path) { return (extname(path) ? [path] : [path, path + ".ts", path + ".mjs", resolvePath(path, "index.ts")]).find(p => existsSync(p) && statSync(p).isFile()); }
  export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { shortCircuit: true, url: "data:text/javascript,export const env=globalThis.__telegramHandlerTestEnv" };
    if (specifier === "next/headers") return { shortCircuit: true, url: "data:text/javascript,export async function cookies(){return {get:()=>globalThis.__invoiceTestCookie ? {value:globalThis.__invoiceTestCookie} : undefined}}" };
    if (specifier === "next/server") return next("next/server.js", context);
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);
const advanced = await import("../app/api/finance/advanced/route.ts");
const invoiceDetails = await import("../app/api/finance/invoice-details/route.ts");
const main = await import("../app/api/finance/route.ts");
const notifications = await import("../app/api/notifications/run/route.ts");
const { getCurrentAccountBalances, getFinanceAnalytics } = await import("../lib/finance-analytics-service.ts");
const { configureCardCurrentState } = await import("../lib/card-onboarding-service.ts");
const { createCardPurchase } = await import("../lib/finance-service.ts");
const { handleTelegramUpdate } = await import("../lib/telegram-handler.ts");
const COOKIE = "isolated-fixture-session";
const SESSION_ID = await digestToken(COOKIE);
const AT = "2026-09-16T12:00:00.000Z";

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async raw() { const s = this.db.prepare(this.sql); const names = s.columns().map(c => c.name); return s.all(...this.bindings).map(row => names.map(name => row[name])); }
  runSync() {
    const statement = this.db.prepare(this.sql);
    if (statement.columns().length) return { success: true, results: statement.all(...this.bindings), meta: { changes: 0 } };
    const value = statement.run(...this.bindings); return { success: true, results: [], meta: { changes: value.changes } };
  }
  async run() { return this.runSync(); }
}
class LocalD1 {
  constructor(db) { this.db = db; this.beforeBatch = null; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; hook(); }
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = statements.map(s => s.runSync()); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
async function setup(t, clock = "2026-10-02T12:00:00Z", seedPurchase = true) {
  const NativeDate = globalThis.Date;
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return NativeDate.parse(clock); }
  };
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  const oldFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/api\.telegram\.org\/botfixture\/sendMessage$/u);
    sent.push(JSON.parse(options.body)); return new Response("{}", { status: 200 });
  };
  t.after(() => {
    globalThis.Date = NativeDate; globalThis.fetch = oldFetch; globalThis.__invoiceTestCookie = undefined;
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0); db.close();
  });
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) {
    for (const sql of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) db.exec(sql);
  }
  for (const s of ["a", "b"]) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${s}`, `Fixture ${s}`, `${s}@example.com`, AT, AT);
    db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${s}`, `Fixture ${s}`, `u${s}`, AT, AT);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,status,created_at) VALUES(?,?,?,?,?)").run(`m${s}`, `h${s}`, `u${s}`, "active", AT);
    db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`a${s}`, `h${s}`, "Fixture", "bank", 100000, AT, AT);
    db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`cat${s}`, `h${s}`, "Fixture", "expense", AT, AT);
    db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`card${s}`, `h${s}`, "Fixture", "Fixture", "Fixture", 500000, 17, 25, AT, AT);
  }
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)").run(SESSION_ID, "ua", "2027-12-01T12:00:00Z", AT, AT);
  const d1 = new LocalD1(db); Object.assign(runtime, { DB: d1, TELEGRAM_BOT_TOKEN: "fixture", NOTIFICATION_CRON_SECRET: "fixture" });
  globalThis.__invoiceTestCookie = COOKIE;
  const f = { db, d1, sent };
  if (seedPurchase) {
    await buy(f, 50000);
    f.invoiceId = db.prepare("SELECT id FROM card_invoices WHERE household_id='ha'").get().id;
  }
  return f;
}

async function setupImported(t) {
  const f = await setup(t, "2026-09-16T12:00:00Z", false);
  const result = await configureCardCurrentState({
    cardId: "carda",
    initialReferenceMonth: "2026-09",
    declaredCurrentInvoiceTotalCents: 10000,
    expectedCardUpdatedAt: AT,
    expectedClosesOn: "2026-09-17",
    expectedDueOn: "2026-09-25",
    closedCycleConfirmed: false,
    idempotencyKey: "invoice-detail-import",
    commitments: [{
      description: "Compra teste antiga",
      installmentAmountCents: 6000,
      firstOriginalInstallmentNumber: 5,
      originalInstallmentCount: 10,
      originalTotalCents: 60000,
      categoryId: "cata",
    }],
  }, { householdId: "ha", userId: "ua", d1: f.d1, timestamp: AT });
  f.invoiceId = result.invoiceId;
  return f;
}
async function buy(f, totalCents, suffix = "a") {
  return createCardPurchase({ cardId: `card${suffix}`, categoryId: `cat${suffix}`, description: "Fixture", totalCents, purchaseDate: "2026-09-16", installmentCount: 1 }, { householdId: `h${suffix}`, userId: `u${suffix}`, origin: "dashboard", timestamp: AT });
}
async function action(action, fields = {}) {
  const response = await advanced.POST(new Request("https://fixture.invalid/api/finance/advanced", { method: "POST", headers: { origin: "https://fixture.invalid", "content-type": "application/json" }, body: JSON.stringify({ action, ...fields }) }));
  return { status: response.status, headers: response.headers, body: await response.json() };
}
function pay(f, fields = {}) { return action("pay_invoice", { invoiceId: f.invoiceId, accountId: "aa", paidAt: "2026-09-30", idempotencyKey: "payment", expectedRemainingCents: 50000, ...fields }); }
function reverse(paymentId, fields = {}) { return action("reverse_invoice_payment", { paymentId, reversedAt: "2026-10-02", idempotencyKey: "reversal", ...fields }); }
async function snapshot(month = "2026-09") {
  const response = await advanced.GET(new Request(`https://fixture.invalid/api/finance/advanced?month=${month}`));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store"); return response.json();
}
async function detail(parameters = {}) {
  const query = new URLSearchParams({ invoiceId: String(parameters.invoiceId ?? ""), activePage: String(parameters.activePage ?? 1), cancelledPage: String(parameters.cancelledPage ?? 1), pageSize: String(parameters.pageSize ?? 20) });
  const response = await invoiceDetails.GET(new Request(`https://fixture.invalid/api/finance/invoice-details?${query}`));
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function balance(date) { return (await getCurrentAccountBalances("ha", date)).find(a => a.accountId === "aa").currentBalanceCents; }
function analytics(from = "2026-09-01", to = "2026-09-30", changes = {}) {
  return getFinanceAnalytics({ householdId: "ha", userId: "ua", householdCreatedAt: "2026-01-01" }, { view: "report", period: "custom", from, to, page: 1, limit: 20, ...changes });
}
function count(f, table) { return f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n; }
async function notify() {
  const result = await notifications.POST(new Request("https://fixture.invalid/api/notifications/run", { method: "POST", headers: { authorization: "Bearer fixture" } }));
  assert.equal(result.status, 410); return result.json();
}
function prepareNotification(f) {
  f.db.prepare("UPDATE card_invoices SET due_date='2026-10-02' WHERE id=?").run(f.invoiceId);
  f.db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("link", "ha", "ua", "42", "42", AT, AT);
}

test("advanced read model inclui parcelas do initial_state no valor identificado", async (t) => {
  await setupImported(t);
  const data = await snapshot("2026-09");
  assert.deepEqual(data.invoices[0].openingBalance, { originalCents: 10000, openingCents: 4000, initialStateInstallmentsCents: 6000, allocatedCents: 0, residualCents: 4000, identifiedCents: 6000 });
});

test("API paga residual integral sem criar transaction nem reescrever status", async t => {
  const f = await setup(t); const p = await pay(f); assert.equal(p.status, 200); assert.equal(p.body.amountCents, 50000);
  assert.equal(p.headers.get("cache-control"), "private, no-store"); assert.equal(count(f, "transactions"), 0);
  assert.equal(f.db.prepare("SELECT status FROM card_installments").get().status, "pending");
  assert.equal((await snapshot()).invoices[0].paymentStatus, "settled");
});
test("API não confia em amount nem householdId enviados pelo cliente", async t => {
  const f = await setup(t); const p = await pay(f, { amountCents: 1, householdId: "hb" }); assert.equal(p.status, 200); assert.equal(p.body.amountCents, 50000);
  assert.equal(f.db.prepare("SELECT household_id FROM invoice_payments").get().household_id, "ha");
});
test("API residual zero registra no_payment sem segundo débito", async t => {
  const f = await setup(t); await pay(f); const result = await pay(f, { idempotencyKey: "zero", expectedRemainingCents: 0 });
  assert.equal(result.status, 200); assert.equal(result.body.outcome, "already_settled"); assert.equal(result.body.paymentId, null); assert.equal(count(f, "invoice_payments"), 1);
});
test("API stale expectedRemaining retorna 409 e nenhum efeito", async t => {
  const f = await setup(t); assert.equal((await pay(f, { expectedRemainingCents: 1 })).status, 409); assert.equal(count(f, "invoice_payments"), 0); assert.equal(count(f, "invoice_payment_operations"), 0);
});
test("API retry idempotente mantém recibo e só um débito", async t => {
  const f = await setup(t); const first = await pay(f); const replay = await pay(f); assert.equal(replay.status, 200); assert.equal(replay.body.operationId, first.body.operationId); assert.equal(count(f, "invoice_payments"), 1); assert.equal(await balance("2026-10-02"), 50000);
});
test("API mesma key com fingerprint diferente retorna 409", async t => {
  const f = await setup(t); await pay(f); assert.equal((await pay(f, { paidAt: "2026-09-29" })).status, 409); assert.equal(count(f, "invoice_payments"), 1);
});
test("API operationId é alternativa explícita à chave", async t => {
  const f = await setup(t); const p = await pay(f, { idempotencyKey: undefined, operationId: "fixture-operation" }); assert.equal(p.status, 200); assert.equal(p.body.operationId, "fixture-operation");
});
test("API payload legado sem confirmação/chave é bloqueado antes do ledger", async t => {
  const f = await setup(t); assert.equal((await pay(f, { idempotencyKey: undefined, expectedRemainingCents: undefined })).status, 400); assert.equal(count(f, "invoice_payments"), 0);
});
test("API reversal preserva original, mesma invoice/conta/valor", async t => {
  const f = await setup(t); const p = await pay(f); const r = await reverse(p.body.paymentId); assert.equal(r.status, 200); assert.equal(r.body.outcome, "reversed");
  assert.equal(r.body.amountCents, 50000); assert.equal(r.body.accountId, "aa"); assert.equal(r.body.invoiceId, f.invoiceId); assert.equal(count(f, "invoice_payments"), 1); assert.equal(await balance("2026-10-02"), 100000);
});
test("API reversal anterior a paidAt é rejeitada", async t => {
  const f = await setup(t); const p = await pay(f); assert.equal((await reverse(p.body.paymentId, { reversedAt: "2026-09-29" })).status, 400); assert.equal(count(f, "invoice_payment_operations"), 1);
});
test("API reversal replay não duplica crédito; outra key conflita", async t => {
  const f = await setup(t); const p = await pay(f); const r = await reverse(p.body.paymentId); assert.equal((await reverse(p.body.paymentId)).body.operationId, r.body.operationId);
  assert.equal((await reverse(p.body.paymentId, { idempotencyKey: "other" })).status, 409); assert.equal(await balance("2026-10-02"), 100000);
});
test("API membership inativa não autoriza pagamento", async t => {
  const f = await setup(t); f.db.exec("UPDATE household_members SET status='removed' WHERE id='ma'"); assert.equal((await pay(f)).status, 401); assert.equal(count(f, "invoice_payments"), 0);
});
test("API revalida membership dentro do batch atômico", async t => {
  const f = await setup(t); f.d1.beforeBatch = () => f.db.exec("UPDATE household_members SET status='removed' WHERE id='ma'"); assert.equal((await pay(f)).status, 409); assert.equal(count(f, "invoice_payments"), 0); assert.equal(count(f, "invoice_payment_operations"), 0);
});
test("API invoice de outra família não revela dados", async t => {
  const f = await setup(t); await buy(f, 12000, "b"); const id = f.db.prepare("SELECT id FROM card_invoices WHERE household_id='hb'").get().id;
  assert.equal((await pay(f, { invoiceId: id, householdId: "hb", expectedRemainingCents: 12000 })).status, 404); assert.equal(count(f, "invoice_payments"), 0);
});
test("API account de outra família não pode pagar invoice local", async t => {
  const f = await setup(t); assert.equal((await pay(f, { accountId: "ab" })).status, 400); assert.equal(count(f, "invoice_payments"), 0);
});
test("API reversal e histórico de outra família são bloqueados", async t => {
  const f = await setup(t); const p = await pay(f); f.db.prepare("UPDATE sessions SET user_id='ub' WHERE id=?").run(SESSION_ID);
  assert.equal((await reverse(p.body.paymentId)).status, 404); assert.equal((await action("get_invoice_payment_history", { invoiceId: f.invoiceId })).status, 404);
});
test("API sem sessão ou origem correta não permite escrever", async t => {
  const f = await setup(t); globalThis.__invoiceTestCookie = undefined; assert.equal((await pay(f)).status, 401);
  assert.equal((await advanced.POST(new Request("https://fixture.invalid/api/finance/advanced", { method: "POST", body: "{}" }))).status, 403);
});
test("reativação pela API rejeita sessão ausente e membership inativa sem alterar o cartão", async t => {
  const f = await setup(t, "2026-09-16T12:00:00Z", false); f.db.exec("UPDATE credit_cards SET is_active=0 WHERE id='carda'");
  globalThis.__invoiceTestCookie = undefined; assert.equal((await action("reactivate_card", { id: "carda" })).status, 401);
  globalThis.__invoiceTestCookie = COOKIE; f.db.exec("UPDATE household_members SET status='inactive' WHERE id='ma'");
  assert.equal((await action("reactivate_card", { id: "carda" })).status, 401);
  assert.equal(f.db.prepare("SELECT is_active FROM credit_cards WHERE id='carda'").get().is_active, 0);
});
test("saldo deduz payment mesmo após reversal posterior", async t => {
  const f = await setup(t); const p = await pay(f); await reverse(p.body.paymentId); assert.equal(await balance("2026-09-30"), 50000);
});
test("saldo credita reversal somente na própria data", async t => {
  const f = await setup(t); const p = await pay(f); await reverse(p.body.paymentId); assert.equal(await balance("2026-10-01"), 50000); assert.equal(await balance("2026-10-02"), 100000);
});
test("saldo antes do pagamento e isolamento bancário permanecem corretos", async t => {
  const f = await setup(t); await pay(f); assert.equal(await balance("2026-09-29"), 100000); assert.equal((await getCurrentAccountBalances("hb", "2026-10-02"))[0].currentBalanceCents, 100000);
});
test("analytics despesa de cartão não duplica com pagamento", async t => {
  const f = await setup(t); const before = await analytics(); await pay(f); const after = await analytics();
  assert.equal(after.totals.expense.currentCents, 50000); assert.deepEqual(after.totals, before.totals); assert.deepEqual(after.categories, before.categories); assert.deepEqual(after.timeline, before.timeline); assert.equal(after.details.totalItems, 1);
});
test("analytics reversal não vira receita nem item de drill-down", async t => {
  const f = await setup(t); const p = await pay(f); await reverse(p.body.paymentId); const a = await analytics("2026-10-01", "2026-10-31");
  assert.equal(a.totals.income.currentCents, 0); assert.equal(a.totals.expense.currentCents, 0); assert.equal(a.details.totalItems, 0); assert.equal(a.rankings.accountMovements[0].incomeCents, 0); assert.equal(a.rankings.accountMovements[0].netMovementCents, 50000);
});
test("analytics por conta não chama settlement de nova despesa", async t => {
  const f = await setup(t); await pay(f); const a = await analytics(); const bank = a.rankings.accountMovements[0]; assert.equal(bank.expenseCents, 0); assert.equal(bank.netMovementCents, -50000); assert.equal(bank.movementCents, 50000);
});
test("API parcial total 600/pago 500/residual 100 e compromissos", async t => {
  const f = await setup(t); await pay(f); await buy(f, 10000); const a = await snapshot(); assert.equal(a.invoices[0].invoiceTotalCents, 60000); assert.equal(a.invoices[0].paidCents, 50000); assert.equal(a.invoices[0].remainingCents, 10000); assert.equal(a.invoices[0].paymentStatus, "partial"); assert.equal(a.summary.commitmentsCents, 10000); assert.equal(a.summary.expenseCents, 60000);
});
test("limite após compra usa residual e não status pending", async t => {
  const f = await setup(t); f.db.exec("UPDATE card_installments SET status='paid'"); const a = await snapshot(); assert.equal(a.cards[0].usedCents, 50000); assert.equal(a.cards[0].availableCents, 450000);
});
test("limite após pagamento libera integral", async t => {
  const f = await setup(t); await pay(f); const a = await snapshot(); assert.equal(a.cards[0].usedCents, 0); assert.equal(a.cards[0].availableCents, 500000); assert.equal(a.summary.pendingCardCents, 0);
});
test("limite após nova compra consome só residual novo", async t => {
  const f = await setup(t); await pay(f); await buy(f, 20000); assert.equal((await snapshot()).cards[0].availableCents, 480000);
});
test("limite após reversal volta a consumir o pagamento original", async t => {
  const f = await setup(t); const p = await pay(f); await buy(f, 20000); await reverse(p.body.paymentId); const a = await snapshot(); assert.equal(a.cards[0].usedCents, 70000); assert.equal(a.cards[0].availableCents, 430000);
});
test("overpayment histórico não inventa crédito extra no limite", async t => {
  const f = await setup(t); f.db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run("legacy", "ha", f.invoiceId, "aa", 70000, "2026-09-30", "ua", AT);
  const a = await snapshot(); assert.equal(a.invoices[0].remainingCents, 0); assert.equal(a.cards[0].availableCents, 500000); assert.equal(await balance("2026-10-02"), 30000);
});
test("rota legada permanece inerte mesmo com dados financeiros elegíveis", async t => {
  const f = await setup(t); prepareNotification(f);
  const beforeLog = count(f, "notification_log");
  const beforeOutbox = count(f, "notification_outbox");
  const result = await notify();
  assert.deepEqual(result, { ok: false, disabled: true, code: "LEGACY_NOTIFICATION_ENGINE_DISABLED" });
  assert.equal(f.sent.length, 0);
  assert.equal(count(f, "notification_log"), beforeLog);
  assert.equal(count(f, "notification_outbox"), beforeOutbox);
});
test("histórico operation_id NULL e parcelas paid continuam no ledger", async t => {
  const f = await setup(t); f.db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run("legacy", "ha", f.invoiceId, "aa", 50000, "2026-09-30", "ua", AT);
  f.db.exec("UPDATE card_installments SET status='paid'; UPDATE card_invoices SET status='paid'"); const a = await snapshot(); assert.equal(a.invoices[0].invoiceTotalCents, 50000); assert.equal(a.invoices[0].paidCents, 50000); assert.equal(await balance("2026-10-02"), 50000);
  const history = await action("get_invoice_payment_history", { invoiceId: f.invoiceId }); assert.equal(history.status, 200); assert.equal(history.body.payments[0].operationId, null); assert.doesNotMatch(JSON.stringify(history.body), /fingerprint|idempotency_key/u);
});
test("invoice histórica closes_on NULL continua legível sem backfill", async t => {
  const f = await setup(t); f.db.exec("UPDATE card_invoices SET closes_on=NULL"); assert.equal((await snapshot()).invoices[0].cycleStatus, "unknown"); assert.equal(f.db.prepare("SELECT closes_on FROM card_invoices").get().closes_on, null);
});
test("Telegram /saldo usa payment e reversal; retry update não cria efeito financeiro", async t => {
  const f = await setup(t); prepareNotification(f); const p = await pay(f);
  const update = id => ({ update_id: id, message: { message_id: id, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "/saldo" } });
  assert.match((await handleTelegramUpdate(update(991))).text, /500,00/u); await reverse(p.body.paymentId);
  assert.match((await handleTelegramUpdate(update(992))).text, /1\.000,00/u); assert.equal((await handleTelegramUpdate(update(992))).duplicate, true); assert.equal(count(f, "transactions"), 0);
});
test("API principal saldo integral independe das últimas 200 movimentações", async t => {
  const f = await setup(t); for (let n = 0; n < 205; n++) f.db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,transaction_date,account_id,responsible_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`t${n}`, "ha", "expense", 100, "Fixture", "2026-09-16", "aa", "ua", AT, AT);
  const p = await pay(f); await reverse(p.body.paymentId); const response = await main.GET(); assert.equal(response.status, 200); const a = await response.json(); assert.equal(a.transactions.length, 200); assert.equal(a.accounts[0].currentBalanceCents, 79500); assert.equal(a.summary.availableCents, 79500);
});
test("simulador compromissos usa residual e saldo canônico", async t => {
  const f = await setup(t, "2026-09-16T12:00:00Z"); await pay(f, { paidAt: "2026-09-16" }); await buy(f, 10000);
  const a = await action("simulate_purchase", { description: "Fixture", purchaseCents: 100, purchaseDate: "2026-09-16", paymentMethod: "cash", installmentCount: 1 });
  assert.equal(a.status, 200); assert.equal(a.body.months[0].commitmentCents, 10000); assert.equal(a.body.months[0].projectedBalanceCents, 39900);
});
test("cancelamento legado não apaga pagamento nem compra quitada", async t => {
  const f = await setup(t); const p = await pay(f); const purchaseId = f.db.prepare("SELECT id FROM card_purchases").get().id;
  assert.equal((await action("delete_card_purchase", { id: purchaseId })).status, 409); assert.equal(count(f, "invoice_payments"), 1); assert.equal(count(f, "card_purchases"), 1);
  await reverse(p.body.paymentId); assert.equal((await action("delete_card_purchase", { id: purchaseId })).status, 200); assert.equal(count(f, "invoice_payments"), 1); assert.equal(f.db.prepare("SELECT status FROM card_purchases").get().status, "cancelled");
});

test("detalhe lazy da invoice 1x retorna contrato tipado sem qualquer escrita", async t => {
  const f = await setup(t);
  const before = ["card_purchases", "card_invoices", "card_installments", "invoice_payments", "invoice_payment_operations", "transactions", "audit_logs"].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  const response = await detail({ invoiceId: f.invoiceId });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(response.body.invoice, { id: f.invoiceId, cardId: "carda", cardName: "Fixture", referenceMonth: "2026-09", dueDate: "2026-09-25", closesOn: "2026-09-17", invoiceTotalCents: 50000, paidCents: 0, remainingCents: 50000, cycleStatus: "closed", paymentStatus: "unpaid" });
  assert.deepEqual(response.body.adjustments, []);
  assert.deepEqual(response.body.active.items.map(item => ({ number: item.installmentNumber, count: item.installmentCount, amount: item.installmentAmountCents, total: item.purchaseTotalCents, category: item.categoryName, subcategory: item.subcategoryName, status: item.status, included: item.includedInTotal })), [{ number: 1, count: 1, amount: 50000, total: 50000, category: "Fixture", subcategory: null, status: "pending", included: true }]);
  assert.equal(response.body.cancelled.totalItems, 0);
  const after = ["card_purchases", "card_invoices", "card_installments", "invoice_payments", "invoice_payment_operations", "transactions", "audit_logs"].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  assert.deepEqual(after, before);
});

test("detalhe mostra somente a parcela da competência com numeração e valor original", async t => {
  const f = await setup(t);
  await createCardPurchase({ cardId: "carda", categoryId: "cata", description: "Parcelada", totalCents: 30000, purchaseDate: "2026-09-16", installmentCount: 3 }, { householdId: "ha", userId: "ua", origin: "dashboard", timestamp: AT });
  const october = f.db.prepare("SELECT id FROM card_invoices WHERE household_id='ha' AND reference_month='2026-10'").get().id;
  const response = await detail({ invoiceId: october });
  assert.equal(response.status, 200); assert.equal(response.body.active.totalItems, 1);
  assert.deepEqual(response.body.active.items.map(item => [item.description, item.installmentNumber, item.installmentCount, item.installmentAmountCents, item.purchaseTotalCents]), [["Parcelada", 2, 3, 10000, 30000]]);
});

test("detalhe importado usa total histórico do metadata sem alterar fatos financeiros", async t => {
  const f = await setupImported(t);
  const tables = ["card_import_batches", "card_invoice_adjustments", "card_purchase_import_metadata", "card_purchases", "card_invoices", "card_installments", "transactions", "audit_logs"];
  const before = tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  const invoices = f.db.prepare("SELECT id,reference_month FROM card_invoices WHERE household_id='ha' ORDER BY reference_month").all();
  const displayed = [];
  for (const invoice of invoices) {
    const response = await detail({ invoiceId: invoice.id });
    assert.equal(response.status, 200);
    assert.equal(response.body.active.items.length, 1);
    displayed.push(response.body.active.items[0]);
    const expectedTotal = invoice.reference_month === "2026-09" ? 10000 : 6000;
    assert.equal(response.body.invoice.invoiceTotalCents, expectedTotal);
  }
  assert.deepEqual(displayed.map(item => [item.installmentNumber, item.installmentCount]), [[5, 10], [6, 10], [7, 10], [8, 10], [9, 10], [10, 10]]);
  assert.ok(displayed.every(item => item.installmentAmountCents === 6000));
  assert.ok(displayed.every(item => item.purchaseTotalCents === 60000));
  assert.equal(displayed.some(item => item.purchaseTotalCents === 36000), false);
  assert.deepEqual({ ...f.db.prepare("SELECT total_cents,installment_count FROM card_purchases WHERE household_id='ha'").get() }, { total_cents: 36000, installment_count: 6 });
  assert.deepEqual({ ...f.db.prepare("SELECT original_total_cents,first_original_installment_number,original_installment_count FROM card_purchase_import_metadata WHERE household_id='ha'").get() }, { original_total_cents: 60000, first_original_installment_number: 5, original_installment_count: 10 });
  assert.deepEqual({ ...f.db.prepare("SELECT amount_cents,status FROM card_invoice_adjustments WHERE household_id='ha'").get() }, { amount_cents: 4000, status: "active" });
  assert.equal(count(f, "transactions"), 0);
  const after = tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  assert.deepEqual(after, before);
});

test("detalhe de importação falha fechado quando o total histórico está ausente", async t => {
  const f = await setupImported(t);
  f.db.exec("DROP TRIGGER card_purchase_import_metadata_immutable_update");
  f.db.prepare("UPDATE card_purchase_import_metadata SET original_total_cents=NULL WHERE household_id='ha'").run();
  const response = await detail({ invoiceId: f.invoiceId });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "INVOICE_DETAIL_INCONSISTENT");
});

test("detalhe de importação falha fechado para metadata ligada a outro batch", async t => {
  const f = await setupImported(t);
  f.db.exec("DROP TRIGGER card_purchase_import_metadata_immutable_update");
  f.db.exec("DROP INDEX card_import_batches_initial_card_unique");
  f.db.exec("DROP TRIGGER card_import_batches_financial_identity_insert");
  f.db.prepare(`INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at,completed_at,voided_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("other-batch", "ha", "carda", "ua", "other-batch-key", "other-batch-fingerprint", "2026-09", 0, 0, 0, 0, "pending", AT, null, null);
  f.db.prepare("UPDATE card_purchase_import_metadata SET import_batch_id='other-batch' WHERE household_id='ha'").run();
  assert.equal((await detail({ invoiceId: f.invoiceId })).status, 409);
});

test("detalhe de importação falha fechado para metadata ligada a cartão incompatível", async t => {
  const f = await setupImported(t);
  f.db.exec("DROP TRIGGER card_purchase_import_metadata_immutable_update");
  f.db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("carda-other", "ha", "Outro cartão", "Fixture", "Fixture", 500000, 17, 25, AT, AT);
  f.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("other-card-invoice", "ha", "carda-other", "2026-09", "2026-09-25", "2026-09-17", "open", AT, AT);
  f.db.prepare(`INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at,completed_at,voided_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("other-card-batch", "ha", "carda-other", "ua", "other-card-key", "other-card-fingerprint", "2026-09", 0, 0, 0, 0, "pending", AT, null, null);
  f.db.prepare("UPDATE card_import_batches SET status='completed',completed_at=? WHERE household_id='ha' AND id='other-card-batch'").run(AT);
  f.db.prepare("UPDATE card_purchase_import_metadata SET import_batch_id='other-card-batch' WHERE household_id='ha'").run();
  assert.equal((await detail({ invoiceId: f.invoiceId })).status, 409);
});

test("metadata de outro household nunca substitui a importação local", async t => {
  const f = await setupImported(t);
  const foreign = await buy(f, 12000, "b");
  f.db.prepare("UPDATE card_purchases SET origin='system' WHERE household_id='hb' AND id=?").run(foreign.id);
  f.db.prepare(`INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at,completed_at,voided_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("foreign-batch", "hb", "cardb", "ub", "foreign-key", "foreign-fingerprint", "2026-09", 12000, 0, 1, 1, "pending", AT, null, null);
  f.db.prepare("INSERT INTO card_purchase_import_metadata(id,household_id,purchase_id,import_batch_id,first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date,imported_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("foreign-metadata", "hb", foreign.id, "foreign-batch", 1, 1, 12000, "2026-09-16", AT);
  f.db.prepare("UPDATE card_import_batches SET status='completed',completed_at=? WHERE household_id='hb' AND id='foreign-batch'").run(AT);
  f.db.exec("DROP TRIGGER card_purchase_import_metadata_delete");
  f.db.prepare("DELETE FROM card_purchase_import_metadata WHERE household_id='ha'").run();
  const response = await detail({ invoiceId: f.invoiceId });
  assert.equal(response.status, 409);
  assert.doesNotMatch(JSON.stringify(response.body), /foreign|12000|cardb/iu);
});

test("detalhe traz categoria/subcategoria e ordenação determinística", async t => {
  const f = await setup(t);
  f.db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("suba", "ha", "cata", "Subcategoria", AT, AT);
  for (const [description, purchaseDate, timestamp] of [["Primeira", "2026-09-14", "2026-09-14T10:00:00Z"], ["Segunda", "2026-09-15", "2026-09-15T10:00:00Z"]]) {
    await createCardPurchase({ cardId: "carda", categoryId: "cata", subcategoryId: "suba", description, totalCents: 1000, purchaseDate, installmentCount: 1 }, { householdId: "ha", userId: "ua", origin: "dashboard", timestamp });
  }
  const response = await detail({ invoiceId: f.invoiceId });
  assert.deepEqual(response.body.active.items.map(item => item.description), ["Primeira", "Segunda", "Fixture"]);
  assert.equal(response.body.active.items[0].categoryName, "Fixture"); assert.equal(response.body.active.items[0].subcategoryName, "Subcategoria");
});

test("cancelados ficam em seção separada e não alteram total canônico", async t => {
  const f = await setup(t); const created = await buy(f, 12000); assert.equal((await action("delete_card_purchase", { id: created.id })).status, 200);
  const response = await detail({ invoiceId: f.invoiceId });
  assert.equal(response.body.invoice.invoiceTotalCents, 50000); assert.equal(response.body.active.totalItems, 1); assert.equal(response.body.cancelled.totalItems, 1);
  assert.deepEqual(response.body.cancelled.items.map(item => [item.status, item.includedInTotal, item.installmentAmountCents]), [["cancelled", false, 12000]]);
});

test("paginação é limitada e separada para itens ativos e cancelados", async t => {
  const f = await setup(t); await buy(f, 1000); await buy(f, 2000);
  const first = await detail({ invoiceId: f.invoiceId, pageSize: 2 }); const second = await detail({ invoiceId: f.invoiceId, pageSize: 2, activePage: 2 });
  assert.equal(first.body.active.totalItems, 3); assert.equal(first.body.active.items.length, 2); assert.equal(first.body.active.hasNextPage, true);
  assert.equal(second.body.active.items.length, 1); assert.equal(second.body.active.hasPreviousPage, true); assert.equal(second.body.active.hasNextPage, false);
  assert.equal((await detail({ invoiceId: f.invoiceId, activePage: 3, pageSize: 2 })).status, 400);
  assert.equal((await detail({ invoiceId: f.invoiceId, activePage: 999, pageSize: 2 })).status, 400);
  assert.equal((await detail({ invoiceId: f.invoiceId, pageSize: 51 })).status, 400); assert.equal((await detail({ invoiceId: f.invoiceId, activePage: 0 })).status, 400);
});

test("detalhe vazio preserva a primeira página coerente e rejeita páginas posteriores", async t => {
  const f = await setup(t);
  f.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("empty-invoice", "ha", "carda", "2027-01", "2027-01-25", "2027-01-17", "open", AT, AT);
  const response = await detail({ invoiceId: "empty-invoice" });
  assert.equal(response.status, 200);
  for (const page of [response.body.active, response.body.cancelled]) {
    assert.deepEqual(page, { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 1, hasPreviousPage: false, hasNextPage: false });
  }
  assert.equal((await detail({ invoiceId: "empty-invoice", activePage: 2 })).status, 400);
  assert.equal((await detail({ invoiceId: "empty-invoice", cancelledPage: 999 })).status, 400);
});

test("invoice somente com cancelados permanece histórica e paginada separadamente", async t => {
  const f = await setup(t);
  f.db.exec("UPDATE card_purchases SET status='cancelled'; UPDATE card_installments SET status='cancelled'");
  const response = await detail({ invoiceId: f.invoiceId });
  assert.equal(response.status, 200); assert.equal(response.body.invoice.invoiceTotalCents, 0);
  assert.deepEqual([response.body.active.totalItems, response.body.active.totalPages, response.body.active.items.length], [0, 1, 0]);
  assert.deepEqual([response.body.cancelled.totalItems, response.body.cancelled.totalPages, response.body.cancelled.items.length], [1, 1, 1]);
  assert.equal(response.body.cancelled.items[0].includedInTotal, false);
});

test("detalhe pagina mais de cinquenta itens com descrição longa e classificação nula", async t => {
  const f = await setup(t); const longDescription = `Descrição ${"muito longa ".repeat(80)}`;
  const purchase = f.db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,subcategory_id,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const installment = f.db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
  for (let index = 0; index < 55; index++) {
    const id = `bulk-${String(index).padStart(2, "0")}`; const description = index === 0 ? longDescription : `Compra ${index}`;
    const createdAt = `2026-09-10T12:00:${String(index).padStart(2, "0")}Z`;
    purchase.run(id, "ha", "carda", description, 100, "2026-09-10", 1, null, null, "active", "ua", "web", createdAt, createdAt);
    installment.run(`installment-${id}`, "ha", id, f.invoiceId, 1, 1, 100, "pending", createdAt, createdAt);
  }
  const first = await detail({ invoiceId: f.invoiceId, pageSize: 50 }); const last = await detail({ invoiceId: f.invoiceId, pageSize: 50, activePage: 2 });
  assert.equal(first.status, 200); assert.deepEqual([first.body.active.totalItems, first.body.active.totalPages, first.body.active.items.length], [56, 2, 50]);
  assert.deepEqual([last.body.active.page, last.body.active.items.length, last.body.active.hasNextPage], [2, 6, false]);
  const identifiers = [...first.body.active.items, ...last.body.active.items].map(item => item.installmentId);
  assert.equal(new Set(identifiers).size, 56);
  const nullable = first.body.active.items.find(item => item.description === longDescription);
  assert.ok(nullable); assert.equal(nullable.categoryId, null); assert.equal(nullable.categoryName, null); assert.equal(nullable.subcategoryId, null); assert.equal(nullable.subcategoryName, null);
  assert.equal((await detail({ invoiceId: f.invoiceId, pageSize: 50, activePage: 3 })).status, 400);
  assert.equal((await detail({ invoiceId: f.invoiceId, pageSize: 50, activePage: 9999 })).status, 400);
});

test("relação entre purchase e invoice de cartões distintos falha fechada sem escrever", async t => {
  const f = await setup(t); assert.equal((await detail({ invoiceId: f.invoiceId })).status, 200);
  f.db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("carda-two", "ha", "Segundo cartão", "Fixture", "Fixture", 500000, 17, 25, AT, AT);
  f.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("mismatched-invoice", "ha", "carda-two", "2026-09", "2026-09-25", "2026-09-17", "open", AT, AT);
  // Simula um banco legado/corrompido para manter a defesa em profundidade do endpoint;
  // a migration 0006 bloqueia esta mutação em bancos normais.
  f.db.exec("DROP TRIGGER card_installments_card_match_update");
  f.db.prepare("UPDATE card_installments SET invoice_id=? WHERE household_id=? AND invoice_id=?").run("mismatched-invoice", "ha", f.invoiceId);
  const tables = ["card_purchases", "card_invoices", "card_installments", "invoice_payments", "invoice_payment_operations", "transactions", "audit_logs"];
  const before = tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  const response = await detail({ invoiceId: "mismatched-invoice" });
  assert.equal(response.status, 409); assert.equal(response.body.code, "INVOICE_DETAIL_INCONSISTENT");
  assert.doesNotMatch(JSON.stringify(response.body), /carda|Segundo cartão|Fixture|50000|active|invoiceTotalCents/u);
  const after = tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  assert.deepEqual(after, before);
});

test("Ver fatura e lista avançada falham fechadas para compra importada sem metadata", async t => {
  const f = await setup(t);
  f.db.prepare("UPDATE card_purchases SET origin='system' WHERE household_id='ha'").run();
  const invoiceResponse = await detail({ invoiceId: f.invoiceId });
  assert.equal(invoiceResponse.status, 409);
  assert.equal(invoiceResponse.body.code, "INVOICE_DETAIL_INCONSISTENT");
  const advancedResponse = await advanced.GET(new Request("https://fixture.invalid/api/finance/advanced?month=2026-09"));
  assert.equal(advancedResponse.status, 409);
  assert.match((await advancedResponse.json()).error, /inconsistentes/iu);
});

test("detalhe preserva estados quitado, parcial, aberto e legado", async t => {
  const f = await setup(t); await pay(f); let response = await detail({ invoiceId: f.invoiceId });
  assert.deepEqual([response.body.invoice.paymentStatus, response.body.invoice.cycleStatus, response.body.invoice.remainingCents], ["settled", "closed", 0]);
  await buy(f, 10000); response = await detail({ invoiceId: f.invoiceId });
  assert.deepEqual([response.body.invoice.paymentStatus, response.body.invoice.invoiceTotalCents, response.body.invoice.paidCents, response.body.invoice.remainingCents], ["partial", 60000, 50000, 10000]);
  f.db.exec("UPDATE card_invoices SET closes_on=NULL"); response = await detail({ invoiceId: f.invoiceId }); assert.equal(response.body.invoice.cycleStatus, "unknown");
});

test("detalhe reconhece invoice com ciclo ainda aberto", async t => {
  const f = await setup(t, "2026-09-16T12:00:00Z"); const response = await detail({ invoiceId: f.invoiceId });
  assert.equal(response.body.invoice.cycleStatus, "open"); assert.equal(response.body.invoice.paymentStatus, "unpaid");
});

test("detalhe inexistente/cross-household não vaza e autenticação é obrigatória", async t => {
  const f = await setup(t); await buy(f, 12000, "b"); const foreign = f.db.prepare("SELECT id FROM card_invoices WHERE household_id='hb'").get().id;
  assert.equal((await detail({ invoiceId: "missing" })).status, 404); const denied = await detail({ invoiceId: foreign }); assert.equal(denied.status, 404); assert.doesNotMatch(JSON.stringify(denied.body), /12000|Fixture b|cardb/u);
  globalThis.__invoiceTestCookie = undefined; assert.equal((await detail({ invoiceId: f.invoiceId })).status, 401);
});

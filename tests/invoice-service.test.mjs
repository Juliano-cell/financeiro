import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { getInvoiceState, getInvoicePaymentHistory, getInvoiceBankEvents, payInvoiceResidual, reverseInvoicePayment, cancelCardPurchase, InvoiceServiceError, invoiceCivilDate } from "../lib/invoice-service.ts";

const serviceEnv = globalThis.__telegramHandlerTestEnv ?? {};
globalThis.__telegramHandlerTestEnv = serviceEnv;
register(`data:text/javascript,${encodeURIComponent(`
  import { existsSync, statSync } from "node:fs";
  import { dirname, extname, resolve as resolvePath } from "node:path";
  import { fileURLToPath, pathToFileURL } from "node:url";
  const root = ${JSON.stringify(process.cwd())};
  function file(path) { return (extname(path) ? [path] : [path, path + ".ts", path + ".mjs", resolvePath(path, "index.ts")]).find(p => existsSync(p) && statSync(p).isFile()); }
  export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { shortCircuit: true, url: "data:text/javascript,export const env=globalThis.__telegramHandlerTestEnv" };
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);
const { createCardPurchase, FinanceValidationError } = await import("../lib/finance-service.ts");

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async raw() { const statement = this.db.prepare(this.sql); const names = statement.columns().map(c => c.name); return statement.all(...this.bindings).map(row => names.map(name => row[name])); }
  runSync() { const value = this.db.prepare(this.sql).run(...this.bindings); return { success: true, meta: { changes: value.changes }, results: [] }; }
  async run() { return this.runSync(); }
}
class LocalD1 {
  constructor(db) { this.db = db; this.beforeBatch = null; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; await hook(); }
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = statements.map(s => s.runSync()); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
const AT = "2026-09-15T12:00:00.000Z";
function setup(t) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  t.after(() => { assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0); db.close(); });
  for (const file of readdirSync(new URL("../drizzle", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) {
    for (const sql of readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) db.exec(sql);
  }
  for (const s of ["a", "b"]) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${s}`, `Fixture ${s}`, `${s}@example.com`, AT, AT);
    db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${s}`, `Fixture ${s}`, `u${s}`, AT, AT);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,status,created_at) VALUES(?,?,?,?,?)").run(`m${s}`, `h${s}`, `u${s}`, "active", AT);
    db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`a${s}`, `h${s}`, "Fixture", "bank", 100000, AT, AT);
    db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`cat${s}`, `h${s}`, "Fixture", "expense", AT, AT);
    db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`card${s}`, `h${s}`, "Fixture", "Fixture", "Fixture", 1000000, 17, 25, AT, AT);
  }
  const d1 = new LocalD1(db); serviceEnv.DB = d1;
  const context = { d1, householdId: "ha", userId: "ua", timestamp: AT };
  const creation = { householdId: "ha", userId: "ua", origin: "dashboard", timestamp: AT };
  const input = { cardId: "carda", categoryId: "cata", description: "Fixture", totalCents: 50000, purchaseDate: "2026-09-15", installmentCount: 1 };
  return { db, d1, context, creation, input };
}
async function purchase(f, changes = {}, creation = f.creation) { return createCardPurchase({ ...f.input, ...changes }, creation); }
async function invoice(f) { return f.db.prepare("SELECT id FROM card_invoices WHERE household_id='ha' ORDER BY reference_month LIMIT 1").get().id; }
async function pay(f, changes = {}, context = f.context) {
  return payInvoiceResidual({ invoiceId: await invoice(f), accountId: "aa", paidAt: "2026-09-15", idempotencyKey: "pay", expectedRemainingCents: 50000, ...changes }, context);
}
async function reverse(f, payment, changes = {}, context = f.context) {
  return reverseInvoicePayment({ paymentId: payment.paymentId, reversedAt: "2026-09-15", idempotencyKey: "reverse", ...changes }, context);
}
function snapshot(db) { return ["card_purchases", "card_invoices", "card_installments", "invoice_payments", "invoice_payment_operations", "transactions", "audit_logs"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()); }
const isConflict = e => e instanceof InvoiceServiceError && e.status === 409;

test("invoice ledger sem pagamento: unpaid/open e total em centavos", async t => {
  const f = setup(t); await purchase(f); const value = await getInvoiceState(await invoice(f), f.context);
  assert.equal(value.invoiceTotalCents, 50000); assert.equal(value.paidCents, 0); assert.equal(value.remainingCents, 50000); assert.equal(value.paymentStatus, "unpaid"); assert.equal(value.cycleStatus, "open");
});
test("pagamento integral residual não cria despesa nem muda parcelas/status legado", async t => {
  const f = setup(t); await purchase(f); const before = f.db.prepare("SELECT * FROM card_installments").all();
  const p = await pay(f); assert.equal(p.amountCents, 50000); assert.equal(p.outcome, "paid");
  const value = await getInvoiceState(await invoice(f), f.context); assert.equal(value.remainingCents, 0); assert.equal(value.paymentStatus, "settled");
  assert.deepEqual(f.db.prepare("SELECT * FROM card_installments").all(), before);
  assert.equal(f.db.prepare("SELECT status FROM card_invoices").get().status, "open"); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
  assert.equal((await getInvoiceBankEvents(await invoice(f), f.context))[0].signedCents, -50000);
});
test("residual zero registra no_payment sem efeito bancário", async t => {
  const f = setup(t); await purchase(f); await pay(f);
  const p = await pay(f, { idempotencyKey: "zero", expectedRemainingCents: 0 });
  assert.equal(p.outcome, "already_settled"); assert.equal(p.amountCents, 0); assert.equal(p.paymentId, null);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_payments").get().n, 1);
});
test("pagamento antecipado, nova compra no mesmo ciclo e segundo residual: 600 de despesa, não 1200", async t => {
  const f = setup(t); await purchase(f); await pay(f);
  await purchase(f, { totalCents: 10000, purchaseDate: "2026-09-16" }, { ...f.creation, timestamp: "2026-09-16T12:00:00Z" });
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_invoices").get().n, 1);
  const partial = await getInvoiceState(await invoice(f), f.context);
  assert.equal(partial.invoiceTotalCents, 60000); assert.equal(partial.paidCents, 50000); assert.equal(partial.remainingCents, 10000); assert.equal(partial.paymentStatus, "partial");
  const second = await pay(f, { idempotencyKey: "second", expectedRemainingCents: 10000 }); assert.equal(second.amountCents, 10000);
  assert.equal((await getInvoiceState(await invoice(f), f.context)).remainingCents, 0);
  assert.equal(f.db.prepare("SELECT SUM(amount_cents) n FROM card_installments WHERE status<>'cancelled'").get().n, 60000);
  assert.equal(f.db.prepare("SELECT SUM(amount_cents) n FROM invoice_payments").get().n, 60000);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
});
test("nova compra aceita status legado paid se ciclo conhecido ainda aberto", async t => {
  const f = setup(t); await purchase(f); await pay(f); f.db.exec("UPDATE card_invoices SET status='paid'");
  await purchase(f, { totalCents: 100 }); assert.equal((await getInvoiceState(await invoice(f), f.context)).remainingCents, 100);
});
test("compra no dia do fechamento permanece na mesma invoice", async t => {
  const f = setup(t); await purchase(f); await purchase(f, { purchaseDate: "2026-09-17" }, { ...f.creation, timestamp: "2026-09-17T12:00:00Z" });
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_invoices").get().n, 1); assert.equal(f.db.prepare("SELECT closes_on FROM card_invoices").get().closes_on, "2026-09-17");
});
test("compra depois do fechamento vai ao próximo ciclo", async t => {
  const f = setup(t); await purchase(f); await purchase(f, { purchaseDate: "2026-09-18" }, { ...f.creation, timestamp: "2026-09-18T12:00:00Z" });
  assert.deepEqual(f.db.prepare("SELECT reference_month,closes_on FROM card_invoices ORDER BY reference_month").all().map(r => ({ ...r })), [{ reference_month: "2026-09", closes_on: "2026-09-17" }, { reference_month: "2026-10", closes_on: "2026-10-17" }]);
});
for (const [closing, due, date, timestamp, expected] of [
  [31, 31, "2026-02-28", "2026-02-28T12:00:00Z", ["2026-03", "2026-03-31", "2026-02-28"]],
  [17, 25, "2026-12-18", "2026-12-18T12:00:00Z", ["2027-01", "2027-01-25", "2027-01-17"]],
  [17, 10, "2026-12-15", "2026-12-15T12:00:00Z", ["2027-01", "2027-01-10", "2026-12-17"]],
  [17, 17, "2026-09-15", AT, ["2026-10", "2026-10-17", "2026-09-17"]],
]) test(`schedule canônico closing=${closing}, due=${due}, compra=${date}`, async t => {
  const f = setup(t); f.db.prepare("UPDATE credit_cards SET closing_day=?,due_day=? WHERE id='carda'").run(closing, due);
  await purchase(f, { purchaseDate: date }, { ...f.creation, timestamp });
  const row = f.db.prepare("SELECT reference_month,due_date,closes_on FROM card_invoices").get(); assert.deepEqual([row.reference_month, row.due_date, row.closes_on], expected);
});
test("alterar closing_day depois não muda snapshot closes_on da invoice existente", async t => {
  const f = setup(t); await purchase(f); f.db.exec("UPDATE credit_cards SET closing_day=20 WHERE id='carda'"); await purchase(f);
  assert.equal(f.db.prepare("SELECT closes_on FROM card_invoices").get().closes_on, "2026-09-17");
});
for (const status of ["open", "paid"]) test(`invoice histórica ${status} com closes_on NULL: unknown e nova compra bloqueada`, async t => {
  const f = setup(t); await purchase(f); f.db.prepare("UPDATE card_invoices SET closes_on=NULL,status=?").run(status);
  assert.equal((await getInvoiceState(await invoice(f), f.context)).cycleStatus, "unknown");
  const before = snapshot(f.db); await assert.rejects(purchase(f), FinanceValidationError); assert.deepEqual(snapshot(f.db), before);
});
test("status legado paid não determina quitação; parcela paid soma e cancelled não soma", async t => {
  const f = setup(t); await purchase(f); await purchase(f, { totalCents: 10000 });
  f.db.exec("UPDATE card_invoices SET status='paid'; UPDATE card_installments SET status='paid' WHERE amount_cents=50000; UPDATE card_installments SET status='cancelled' WHERE amount_cents=10000");
  const value = await getInvoiceState(await invoice(f), f.context); assert.equal(value.invoiceTotalCents, 50000); assert.equal(value.paymentStatus, "unpaid");
});
test("status closed explícito e ciclo temporal fechado bloqueiam nova compra", async t => {
  const f = setup(t); await purchase(f); f.db.exec("UPDATE card_invoices SET status='closed'"); await assert.rejects(purchase(f), FinanceValidationError);
  f.db.exec("UPDATE card_invoices SET status='open'"); await assert.rejects(purchase(f, {}, { ...f.creation, timestamp: "2026-09-18T12:00:00Z" }), FinanceValidationError);
  assert.equal((await getInvoiceState(await invoice(f), { ...f.context, timestamp: "2026-09-18T12:00:00Z" })).cycleStatus, "closed");
});
test("reversal integral aumenta residual, preserva original, despesa e status das parcelas", async t => {
  const f = setup(t); await purchase(f); const p = await pay(f);
  const original = f.db.prepare("SELECT * FROM invoice_payments").all(); const parts = f.db.prepare("SELECT * FROM card_installments").all();
  const r = await reverse(f, p); assert.equal(r.outcome, "reversed"); assert.equal(r.amountCents, 50000); assert.equal(r.accountId, "aa");
  assert.equal((await getInvoiceState(await invoice(f), f.context)).remainingCents, 50000);
  assert.deepEqual(f.db.prepare("SELECT * FROM invoice_payments").all(), original); assert.deepEqual(f.db.prepare("SELECT * FROM card_installments").all(), parts);
  assert.equal((await getInvoiceBankEvents(await invoice(f), f.context)).reduce((s, e) => s + e.signedCents, 0), 0); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
});
test("reversal em outubro preserva saída de setembro e ciclo fechado", async t => {
  const f = setup(t); await purchase(f); const p = await pay(f);
  await reverse(f, p, { reversedAt: "2026-10-01" }, { ...f.context, timestamp: "2026-10-01T12:00:00Z" });
  const events = await getInvoiceBankEvents(await invoice(f), f.context);
  assert.equal(events.find(e => e.kind === "payment").occurredOn, "2026-09-15"); assert.equal(events.find(e => e.kind === "reversal").occurredOn, "2026-10-01");
  assert.equal((await getInvoiceState(await invoice(f), { ...f.context, timestamp: "2026-10-01T12:00:00Z" })).cycleStatus, "closed");
});
test("reversal duplicada não gera segundo crédito; replay retorna original", async t => {
  const f = setup(t); await purchase(f); const p = await pay(f); const r = await reverse(f, p); const before = snapshot(f.db);
  assert.equal((await reverse(f, p)).operationId, r.operationId); assert.deepEqual(snapshot(f.db), before);
  await assert.rejects(reverse(f, p, { idempotencyKey: "duplicate" }), isConflict); assert.deepEqual(snapshot(f.db), before);
});
test("pagamento histórico operation_id NULL pode ser revertido pelo serviço", async t => {
  const f = setup(t); await purchase(f); f.db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run("legacy", "ha", await invoice(f), "aa", 50000, "2026-09-15", "ua", AT);
  await reverse(f, { paymentId: "legacy" }); assert.equal((await getInvoiceState(await invoice(f), f.context)).paidCents, 0); assert.equal(f.db.prepare("SELECT operation_id FROM invoice_payments").get().operation_id, null);
});
test("retry payment replaya resultado original sem segundo débito/auditoria", async t => {
  const f = setup(t); await purchase(f); const p = await pay(f); await purchase(f, { totalCents: 100 }); const before = snapshot(f.db);
  const replay = await pay(f); assert.equal(replay.replayed, true); assert.equal(replay.operationId, p.operationId); assert.equal(replay.amountCents, p.amountCents); assert.deepEqual(snapshot(f.db), before);
});
test("retry no_payment depois de nova compra permanece already_settled sem pagar residual novo", async t => {
  const f = setup(t); await purchase(f); await pay(f); const no = { idempotencyKey: "zero", expectedRemainingCents: 0 }; const p = await pay(f, no);
  await purchase(f, { totalCents: 10000 }); const before = snapshot(f.db); const retry = await pay(f, no); assert.equal(retry.outcome, "already_settled"); assert.equal(retry.operationId, p.operationId); assert.deepEqual(snapshot(f.db), before);
  assert.equal((await getInvoiceState(await invoice(f), f.context)).remainingCents, 10000);
  const next = await pay(f, { idempotencyKey: "new-after-zero", expectedRemainingCents: 10000 });
  assert.equal(next.outcome, "paid"); assert.equal(next.amountCents, 10000); assert.notEqual(next.operationId, p.operationId);
  assert.equal((await getInvoiceState(await invoice(f), f.context)).remainingCents, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_payments").get().n, 2);
});
test("mesma chave com fingerprint diferente conflita sem efeitos", async t => {
  const f = setup(t); await purchase(f); await pay(f); const before = snapshot(f.db);
  for (const changes of [{ expectedRemainingCents: 0 }, { paidAt: "2026-09-14" }, { operationId: "other" }]) await assert.rejects(pay(f, changes), e => isConflict(e) && e.code === "INVOICE_IDEMPOTENCY_CONFLICT");
  assert.deepEqual(snapshot(f.db), before);
});
test("outro membro ativo da mesma família pode pagar e reverter com autoria própria", async t => {
  const f = setup(t); await purchase(f); f.db.prepare("INSERT INTO household_members(id,household_id,user_id,status,created_at) VALUES(?,?,?,?,?)").run("shared", "ha", "ub", "active", AT);
  const p = await pay(f, {}, { ...f.context, userId: "ub" }); await reverse(f, p);
  assert.equal(f.db.prepare("SELECT created_by_user_id FROM invoice_payments").get().created_by_user_id, "ub"); assert.equal(f.db.prepare("SELECT created_by_user_id FROM invoice_payment_operations WHERE kind='reversal'").get().created_by_user_id, "ua");
});
test("membro inativo não lê/paga/reverte, sem efeitos financeiros", async t => {
  const f = setup(t); await purchase(f); const p = await pay(f); f.db.exec("UPDATE household_members SET status='inactive' WHERE id='ma'"); const before = snapshot(f.db);
  for (const action of [() => getInvoiceState(p.invoiceId, f.context), () => pay(f), () => reverse(f, p), () => getInvoicePaymentHistory(p.invoiceId, f.context)]) await assert.rejects(action(), e => e.status === 403);
  assert.deepEqual(snapshot(f.db), before);
});
test("invoice/account/payment de outra família não revelam dados nem permitem efeitos", async t => {
  const f = setup(t); await purchase(f); const p = await pay(f); const other = { ...f.context, householdId: "hb", userId: "ub" }; const before = snapshot(f.db);
  await assert.rejects(getInvoiceState(p.invoiceId, other), e => e.status === 404); await assert.rejects(pay(f, { accountId: "ab", idempotencyKey: "cross" }), /Conta inválida/);
  await assert.rejects(pay(f, { idempotencyKey: "cross" }, other), e => e.status === 404); await assert.rejects(reverse(f, p, {}, other), e => e.status === 404);
  await assert.rejects(getInvoiceBankEvents(p.invoiceId, other), e => e.status === 404); assert.deepEqual(snapshot(f.db), before);
});
test("conta inativa não aceita novo pagamento", async t => {
  const f = setup(t); await purchase(f); f.db.exec("UPDATE accounts SET is_active=0 WHERE id='aa'"); await assert.rejects(pay(f), /Conta inválida/);
});
test("paidAt futuro/inválido rejeitado; calendário São Paulo evita dia UTC implícito", async t => {
  const f = setup(t); await purchase(f);
  for (const paidAt of ["2026-09-16", "2026-02-30", "2026-13-01", "2026-00-10", "2026-09-15T00:00:00Z"]) await assert.rejects(pay(f, { paidAt }), /Data inválida|data futura/);
  assert.equal(invoiceCivilDate("2027-01-01T01:00:00Z"), "2026-12-31");
  await assert.rejects(pay(f, { paidAt: "2026-09-15" }, { ...f.context, timestamp: "2026-09-15T01:00:00Z" }), /data futura/);
});
test("concorrência payment primeiro: nova compra deixa residual 100 sem declarar quitada", async t => {
  const f = setup(t); await purchase(f); f.d1.beforeBatch = async () => { await pay(f); };
  await purchase(f, { totalCents: 10000 }); const value = await getInvoiceState(await invoice(f), f.context);
  assert.equal(value.paidCents, 50000); assert.equal(value.remainingCents, 10000); assert.equal(value.paymentStatus, "partial");
});
test("concorrência purchase primeiro: guard SQL rejeita confirmação antiga sem debitar", async t => {
  const f = setup(t); await purchase(f); f.d1.beforeBatch = async () => { await purchase(f, { totalCents: 10000 }); };
  await assert.rejects(pay(f), isConflict); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_payments").get().n, 0); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_payment_operations").get().n, 0);
  assert.equal((await getInvoiceState(await invoice(f), f.context)).remainingCents, 60000);
});
test("membership revogada entre leitura e batch é rejeitada pelo SQL", async t => {
  const f = setup(t); await purchase(f); f.d1.beforeBatch = async () => { f.db.exec("UPDATE household_members SET status='inactive' WHERE id='ma'"); };
  await assert.rejects(pay(f), isConflict); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_payments").get().n, 0);
});
test("dois pagamentos concorrentes mesma chave convergem para um único efeito", async t => {
  const f = setup(t); await purchase(f); const rows = await Promise.all([pay(f), pay(f)]);
  assert.equal(rows[0].operationId, rows[1].operationId); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_payments").get().n, 1); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE entity_type='invoice_payment_operation'").get().n, 1);
});
test("dois pagamentos concorrentes chaves diferentes: somente um pode pagar confirmação antiga", async t => {
  const f = setup(t); await purchase(f); const rows = await Promise.allSettled([pay(f), pay(f, { idempotencyKey: "racer" })]);
  assert.equal(rows.filter(r => r.status === "fulfilled").length, 1); assert.equal(rows.filter(r => r.status === "rejected" && isConflict(r.reason)).length, 1); assert.equal(f.db.prepare("SELECT SUM(amount_cents) n FROM invoice_payments").get().n, 50000);
});
test("falha tardia na auditoria reverte pagamento e receipt integralmente", async t => {
  const f = setup(t); await purchase(f); const before = snapshot(f.db); f.db.exec("CREATE TEMP TRIGGER reject_invoice_audit BEFORE INSERT ON audit_logs WHEN NEW.entity_type='invoice_payment_operation' BEGIN SELECT RAISE(ABORT,'forced audit failure'); END");
  await assert.rejects(pay(f), /forced audit failure/); assert.deepEqual(snapshot(f.db), before);
});
test("falha tardia na reversal reverte receipt e crédito", async t => {
  const f = setup(t); await purchase(f); const p = await pay(f); const before = snapshot(f.db); f.db.exec("CREATE TEMP TRIGGER reject_reversal_audit BEFORE INSERT ON audit_logs WHEN NEW.action='reversal' BEGIN SELECT RAISE(ABORT,'forced reversal failure'); END");
  await assert.rejects(reverse(f, p), /forced reversal failure/); assert.deepEqual(snapshot(f.db), before);
});
test("cancelamento com qualquer pagamento ativo bloqueado; após reversal permitido sem crédito fictício", async t => {
  const f = setup(t); const c = await purchase(f); const p = await pay(f); const before = snapshot(f.db);
  await assert.rejects(cancelCardPurchase(c.id, f.context), e => isConflict(e) && e.code === "INVOICE_ACTIVE_PAYMENT"); assert.deepEqual(snapshot(f.db), before);
  await reverse(f, p); await cancelCardPurchase(c.id, f.context); assert.equal((await getInvoiceState(await invoice(f), f.context)).invoiceTotalCents, 0); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
});
test("cancelamento revalida pagamento concorrente no batch e não reduz total parcialmente", async t => {
  const f = setup(t); const c = await purchase(f); f.d1.beforeBatch = async () => { await pay(f); };
  await assert.rejects(cancelCardPurchase(c.id, f.context), isConflict); assert.equal(f.db.prepare("SELECT status FROM card_purchases").get().status, "active"); assert.equal((await getInvoiceState(await invoice(f), f.context)).invoiceTotalCents, 50000);
});
test("histórico contém pagamento/reversão sem expor fingerprint/idempotency key", async t => {
  const f = setup(t); await purchase(f); const p = await pay(f); await reverse(f, p); const history = await getInvoicePaymentHistory(p.invoiceId, f.context);
  assert.equal(history.payments.length, 1); assert.equal(history.operations.length, 2); assert.doesNotMatch(JSON.stringify(history), /fingerprint|idempotency/iu);
});

test("pagamento parcial livre/NaN/Infinity não é permitido e IDs de operação não são reutilizados", async t => {
  const f = setup(t); await purchase(f); const before = snapshot(f.db);
  for (const expectedRemainingCents of [100, 0, 50001]) await assert.rejects(pay(f, { expectedRemainingCents }), isConflict);
  for (const expectedRemainingCents of [NaN, Infinity, -1, 0.5]) await assert.rejects(pay(f, { expectedRemainingCents }), /Confirmação de valor inválida/);
  assert.deepEqual(snapshot(f.db), before);
  await pay(f, { operationId: "op-fixed" }); await purchase(f, { totalCents: 100 }); const paid = snapshot(f.db);
  await assert.rejects(pay(f, { idempotencyKey: "another", operationId: "op-fixed", expectedRemainingCents: 100 }), isConflict); assert.deepEqual(snapshot(f.db), paid);
});
test("chaves iguais em famílias distintas permanecem independentes", async t => {
  const f = setup(t); await purchase(f); await pay(f);
  await purchase(f, { cardId: "cardb", categoryId: "catb" }, { ...f.creation, householdId: "hb", userId: "ub" });
  const invoiceId = f.db.prepare("SELECT id FROM card_invoices WHERE household_id='hb'").get().id;
  const p = await pay(f, { invoiceId, accountId: "ab" }, { ...f.context, householdId: "hb", userId: "ub" });
  assert.equal(p.amountCents, 50000); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_payments").get().n, 2);
});
test("falha no INSERT de pagamento reverte receipt anterior; no_payment com falha de auditoria também reverte", async t => {
  const f = setup(t); await purchase(f); const before = snapshot(f.db);
  f.db.exec("CREATE TEMP TRIGGER reject_payment BEFORE INSERT ON invoice_payments BEGIN SELECT RAISE(ABORT,'forced intermediate failure'); END");
  await assert.rejects(pay(f), /forced intermediate failure/); assert.deepEqual(snapshot(f.db), before); f.db.exec("DROP TRIGGER reject_payment");
  await pay(f); const settled = snapshot(f.db);
  f.db.exec("CREATE TEMP TRIGGER reject_no_payment_audit BEFORE INSERT ON audit_logs WHEN NEW.action='no_payment' BEGIN SELECT RAISE(ABORT,'forced no payment audit'); END");
  await assert.rejects(pay(f, { idempotencyKey: "zero-fail", expectedRemainingCents: 0 }), /forced no payment audit/); assert.deepEqual(snapshot(f.db), settled);
});
test("reversal futura/data civil inválida é rejeitada e conta inativa preserva reversibilidade histórica", async t => {
  const f = setup(t); await purchase(f); const p = await pay(f);
  for (const reversedAt of ["2026-09-16", "2026-02-30", "bad"]) await assert.rejects(reverse(f, p, { reversedAt }), /Data inválida|data futura/);
  f.db.exec("UPDATE accounts SET is_active=0 WHERE id='aa'"); await reverse(f, p); assert.equal((await getInvoiceState(await invoice(f), f.context)).remainingCents, 50000);
});
test("concorrência no_payment com chave igual e fingerprints diferentes não paga nem sobrescreve receipt", async t => {
  const f = setup(t); await purchase(f); await pay(f);
  const rows = await Promise.allSettled([pay(f, { idempotencyKey: "race-zero", expectedRemainingCents: 0 }), pay(f, { idempotencyKey: "race-zero", expectedRemainingCents: 0, paidAt: "2026-09-14" })]);
  assert.equal(rows.filter(r => r.status === "fulfilled").length, 1); assert.equal(rows.filter(r => r.status === "rejected" && isConflict(r.reason)).length, 1); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_payments").get().n, 1);
});
test("compra com cycle snapshot bloqueado no batch não deixa parcelas, purchase ou auditoria parcial", async t => {
  const f = setup(t); await purchase(f); const before = snapshot(f.db); f.d1.beforeBatch = async () => { f.db.exec("UPDATE card_invoices SET status='closed'"); };
  await assert.rejects(purchase(f), FinanceValidationError);
  const after = snapshot(f.db); before[1][0].status = "closed"; assert.deepEqual(after, before);
});

test("reversal anterior ao pagamento não deixa efeitos nem consome a chave; mesmo dia é permitido", async t => {
  const f = setup(t); await purchase(f); const context = { ...f.context, timestamp: "2026-10-02T12:00:00Z" };
  const p = await pay(f, { paidAt: "2026-09-30" }, context);
  const before = snapshot(f.db); const events = await getInvoiceBankEvents(p.invoiceId, context);
  const ledger = await getInvoiceState(p.invoiceId, context);
  await assert.rejects(reverse(f, p, { reversedAt: "2026-09-29" }, context), e => e instanceof InvoiceServiceError && e.status === 400 && /anterior ao pagamento original/u.test(e.message));
  assert.deepEqual(snapshot(f.db), before);
  assert.deepEqual(await getInvoiceBankEvents(p.invoiceId, context), events);
  assert.deepEqual(await getInvoiceState(p.invoiceId, context), ledger);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_payment_operations WHERE idempotency_key='reverse'").get().n, 0);
  const r = await reverse(f, p, { reversedAt: "2026-09-30" }, context);
  assert.equal(r.outcome, "reversed"); assert.equal(r.occurredOn, "2026-09-30"); assert.equal(r.amountCents, 50000);
  assert.deepEqual(f.db.prepare("SELECT * FROM invoice_payments").all(), before[3]);
  assert.equal((await getInvoiceState(p.invoiceId, context)).remainingCents, 50000);
  const after = snapshot(f.db); const retry = await reverse(f, p, { reversedAt: "2026-09-30" }, context);
  assert.equal(retry.replayed, true); assert.equal(retry.operationId, r.operationId); assert.deepEqual(snapshot(f.db), after);
});

test("reversal posterior em 01/10 é permitida sem mudar o pagamento em 30/09", async t => {
  const f = setup(t); await purchase(f); const context = { ...f.context, timestamp: "2026-10-02T12:00:00Z" };
  const p = await pay(f, { paidAt: "2026-09-30" }, context); const original = f.db.prepare("SELECT * FROM invoice_payments").all();
  const r = await reverse(f, p, { reversedAt: "2026-10-01" }, context);
  assert.equal(r.outcome, "reversed"); assert.equal(r.occurredOn, "2026-10-01");
  assert.deepEqual(f.db.prepare("SELECT * FROM invoice_payments").all(), original);
  assert.equal((await getInvoiceState(p.invoiceId, context)).paidCents, 0);
});

test("guard SQL rejeita reversal quando paid_at muda após a validação inicial, sem efeito parcial", async t => {
  const f = setup(t); await purchase(f); const invoiceId = await invoice(f);
  const context = { ...f.context, timestamp: "2026-10-02T12:00:00Z" };
  f.db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run("legacy-temporal", "ha", invoiceId, "aa", 50000, "2026-09-28", "ua", AT);
  let atWrite; let reachedWrite = false;
  f.d1.beforeBatch = async () => {
    // A legacy payment permits this fixture change; linked payments have stricter identity triggers.
    // Capture after the fixture change so every effect of the attempted reversal must roll back.
    reachedWrite = true;
    f.db.prepare("UPDATE invoice_payments SET paid_at=? WHERE id=?").run("2026-09-30", "legacy-temporal");
    atWrite = snapshot(f.db);
  };
  await assert.rejects(reverse(f, { paymentId: "legacy-temporal" }, { reversedAt: "2026-09-29", idempotencyKey: "sql-temporal" }, context), isConflict);
  assert.equal(reachedWrite, true); assert.deepEqual(snapshot(f.db), atWrite);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_payment_operations WHERE idempotency_key='sql-temporal'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE entity_type='invoice_payment_operation'").get().n, 0);
  const events = await getInvoiceBankEvents(invoiceId, context);
  assert.equal(events.length, 1); assert.equal(events[0].kind, "payment"); assert.equal(events[0].occurredOn, "2026-09-30");
  assert.equal((await getInvoiceState(invoiceId, context)).remainingCents, 0);
  const r = await reverse(f, { paymentId: "legacy-temporal" }, { reversedAt: "2026-09-30", idempotencyKey: "sql-temporal" }, context);
  assert.equal(r.outcome, "reversed"); assert.equal((await getInvoiceState(invoiceId, context)).remainingCents, 50000);
});

test("eventos bancários mantêm débito de 30/09 e crédito de 02/10 nos cortes temporais", async t => {
  const f = setup(t); await purchase(f); const context = { ...f.context, timestamp: "2026-10-02T12:00:00Z" };
  const p = await pay(f, { paidAt: "2026-09-30" }, context); const original = f.db.prepare("SELECT * FROM invoice_payments").all();
  await reverse(f, p, { reversedAt: "2026-10-02" }, context);
  const events = await getInvoiceBankEvents(p.invoiceId, context);
  assert.deepEqual(events.map(e => [e.kind, e.occurredOn, e.signedCents]), [["payment", "2026-09-30", -50000], ["reversal", "2026-10-02", 50000]]);
  for (const [date, expected] of [["2026-09-29", 0], ["2026-09-30", -50000], ["2026-10-01", -50000], ["2026-10-02", 0]]) {
    assert.equal(events.filter(e => e.occurredOn <= date).reduce((sum, e) => sum + e.signedCents, 0), expected, date);
  }
  assert.deepEqual(f.db.prepare("SELECT * FROM invoice_payments").all(), original);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
});

test("novo pagamento após reversal quita o residual e preserva payment A, reversal A e payment B", async t => {
  const f = setup(t); await purchase(f); const p = await pay(f); const original = f.db.prepare("SELECT * FROM invoice_payments").get();
  await reverse(f, p); assert.equal((await getInvoiceState(p.invoiceId, f.context)).remainingCents, 50000);
  const next = await pay(f, { idempotencyKey: "pay-after-reversal" });
  assert.notEqual(next.operationId, p.operationId); assert.equal(next.amountCents, 50000);
  const ledger = await getInvoiceState(p.invoiceId, f.context);
  assert.equal(ledger.invoiceTotalCents, 50000); assert.equal(ledger.paidCents, 50000); assert.equal(ledger.remainingCents, 0); assert.equal(ledger.paymentStatus, "settled");
  assert.deepEqual(f.db.prepare("SELECT * FROM invoice_payments WHERE id=?").get(p.paymentId), original);
  const history = await getInvoicePaymentHistory(p.invoiceId, f.context);
  assert.equal(history.payments.length, 2); assert.equal(history.operations.length, 3);
  assert.equal(history.operations.filter(o => o.kind === "payment").length, 2); assert.equal(history.operations.filter(o => o.kind === "reversal").length, 1);
  assert.equal((await getInvoiceBankEvents(p.invoiceId, f.context)).reduce((sum, e) => sum + e.signedCents, 0), -50000);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
});

test("overpayment histórico é somente calculado: total 500, pago 600, residual zero sem crédito", async t => {
  const f = setup(t); await purchase(f); const invoiceId = await invoice(f);
  f.db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run("legacy-overpay", "ha", invoiceId, "aa", 60000, "2026-09-15", "ua", AT);
  const before = snapshot(f.db); const ledger = await getInvoiceState(invoiceId, f.context);
  assert.equal(ledger.invoiceTotalCents, 50000); assert.equal(ledger.paidCents, 60000); assert.equal(ledger.remainingCents, 0); assert.equal(ledger.paymentStatus, "settled");
  const events = await getInvoiceBankEvents(invoiceId, f.context);
  assert.equal(events.length, 1); assert.equal(events[0].signedCents, -60000); assert.equal(events[0].kind, "payment");
  assert.deepEqual(snapshot(f.db), before);
});

test("alterar due_day preserva reference_month, due_date e closes_on da invoice reutilizada", async t => {
  const f = setup(t); await purchase(f);
  const before = f.db.prepare("SELECT id,reference_month,due_date,closes_on FROM card_invoices").get();
  f.db.exec("UPDATE credit_cards SET due_day=28 WHERE id='carda'"); await purchase(f, { totalCents: 10000 });
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_invoices").get().n, 1);
  assert.deepEqual(f.db.prepare("SELECT id,reference_month,due_date,closes_on FROM card_invoices").get(), before);
  const ledger = await getInvoiceState(before.id, f.context);
  assert.equal(ledger.referenceMonth, before.reference_month); assert.equal(ledger.dueDate, before.due_date); assert.equal(ledger.closesOn, before.closes_on);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as invoiceRules from "../lib/invoice-ui-rules.mjs";
import * as classificationRules from "../lib/finance-ui-rules.mjs";
import * as billRules from "../lib/bill-ui-rules.mjs";
const { buildInvoicePayment, buildInvoiceReversal, createFinancialRefreshController, cycleStatusLabel, invoiceErrorMessage, invoiceHistoryEvents, invoiceToday, paymentStatusLabel, submitInvoiceOperation } = invoiceRules;

const invoice = { id: "fixture-invoice", cardId: "fixture-card", referenceMonth: "2026-09", dueDate: "2026-09-20", closesOn: "2026-09-18", cycleStatus: "open", paymentStatus: "settled", invoiceTotalCents: 50000, paidCents: 50000, remainingCents: 0, status: "paid", installments: [] };
const reopened = { ...invoice, invoiceTotalCents: 60000, remainingCents: 10000, paymentStatus: "partial" };
const accounts = [{ id: "fixture-account", name: "Conta de teste", isActive: true }, { id: "inactive", name: "Conta inativa", isActive: false }];
const source = readFileSync(new URL("../app/invoice-lifecycle.tsx", import.meta.url), "utf8");
const advanced = readFileSync(new URL("../app/advanced-finance.tsx", import.meta.url), "utf8");
const parent = readFileSync(new URL("../app/finance-app.tsx", import.meta.url), "utf8");

// Execute the real React component, substituting only visual primitives/API transport.
// No browser, database, network or generated file is required.
const primitives = `import {createElement} from ${JSON.stringify(import.meta.resolve("react"))};
${["Button", "Badge", "Input", "Label", "Dialog", "DialogContent", "DialogDescription", "DialogFooter", "DialogHeader", "DialogTitle"].map((name) => `export function ${name}({children,...props}) { return createElement(${JSON.stringify(({ Button: "button", Input: "input", Label: "label", DialogTitle: "h2" })[name] ?? "div")}, props, children); }`).join("\n")}`;
const primitiveUrl = `data:text/javascript,${encodeURIComponent(primitives)}`;
const apiUrl = `data:text/javascript,${encodeURIComponent("export class AdvancedApiError extends Error {} export async function advancedApi(){throw new Error('transport not enabled in render test')} ")}`;
let compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
compiled = compiled.replace(/from "([^"]+)"/gu, (_, specifier) => {
  const url = specifier.startsWith("@/components/") ? primitiveUrl : specifier === "@/app/advanced-finance" ? apiUrl : specifier === "@/lib/invoice-ui-rules.mjs" ? new URL("../lib/invoice-ui-rules.mjs", import.meta.url).href : specifier === "sonner" ? "data:text/javascript,export const toast={success(){},info(){}}" : import.meta.resolve(specifier);
  return `from ${JSON.stringify(url)}`;
});
const { InvoiceLifecycle, InvoiceOperationDialog } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
const lifecycleUrl = `data:text/javascript,${encodeURIComponent(compiled)}`;
const extraPrimitives = `${primitives}\n${["Checkbox", "Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"].map((name) => `export function ${name}({children}) { return createElement("div", null, children); }`).join("\n")}`;
let compiledAdvanced = ts.transpileModule(advanced, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
compiledAdvanced = compiledAdvanced.replace(/from "([^"]+)"/gu, (_, specifier) => {
  const url = specifier.startsWith("@/components/") ? `data:text/javascript,${encodeURIComponent(extraPrimitives)}` : specifier === "@/app/invoice-lifecycle" ? lifecycleUrl : specifier.startsWith("@/lib/") ? new URL(`../lib/${specifier.slice(6)}`, import.meta.url).href : specifier === "sonner" ? "data:text/javascript,export const toast={success(){},info(){}}" : import.meta.resolve(specifier);
  return `from ${JSON.stringify(url)}`;
});
const { AdvancedFinanceView, advancedApi: realAdvancedApi } = await import(`data:text/javascript,${encodeURIComponent(compiledAdvanced)}`);
const renderInvoice = (value) => renderToStaticMarkup(createElement(InvoiceLifecycle, { invoice: value, accounts, onChanged: async () => {} }));
const renderDialog = (editing) => renderToStaticMarkup(createElement(InvoiceOperationDialog, { invoice: reopened, accounts, editing, onClose() {}, onInvalidate() {}, onChanged: async () => {} }));

for (const [status, label] of [["unpaid", "Em aberto"], ["partial", "Parcialmente paga"], ["settled", "Quitada"]]) {
  test(`payment status ${status} exibe ${label}`, () => assert.equal(paymentStatusLabel(status), label));
}
test("cycle status possui textos independentes do pagamento", () => {
  assert.equal(cycleStatusLabel("open"), "Ciclo aberto");
  assert.equal(cycleStatusLabel("closed"), "Ciclo fechado");
  assert.equal(cycleStatusLabel("unknown"), "Ciclo não identificado");
});
test("componente real mostra total500/pago500/restante0, quitada e ciclo aberto", () => {
  const html = renderInvoice(invoice);
  assert.match(html, /Total da fatura/); assert.match(html, /Já pago/); assert.match(html, /Restante/);
  assert.match(html, /500,00/); assert.match(html, /Quitada/); assert.match(html, /Ciclo aberto/);
  assert.doesNotMatch(html, /Pagar restante/);
});
test("nova compra mostra total600/pago500/restante100 apesar de status legado paid", () => {
  const html = renderInvoice(reopened);
  for (const value of ["600,00", "500,00", "100,00", "Parcialmente paga", "Ciclo aberto", "Pagar restante"]) assert.ok(html.includes(value));
});
test("unknown não inventa fechamento histórico", () => {
  const html = renderInvoice({ ...invoice, closesOn: null, cycleStatus: "unknown" });
  assert.match(html, /Ciclo não identificado/); assert.doesNotMatch(html, /Fechamento:/);
});
test("faturas futuras são exibidas sem misturar competência/residual", () => {
  const html = renderInvoice({ ...reopened, referenceMonth: "2027-01", dueDate: "2027-01-20", invoiceTotalCents: 40000, paidCents: 0, remainingCents: 40000, paymentStatus: "unpaid" });
  assert.match(html, /01\/2027/); assert.match(html, /400,00/); assert.doesNotMatch(html, /600,00/);
});
test("pagamento exige escolha de uma conta ativa", () => {
  for (const accountId of ["", "other-household", "inactive"]) assert.throws(() => buildInvoicePayment(reopened, accountId, accounts, "2026-09-16"), /conta ativa/);
});
test("dialog real inicia sem conta e não escolhe primeira conta", () => {
  const html = renderDialog({ kind: "payment" });
  assert.match(html, /value="" disabled="" selected=""/);
  assert.match(html, /Selecione uma conta/); assert.doesNotMatch(html, /Conta inativa/);
  assert.match(html, /disabled="">Confirmar pagamento/);
  assert.match(html, /Valor restante/); assert.match(html, /100,00/);
});
test("operationId seguro e novo a cada nova tentativa, sem amount autoritativo", () => {
  const a = buildInvoicePayment(reopened, accounts[0].id, accounts, "2026-09-16");
  const b = buildInvoicePayment(reopened, accounts[0].id, accounts, "2026-09-16");
  assert.notEqual(a.operationId, b.operationId); assert.match(a.operationId, /^[0-9a-f-]{36}$/u);
  assert.equal(a.expectedRemainingCents, 10000); assert.equal(a.accountId, accounts[0].id);
  assert.equal(a.invoiceId, reopened.id); assert.equal(a.paidAt, "2026-09-16");
  assert.equal("amountCents" in a, false); assert.equal("amount" in a, false); assert.equal("householdId" in a, false);
});
test("dados financeiros inválidos não são enviados", () => {
  for (const remainingCents of [NaN, Infinity, -1, 1.5]) assert.throws(() => buildInvoicePayment({ ...invoice, remainingCents }, accounts[0].id, accounts, "2026-09-16"));
});
test("409 não repete pagamento, fecha confirmação e recarrega", async () => {
  const events = []; const error = Object.assign(new Error("stale"), { status: 409 });
  await assert.rejects(submitInvoiceOperation({}, { api: async () => { events.push("api"); throw error; }, onConflict: () => events.push("close"), refresh: async () => events.push("refresh"), onSuccess: () => events.push("success") }), (value) => value === error);
  assert.deepEqual(events, ["api", "close", "refresh"]); assert.match(invoiceErrorMessage(409), /novo valor restante/);
});
for (const outcome of ["paid", "already_settled", "reversed"]) {
  test(`${outcome} informa resultado e atualiza snapshot/histórico sem retry automático`, async () => {
    const events = [];
    const result = await submitInvoiceOperation({}, { api: async () => ({ outcome }), onSuccess: (value) => events.push(value), refresh: async () => events.push("refresh"), onConflict: () => events.push("conflict") });
    assert.equal(result.outcome, outcome); assert.deepEqual(events, [outcome, "refresh"]);
  });
}
test("falha503 não mostra sucesso nem marca pago e retry usa o mesmo payload", async () => {
  const payload = buildInvoicePayment(reopened, accounts[0].id, accounts, "2026-09-16");
  const sent = []; let success = 0; let refresh = 0;
  const handlers = { api: async (body) => { sent.push(body); if (sent.length === 1) throw Object.assign(new Error("transient"), { status: 503 }); return { outcome: "paid" }; }, onSuccess: () => success++, refresh: async () => refresh++, onConflict() {} };
  await assert.rejects(submitInvoiceOperation(payload, handlers));
  assert.equal(success, 0); assert.equal(refresh, 0);
  await submitInvoiceOperation(payload, handlers); assert.strictEqual(sent[0], sent[1]); assert.equal(success, 1);
});
test("resposta inesperada não confirma pagamento", async () => {
  let success = false;
  await assert.rejects(submitInvoiceOperation({}, { api: async () => ({}), onSuccess: () => { success = true; }, refresh: async () => {}, onConflict() {} }), /não reconhecida/);
  assert.equal(success, false);
});
const history = {
  payments: [{ id: "original", accountId: accounts[0].id, amountCents: 50000, paidAt: "2026-09-16T12:00:00Z", createdAt: "2026-10-03", fingerprint: "internal", idempotencyKey: "private" }],
  operations: [{ id: "payment-op", kind: "payment", occurredOn: "2026-09-16", amountCents: 50000 }, { id: "reverse", kind: "reversal", accountId: accounts[0].id, reversedPaymentId: "original", amountCents: 50000, occurredOn: "2026-10-02", createdAt: "2026-09-01", fingerprint: "internal" }, { id: "no-payment", kind: "no_payment" }],
};
test("histórico preserva original e reversal separadamente, sem dupla apresentação", () => {
  const events = invoiceHistoryEvents(history, accounts);
  assert.equal(events.length, 2); assert.deepEqual(events.map((event) => event.label), ["Pagamento", "Reversão de pagamento"]);
  assert.equal(events[0].canReverse, false); assert.equal(events[1].canReverse, false);
  assert.doesNotMatch(JSON.stringify(events), /Receita|Entrada|fingerprint|idempotencyKey|createdAt|private|internal/);
});
test("histórico ordena pela data financeira e aceita paidAt histórico timestamp", () => {
  assert.deepEqual(invoiceHistoryEvents(history, accounts).map((event) => event.date), ["2026-09-16", "2026-10-02"]);
});
test("pagamento elegível oferece reversal e conta inativa mantém nome histórico", () => {
  const events = invoiceHistoryEvents({ payments: [{ ...history.payments[0], accountId: "inactive" }], operations: [] }, accounts);
  assert.equal(events[0].canReverse, true); assert.equal(events[0].accountName, "Conta inativa");
});
test("reversal não edita valor/conta e tem operationId próprio", () => {
  const payload = buildInvoiceReversal("original", "2026-10-02");
  assert.deepEqual(Object.keys(payload).sort(), ["action", "operationId", "paymentId", "reversedAt"]);
  const event = invoiceHistoryEvents({ ...history, operations: [] }, accounts)[0];
  const html = renderDialog({ kind: "reversal", event });
  assert.match(html, /Reverter pagamento de/); assert.match(html, /pagamento original será preservado/);
  assert.match(html, /Conta de teste/); assert.doesNotMatch(html, /invoice-account|Receita|Entrada/);
});
test("data local usa America/Sao_Paulo em virada de mês/ano", () => {
  assert.equal(invoiceToday(new Date("2027-01-01T02:30:00Z")), "2026-12-31");
  assert.equal(invoiceToday(new Date("2027-01-01T03:00:00Z")), "2027-01-01");
});
for (const status of [400, 401, 403, 404, 409, 503]) test(`erro HTTP${status} possui mensagem amigável`, () => assert.ok(invoiceErrorMessage(status).length > 15));
test("limite total/utilizado/disponível usam exclusivamente o snapshot canônico, inclusive negativo", () => {
  assert.match(advanced, /label="Utilizado" value=\{brl\(item.usedCents\)\}/);
  assert.match(advanced, /label="Disponível" value=\{brl\(item.availableCents\)\}/);
  assert.doesNotMatch(advanced, /Math.max\([^\n]*availableCents|installments.reduce/);
  assert.match(advanced, /invoice=\{invoice\}/); assert.doesNotMatch(advanced, /invoice.status === "paid"|accounts.find\(\(item\) => item.isActive\)/);
});
test("cartões reais exibem utilizado1200 e disponível negativo sem recalcular parcelas", () => {
  const card = { id: invoice.cardId, name: "Cartão de teste", institution: "Instituição de teste", holder: "Titular de teste", limitCents: 100000, usedCents: 120000, availableCents: -20000, currentInvoiceCents: 40000, nextInvoiceCents: 40000, installmentPurchaseCount: 1, closingDay: 18, dueDay: 20, isActive: true };
  const html = renderToStaticMarkup(createElement(AdvancedFinanceView, { view: "cards", data: { cards: [card], invoices: [invoice], selectedMonth: "2026-09" }, accounts, categories: [], onChanged: async () => {} }));
  assert.match(html, /Utilizado/); assert.match(html, /1\.200,00/); assert.match(html, /-R\$\s*200,00/);
});
test("advancedApi preserva status409 e encaminha AbortSignal sem consultar rede", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let options;
  globalThis.fetch = async (_url, value) => { options = value; return new Response(JSON.stringify({ error: "stale", code: "INVOICE_CONFLICT" }), { status: 409 }); };
  try {
    await assert.rejects(realAdvancedApi({ action: "pay_invoice" }, undefined, controller.signal), (error) => error.status === 409 && error.code === "INVOICE_CONFLICT");
    assert.equal(options.signal, controller.signal);
  } finally { globalThis.fetch = original; }
});
test("advancedApi não transforma resposta não JSON em sucesso", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  try { await assert.rejects(realAdvancedApi({ action: "pay_invoice" }), (error) => error.status === 503); }
  finally { globalThis.fetch = original; }
});
test("mobile não exige tabela horizontal e mantém modal/controles acessíveis", () => {
  const html = renderInvoice(reopened);
  assert.doesNotMatch(html, /<table|overflow-x-auto/); assert.match(html, /sm:grid-cols-3/);
  assert.match(source, /max-h-\[85dvh\] overflow-y-auto/); assert.match(source, /min-h-11/);
  assert.match(source, /htmlFor="invoice-account"/); assert.match(source, /role="alert"/);
});
test("ignora histórico abortado/obsoleto e callbacks após desmontagem", () => {
  assert.match(source, /return \(\) => controller.abort\(\)/);
  assert.match(source, /if \(!controller.signal.aborted\)/);
  assert.match(source, /historyResult\?\.key === historyKey/);
  assert.match(source, /if \(mounted.current\)/);
  assert.match(source, /busyRef.current/);
});
test("atualiza saldo e advanced pelo refresh existente sem quebrar lazy loading", () => {
  assert.match(parent, /financial.refresh\(api/);
  assert.match(parent, /setupComplete && needsAdvanced/);
  assert.match(source, /refresh: onChanged/); assert.match(source, /get_invoice_payment_history/);
  assert.doesNotMatch(source, /householdId|household_id|Math.random|invoice.status|installment.status/);
});
test("conflito/sucesso exigem snapshot novo antes de nova operação", () => {
  assert.doesNotMatch(source, /invalidatedInvoice === invoice/);
  assert.match(source, /financial\?\.isLocked\(invoice.id\)/);
  assert.match(source, /disabled=\{awaitingSnapshot \|\|/);
  assert.match(source, /onConflict:[^\n]*onInvalidate\(\)/);
  assert.match(source, /onSuccess:[^\n]*onInvalidate\(\)/);
  assert.match(source, /Atualizar dados/);
});

// Controlled hook runtime executes the actual transpiled handlers/effect cleanups.
// It is not a visual browser test: visual primitives and transports alone are mocks.
function hookHarness(transport = async () => ({})) {
  let current;
  const notifications = [];
  const hooks = {
    useState(initial) {
      const store = current, index = store.cursor++;
      if (!(index in store.values)) store.values[index] = typeof initial === "function" ? initial() : initial;
      return [store.values[index], (value) => { store.updates++; store.values[index] = typeof value === "function" ? value(store.values[index]) : value; }];
    },
    useRef(initial) { const store = current, index = store.cursor++; return store.values[index] ??= { current: initial }; },
    useCallback(fn, deps) {
      const store = current, index = store.cursor++, old = store.values[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) store.values[index] = { fn, deps };
      return store.values[index].fn;
    },
    useEffect(fn, deps) {
      const store = current, index = store.cursor++, old = store.effects.get(index);
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) store.queue.push(() => { old?.cleanup?.(); store.effects.set(index, { deps, cleanup: fn() }); });
    },
  };
  class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const visuals = new Proxy({}, { get: (_target, name) => name });
  function compile(text, advancedExports) {
    const output = ts.transpileModule(text, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    const dependencies = (name) => {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "sonner") return { toast: { success: (message) => notifications.push(message), info: (message) => notifications.push(message), error: (message) => notifications.push(message) }, Toaster: "Toaster" };
      if (name === "@/lib/invoice-ui-rules.mjs") return invoiceRules;
      if (name === "@/lib/finance-ui-rules.mjs") return classificationRules;
      if (name === "@/lib/bill-ui-rules.mjs") return billRules;
      if (name === "@/app/advanced-finance") return advancedExports ?? { advancedApi: transport, AdvancedApiError: ApiError, AdvancedFinanceView: "AdvancedFinanceView", MonthNavigator: "MonthNavigator" };
      if (name === "@/app/invoice-lifecycle") return lifecycle;
      return visuals;
    };
    new Function("exports", "require", output)(exports, dependencies);
    return exports;
  }
  const lifecycle = compile(source);
  const cards = compile(advanced);
  const root = compile(parent);
  return {
    ...lifecycle, ...cards, ...root, ApiError, notifications,
    store: () => ({ cursor: 0, values: [], effects: new Map(), queue: [], updates: 0 }),
    render(component, props, store) { current = store; store.cursor = 0; const tree = component(props); for (const effect of store.queue.splice(0)) effect(); return tree; },
    unmount(store) { for (const effect of store.effects.values()) effect.cleanup?.(); },
  };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.action)];
}
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(""); return typeof tree === "object" && tree ? text(tree.props?.children) : String(tree ?? ""); }
const control = (tree, label) => nodes(tree).find((node) => node.props.onClick && text(node.props.children).includes(label));
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function financialFixture() { const financial = createFinancialRefreshController(); financial.mount(); return financial; }
function operationFixture(transport, financial = financialFixture(), extra = {}) {
  const harness = hookHarness(transport), store = harness.store();
  const props = { invoice: reopened, accounts, editing: { kind: "payment" }, financial, onInvalidate: () => financial.settle(reopened.id), onClose() {}, onChanged: async () => {}, ...extra };
  let tree = harness.render(harness.InvoiceOperationDialog, props, store);
  nodes(tree).find((node) => node.props.id === "invoice-account" && node.type === "select").props.onChange({ target: { value: accounts[0].id } });
  tree = harness.render(harness.InvoiceOperationDialog, props, store);
  return { harness, store, props, financial, confirm: () => (control(tree, "Confirmar pagamento") ?? control(tree, "Tentar novamente a mesma operação")).props.onClick(), render: () => harness.render(harness.InvoiceOperationDialog, props, store) };
}

test("handler real: duplo clique produz exatamente um POST", async () => {
  const request = deferred(); let calls = 0;
  const dialog = operationFixture(async () => { calls++; return request.promise; });
  dialog.confirm(); dialog.confirm(); assert.equal(calls, 1); assert.equal(dialog.financial.isLocked(reopened.id), true);
  request.resolve({ outcome: "paid" }); await flush(); assert.equal(calls, 1);
});
test("handler real sem conta: zero chamadas financeiras", async () => {
  let calls = 0; const h = hookHarness(async () => { calls++; }); const store = h.store();
  const tree = h.render(h.InvoiceOperationDialog, { invoice: reopened, accounts, editing: { kind: "payment" }, onClose() {}, onChanged: async () => {}, onInvalidate() {} }, store);
  control(tree, "Confirmar pagamento").props.onClick(); await flush(); assert.equal(calls, 0);
});
test("GET antigo antes/durante POST não aplica nem desbloqueia; refresh completo posterior desbloqueia", async () => {
  const f = financialFixture(), oldMain = deferred(), oldAdvanced = deferred(); let applied = 0;
  const old = f.refresh(() => oldMain.promise, () => oldAdvanced.promise, () => applied++, () => {});
  const post = deferred(); const dialog = operationFixture(() => post.promise, f);
  dialog.confirm(); post.resolve({ outcome: "paid" }); await flush();
  oldMain.resolve({}); oldAdvanced.resolve({ remainingCents: 10000 });
  assert.deepEqual(await old, { success: false }); assert.equal(applied, 0); assert.equal(f.generation, 0);
  assert.equal(f.isLocked(reopened.id), true);
  const h = hookHarness(); const store = h.store();
  const props = { invoice: { ...reopened }, accounts, financial: f, onChanged: async () => {} };
  assert.equal(control(h.render(h.InvoiceLifecycle, props, store), "Pagar restante").props.disabled, true);
  const fresh = await f.refresh(async () => ({}), async () => ({}), () => applied++, () => {});
  assert.equal(fresh.success, true); assert.equal(fresh.generation, 1); assert.equal(f.isLocked(reopened.id), false);
  assert.equal(control(h.render(h.InvoiceLifecycle, props, store), "Pagar restante").props.disabled, false);
});
for (const failedLoader of ["main", "advanced"]) test(`falha parcial ${failedLoader} não aplica snapshot/geração e retry completo libera`, async () => {
  const f = financialFixture(); f.start(reopened.id, { operationId: "fixture-operation" }); f.settle(reopened.id);
  let applied = 0, errors = 0;
  const fail = async () => { throw new Error("fixture failure"); }, ok = async () => ({});
  assert.equal((await f.refresh(failedLoader === "main" ? fail : ok, failedLoader === "advanced" ? fail : ok, () => applied++, () => errors++)).success, false);
  assert.equal(applied, 0); assert.equal(errors, 1); assert.equal(f.generation, 0); assert.equal(f.isLocked(reopened.id), true);
  assert.equal((await f.refresh(ok, ok, () => applied++, () => {})).success, true); assert.equal(f.isLocked(reopened.id), false);
});
test("duas atualizações fora de ordem: apenas nova aplica/avança geração", async () => {
  const f = financialFixture(), slow = deferred(); const applied = [];
  const old = f.refresh(() => slow.promise, async () => "old", (value) => applied.push(value), () => {});
  const newest = await f.refresh(async () => "new", async () => "new", (value) => applied.push(value), () => {});
  slow.resolve("old"); assert.equal((await old).success, false); assert.equal(newest.generation, 1); assert.deepEqual(applied, ["new"]);
});
test("GET iniciado durante POST também não pode publicar geração após settle", async () => {
  const f = financialFixture(); f.start(reopened.id, { operationId: "fixture-operation" });
  const old = deferred(); const result = f.refresh(() => old.promise, async () => ({}), () => assert.fail("stale apply"), () => {});
  f.settle(reopened.id); old.resolve({}); assert.equal((await result).success, false); assert.equal(f.isLocked(reopened.id), true);
});
test("unmount invalida refresh e suprime erro obsoleto", async () => {
  const f = financialFixture(), request = deferred(); let errors = 0;
  const result = f.refresh(() => request.promise, async () => ({}), () => assert.fail("unmounted apply"), () => errors++);
  f.unmount(); request.reject(new Error("old failure")); assert.equal((await result).success, false); assert.equal(errors, 0); assert.equal(f.generation, 0);
});
for (const outcome of ["already_settled", "409"]) test(`handler real ${outcome}: fecha/invalida, refresh falho mantém bloqueio sem repetir POST`, async () => {
  let calls = 0, closed = 0, refreshed = 0;
  const f = financialFixture(); const dialog = operationFixture(async () => { calls++; if (outcome === "409") throw new dialog.harness.ApiError("conflict", 409); return { outcome }; }, f, { onClose: () => closed++, onChanged: async () => { refreshed++; await f.refresh(async () => { throw new Error("failure"); }, async () => ({}), () => {}, () => {}); } });
  dialog.confirm(); await flush(); assert.equal(calls, 1); assert.equal(closed, 1); assert.equal(refreshed, 1); assert.equal(f.isLocked(reopened.id), true);
  await f.refresh(async () => ({}), async () => ({}), () => {}, () => {}); assert.equal(f.isLocked(reopened.id), false);
});
test("retry técnico e retorno à invoice mantêm mesmo UUID/payload; nova confirmação gera UUID novo", async () => {
  const sent = [], f = financialFixture();
  const dialog = operationFixture(async (payload) => { sent.push(payload); if (sent.length === 1) throw new dialog.harness.ApiError("unavailable", 503); return { outcome: "paid" }; }, f);
  dialog.confirm(); await flush(); assert.ok(f.attempt(reopened.id));
  dialog.harness.unmount(dialog.store);
  const retry = operationFixture(async (payload) => { sent.push(payload); return { outcome: "paid" }; }, f);
  retry.confirm(); await flush(); assert.strictEqual(sent[0], sent[1]); assert.equal(sent[0].operationId, sent[1].operationId);
  await f.refresh(async () => ({}), async () => ({}), () => {}, () => {});
  const next = operationFixture(async (payload) => { sent.push(payload); return { outcome: "paid" }; }, f);
  next.confirm(); await flush(); assert.notEqual(sent[2].operationId, sent[0].operationId);
});
test("sucesso após unmount liquida bloqueio da invoice original mas não atualiza estado/dialog novo", async () => {
  const post = deferred(); let closes = 0; const f = financialFixture();
  const dialog = operationFixture(() => post.promise, f, { onClose: () => closes++ }); dialog.confirm();
  dialog.harness.unmount(dialog.store); const updates = dialog.store.updates;
  post.resolve({ outcome: "paid" }); await flush(); assert.equal(dialog.store.updates, updates); assert.equal(closes, 0); assert.equal(f.isLocked(reopened.id), true);
  assert.equal(f.isLocked("fixture-other-invoice"), false);
});
test("histórico: troca aborta GET antigo; resposta antiga e unmount não atualizam estado", async () => {
  const requests = []; const h = hookHarness((_body, _month, signal) => { const result = deferred(); requests.push({ result, signal }); return result.promise; });
  const store = h.store(), f = financialFixture(); let props = { invoice: reopened, accounts, financial: f, onChanged: async () => {} };
  let tree = h.render(h.InvoiceLifecycle, props, store); control(tree, "Histórico de pagamentos").props.onClick(); h.render(h.InvoiceLifecycle, props, store);
  props = { ...props, invoice: { ...reopened, id: "fixture-next-invoice" } }; h.render(h.InvoiceLifecycle, props, store);
  assert.equal(requests[0].signal.aborted, true); const updates = store.updates;
  requests[0].result.resolve({ payments: [{ id: "old", amountCents: 99900, paidAt: "2026-09-01", accountId: accounts[0].id }], operations: [] }); await flush(); assert.equal(store.updates, updates);
  requests[1].result.resolve({ payments: [], operations: [] }); await flush(); tree = h.render(h.InvoiceLifecycle, props, store); assert.ok(text(tree).includes("Nenhum pagamento registrado")); assert.equal(text(tree).includes("999,00"), false);
  control(tree, "Histórico de pagamentos").props.onClick(); h.render(h.InvoiceLifecycle, props, store); control(h.render(h.InvoiceLifecycle, props, store), "Histórico de pagamentos").props.onClick(); h.render(h.InvoiceLifecycle, props, store);
  const last = requests.at(-1); h.unmount(store); assert.equal(last.signal.aborted, true); const after = store.updates;
  last.result.reject(new Error("unmounted")); await flush(); assert.equal(store.updates, after);
});
test("histórico real recarregado não oferece reversal de pagamento já revertido", async () => {
  const history = { payments: [{ id: "fixture-payment", accountId: accounts[0].id, amountCents: 10000, paidAt: "2026-09-15" }], operations: [{ id: "fixture-reversal", kind: "reversal", reversedPaymentId: "fixture-payment", accountId: accounts[0].id, amountCents: 10000, occurredOn: "2026-09-16" }] };
  const h = hookHarness(async () => history), store = h.store(), props = { invoice: reopened, accounts, financial: financialFixture(), onChanged: async () => {} };
  control(h.render(h.InvoiceLifecycle, props, store), "Histórico de pagamentos").props.onClick(); h.render(h.InvoiceLifecycle, props, store); await flush();
  const tree = h.render(h.InvoiceLifecycle, props, store); assert.equal(control(tree, "Reverter pagamento"), undefined); assert.ok(text(tree).includes("Pagamento revertido"));
});

const purchaseCategories = [
  { id: "fixture-no-subs", name: "Despesa sem subcategoria", type: "expense", isActive: true, subcategories: [] },
  { id: "fixture-with-subs", name: "Despesa com subcategoria", type: "both", isActive: true, subcategories: [{ id: "fixture-sub", name: "Subcategoria", isActive: true }] },
  { id: "fixture-income", name: "Receita exclusiva", type: "income", isActive: true, subcategories: [] },
];
async function purchaseFixture(run) {
  const originalFetch = globalThis.fetch, originalFormData = globalThis.FormData; const calls = [];
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ ok: true }); };
  globalThis.FormData = class { get(key) { return ({ cardId: "fixture-card", description: "Compra de teste", total: "1,20", purchaseDate: "2026-09-16", installmentCount: "1" })[key] ?? null; } };
  try {
    const h = hookHarness(), store = h.store(), props = { data: { cards: [], invoices: [] }, accounts, categories: purchaseCategories, onChanged: async () => {} };
    const render = () => h.render(h.CardsView, props, store);
    const change = (id, value) => nodes(render()).find((node) => node.type === "select" && node.props.id === id).props.onChange({ target: { value } });
    const submit = () => nodes(render()).find((node) => node.type === "form" && text(node).includes("Registrar compra")).props.onSubmit({ preventDefault() {}, currentTarget: {} });
    await run({ calls, render, change, submit });
  } finally { globalThis.fetch = originalFetch; globalThis.FormData = originalFormData; }
}
test("Compra sem categoria: handler real não faz fetch", () => purchaseFixture(async ({ submit, calls }) => { await submit(); assert.equal(calls.length, 0); }));
test("Compra expense sem subcategorias: categoryId válido e subcategoryId null", () => purchaseFixture(async ({ change, submit, calls }) => { change("purchase-category", "fixture-no-subs"); await submit(); assert.equal(calls.length, 1); assert.equal(calls[0].categoryId, "fixture-no-subs"); assert.equal(calls[0].subcategoryId, null); }));
test("Compra com subcategorias: nenhuma escolha produz zero fetch", () => purchaseFixture(async ({ change, submit, calls }) => { change("purchase-category", "fixture-with-subs"); await submit(); assert.equal(calls.length, 0); }));
test("Compra classificada envia ambos IDs; mudança de categoria limpa subcategoria", () => purchaseFixture(async ({ change, submit, calls, render }) => {
  change("purchase-category", "fixture-with-subs"); change("purchase-subcategory", "fixture-sub"); await submit(); assert.equal(calls[0].categoryId, "fixture-with-subs"); assert.equal(calls[0].subcategoryId, "fixture-sub");
  change("purchase-category", "fixture-no-subs"); change("purchase-category", "fixture-with-subs"); assert.equal(nodes(render()).find((node) => node.props.id === "purchase-subcategory" && node.type === "select").props.value, ""); await submit(); assert.equal(calls.length, 1);
}));
test("Compra não oferece income-only nem aceita ID incompatível", () => purchaseFixture(async ({ render, change, submit, calls }) => {
  const select = nodes(render()).find((node) => node.props.id === "purchase-category" && node.type === "select"); assert.equal(nodes(select).some((node) => node.props.value === "fixture-income"), false);
  change("purchase-category", "fixture-income"); await submit(); assert.equal(calls.length, 0);
}));

async function rootFixture(run) {
  const originalFetch = globalThis.fetch, originalDocument = globalThis.document;
  const main = { setupRequired: false, user: { name: "Usuário de teste" }, accounts, categories: [], transactions: [] };
  const planning = { cards: [], invoices: [], selectedMonth: "2026-09" };
  let mainRead = async () => main, advancedRead = async () => planning;
  let mainCalls = 0, advancedCalls = 0;
  globalThis.document = {};
  globalThis.fetch = async () => { mainCalls++; return Response.json(await mainRead()); };
  try {
    const h = hookHarness(async () => { advancedCalls++; return advancedRead(); }), store = h.store();
    const render = () => h.render(h.FinanceApp, {}, store);
    render(); await flush(); let tree = render();
    assert.equal(advancedCalls, 0, "dashboard preserves lazy loading");
    nodes(tree).find((node) => typeof node.props.onNavigate === "function").props.onNavigate("cards"); render(); await flush(); tree = render();
    const props = () => nodes(render()).find((node) => node.type === "AdvancedFinanceView").props;
    await run({ props, render, h, store, setReads: (a, b) => { mainRead = a; advancedRead = b; }, counts: () => ({ mainCalls, advancedCalls }) });
    h.unmount(store);
  } finally { globalThis.fetch = originalFetch; globalThis.document = originalDocument; }
}
test("FinanceApp real: refresh explícito completo retorna geração, aplica par e consumidor antigo permanece void", () => rootFixture(async ({ props, setReads, counts }) => {
  const before = counts(); setReads(async () => ({ setupRequired: false, user: { name: "Usuário de teste" }, accounts, categories: [] }), async () => ({ cards: [], invoices: [], selectedMonth: "2026-10" }));
  const result = await props().onFinancialRefresh(); assert.equal(result.success, true); assert.equal(result.generation, 1); assert.equal(props().data.selectedMonth, "2026-10");
  assert.equal(counts().mainCalls - before.mainCalls, 1); assert.equal(counts().advancedCalls - before.advancedCalls, 1);
  assert.equal(await props().onChanged(), undefined); assert.equal(props().financial.generation, 2);
}));
for (const failedLoader of ["main", "advanced"]) test(`FinanceApp real: falha parcial ${failedLoader} não gera sucesso/geração`, () => rootFixture(async ({ props, setReads }) => {
  const before = props().data; const fail = async () => { throw new Error("fixture loader failure"); }, ok = async () => ({});
  setReads(failedLoader === "main" ? fail : ok, failedLoader === "advanced" ? fail : ok);
  assert.equal((await props().onFinancialRefresh()).success, false); assert.equal(props().financial.generation, 0); assert.strictEqual(props().data, before);
  assert.equal(await props().onChanged(), undefined);
}));
test("FinanceApp real: refresh concorrente antigo não sobrescreve snapshot mais novo", () => rootFixture(async ({ props, setReads }) => {
  const slow = deferred(); setReads(() => slow.promise, async () => ({ cards: [], invoices: [], selectedMonth: "2026-08" }));
  const old = props().onFinancialRefresh();
  setReads(async () => ({ setupRequired: false, user: { name: "Usuário de teste" } }), async () => ({ cards: [], invoices: [], selectedMonth: "2026-10" }));
  assert.equal((await props().onFinancialRefresh()).success, true); slow.resolve({ setupRequired: false, user: { name: "Usuário de teste" } });
  assert.equal((await old).success, false); assert.equal(props().data.selectedMonth, "2026-10"); assert.equal(props().financial.generation, 1);
}));

test("FinanceApp real: refresh iniciado antes de POST não desbloqueia; posterior completo sim", () => rootFixture(async ({ props, setReads }) => {
  const f = props().financial, oldMain = deferred(); setReads(() => oldMain.promise, async () => ({ cards: [], invoices: [reopened] }));
  const old = props().onFinancialRefresh();
  const post = deferred(); const dialog = operationFixture(() => post.promise, f); dialog.confirm(); post.resolve({ outcome: "paid" }); await flush();
  oldMain.resolve({ setupRequired: false, user: { name: "Usuário de teste" }, accounts }); assert.equal((await old).success, false);
  assert.equal(f.generation, 0); assert.equal(f.isLocked(reopened.id), true);
  setReads(async () => ({ setupRequired: false, user: { name: "Usuário de teste" }, accounts }), async () => ({ cards: [], invoices: [invoice] }));
  assert.equal((await props().onFinancialRefresh()).success, true); assert.equal(f.isLocked(reopened.id), false); assert.equal(props().data.invoices[0].remainingCents, 0);
}));
test("refresh abortado não avança geração nem exibe AbortError", async () => {
  const f = financialFixture(); let errors = 0;
  const aborted = async () => { throw new DOMException("aborted", "AbortError"); };
  assert.equal((await f.refresh(aborted, async () => ({}), () => assert.fail("aborted apply"), () => errors++)).success, false);
  assert.equal(f.generation, 0); assert.equal(errors, 0);
});
test("lifecycle real: refresh falho mantém botão bloqueado e retry usa só um refresh compartilhado", async () => {
  const f = financialFixture(); f.start(reopened.id, { operationId: "fixture-operation" }); f.settle(reopened.id);
  const h = hookHarness(), store = h.store(); let calls = 0;
  const props = { invoice: reopened, accounts, financial: f, onChanged: async () => assert.fail("duplicate legacy refresh"), onFinancialRefresh: async () => { calls++; return f.refresh(async () => { if (calls === 1) throw new Error("fixture failure"); return {}; }, async () => ({}), () => {}, () => {}); } };
  let tree = h.render(h.InvoiceLifecycle, props, store); control(tree, "Atualizar dados").props.onClick(); await flush();
  tree = h.render(h.InvoiceLifecycle, props, store); assert.equal(control(tree, "Pagar restante").props.disabled, true); assert.equal(calls, 1);
  control(tree, "Atualizar dados").props.onClick(); await flush(); tree = h.render(h.InvoiceLifecycle, props, store);
  assert.equal(control(tree, "Pagar restante").props.disabled, false); assert.equal(calls, 2);
});
test("invalidação persiste ao trocar card/view e remontar invoice sem refresh válido", () => {
  const f = financialFixture(); f.start(reopened.id, { operationId: "fixture-operation" }); f.settle(reopened.id);
  const h = hookHarness(), first = h.store(); const props = { invoice: reopened, accounts, financial: f, onChanged: async () => {} };
  assert.equal(control(h.render(h.InvoiceLifecycle, props, first), "Pagar restante").props.disabled, true); h.unmount(first);
  const other = h.store(); assert.equal(control(h.render(h.InvoiceLifecycle, { ...props, invoice: { ...reopened, id: "fixture-other-invoice" } }, other), "Pagar restante").props.disabled, false); h.unmount(other);
  assert.equal(control(h.render(h.InvoiceLifecycle, { ...props, invoice: { ...reopened } }, h.store()), "Pagar restante").props.disabled, true);
});

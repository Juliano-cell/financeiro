import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

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
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);

const {
  ChatGptFinancialSummaryValidationError,
  composeChatGptFinancialSummary,
  getChatGptFinancialSummary,
  resolveChatGptSummaryPeriod,
} = await import("../lib/chatgpt-financial-summary-service.ts?summary-service-tests");
const { createExpectedIncome, receiveExpectedIncome, reverseExpectedIncomeReceipt } = await import("../lib/expected-income-service.ts?summary-service-tests");
const { configureCardCurrentState } = await import("../lib/card-onboarding-service.ts?summary-service-tests");
const { payInvoiceResidual, reverseInvoicePayment } = await import("../lib/invoice-service.ts?summary-service-tests");

const AT = "2026-10-08T15:00:00.000Z";
const NOW = new Date(AT);

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
  constructor(db) { this.db = db; this.sql = []; }
  prepare(sql) { this.sql.push(sql); return new Statement(this.db, sql); }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.all())); }
}

function database(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  t.after(() => {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
  });
  return db;
}

function seedHousehold(db, suffix, initialBalance) {
  const value = { user: `user-${suffix}`, household: `house-${suffix}`, account: `account-${suffix}`, expense: `expense-${suffix}`, income: `income-${suffix}` };
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(value.user, `User ${suffix}`, `${suffix}@private.invalid`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(value.household, `House ${suffix}`, value.user, "2026-01-01T00:00:00.000Z", AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, value.household, value.user, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(value.account, value.household, `Conta ${suffix}`, "bank", initialBalance, 1, AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(value.expense, value.household, `Despesa ${suffix}`, "expense", "#397f72", AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(value.income, value.household, `Receita ${suffix}`, "income", "#397f72", AT, AT);
  return value;
}

function fixture(t) {
  const db = database(t);
  const a = seedHousehold(db, "a", 100_000);
  const b = seedHousehold(db, "b", 9_000_000);
  const d1 = new LocalD1(db);
  runtime.DB = d1;
  return { db, d1, a, b, context: { d1, householdId: a.household, userId: a.user, householdCreatedAt: "2026-01-01T00:00:00.000Z", now: NOW } };
}

function transaction(db, owner, values) {
  db.prepare(`INSERT INTO transactions(
    id,household_id,type,amount_cents,description,category_id,transaction_date,responsible_user_id,
    account_id,payment_method,status,origin,notes,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.id, owner.household, values.type, values.amount, values.description,
    values.category ?? (values.type === "income" ? owner.income : owner.expense), values.date, owner.user,
    owner.account, values.method ?? "cash", "confirmed", "dashboard", values.notes ?? null, AT, AT,
  );
}

function expectedContext(f) {
  return { d1: f.d1, householdId: f.a.household, userId: f.a.user, timestamp: AT };
}

async function expected(f, suffix, date, amount = 20_000) {
  return createExpectedIncome({
    operationId: `create-${suffix}`, description: `Receita ${suffix}`, expectedAmountCents: amount,
    expectedDate: date, plannedAccountId: f.a.account, categoryId: null, subcategoryId: null, notes: null,
  }, expectedContext(f));
}

async function seedSummaryData(f) {
  transaction(f.db, f.a, { id: "income-realized", type: "income", amount: 50_000, description: "Salário", date: "2026-10-02" });
  transaction(f.db, f.a, { id: "expense-realized", type: "expense", amount: 10_000, description: "Mercado", date: "2026-10-03" });
  transaction(f.db, f.a, { id: "future-income", type: "income", amount: 30_000, description: "Entrada futura", date: "2026-10-20" });
  transaction(f.db, f.b, { id: "private-income", type: "income", amount: 8_000_000, description: "Segredo B", date: "2026-10-02" });

  transaction(f.db, f.a, { id: "bill-payment", type: "expense", amount: 9_500, description: "Conta paga", date: "2026-10-05" });
  f.db.prepare(`INSERT INTO bills(
    id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,status,
    paid_at,payment_transaction_id,created_by_user_id,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "bill-paid", f.a.household, "Conta com desconto", 10_000, f.a.expense, "2026-10-05", f.a.account,
    "none", "paid", AT, "bill-payment", f.a.user, "web", AT, AT,
  );
  for (const [id, description, amount, date] of [
    ["bill-overdue", "Conta atrasada", 7_000, "2026-09-30"],
    ["bill-pending", "Conta pendente", 8_000, "2026-10-25"],
  ]) {
    f.db.prepare(`INSERT INTO bills(
      id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,status,
      created_by_user_id,origin,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, f.a.household, description, amount, f.a.expense, date, null, "none", "pending", f.a.user, "web", AT, AT,
    );
  }
  f.db.prepare(`INSERT INTO recurring_bill_series(
    id,household_id,description,amount_cents,category_id,account_id,day_of_month,starts_on,
    is_active,created_by_user_id,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "recurring-series", f.a.household, "Internet", 6_000, f.a.expense, f.a.account, 31, "2026-10-31", 1, f.a.user, "web", AT, AT,
  );
  f.db.prepare(`INSERT INTO bills(
    id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,
    recurrence_series_id,status,created_by_user_id,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "bill-recurring", f.a.household, "Internet", 6_000, f.a.expense, "2026-10-31", f.a.account,
    "monthly", "recurring-series", "pending", f.a.user, "web", AT, AT,
  );
  f.db.prepare(`INSERT INTO bill_installment_series(
    id,household_id,description,total_amount_cents,installment_count,first_due_date,configured_day,
    category_id,account_id,idempotency_key,request_fingerprint,created_by_user_id,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "installment-series", f.a.household, "Curso", 30_000, 3, "2026-10-29", 29,
    f.a.expense, f.a.account, "installment-key", "a".repeat(64), f.a.user, "web", AT, AT,
  );
  f.db.prepare(`INSERT INTO bills(
    id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,status,
    created_by_user_id,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "bill-installment", f.a.household, "Curso", 10_000, f.a.expense, "2026-10-29", f.a.account,
    "none", "pending", f.a.user, "web", AT, AT,
  );
  f.db.prepare("INSERT INTO bill_installment_occurrences(household_id,series_id,bill_id,installment_number,created_at) VALUES(?,?,?,?,?)")
    .run(f.a.household, "installment-series", "bill-installment", 1, AT);

  await expected(f, "pending", "2026-10-22", 20_000);
  await expected(f, "overdue", "2026-09-29", 11_000);
  const received = await expected(f, "received", "2026-10-02", 20_000);
  await receiveExpectedIncome({
    operationId: "receive-received", occurrenceId: received.occurrenceId, receivedAmountCents: 22_000,
    receivedDate: "2026-10-04", actualAccountId: f.a.account,
  }, expectedContext(f));
  const reversed = await expected(f, "reversed", "2026-10-06", 15_000);
  await receiveExpectedIncome({
    operationId: "receive-reversed", occurrenceId: reversed.occurrenceId, receivedAmountCents: 15_000,
    receivedDate: "2026-10-06", actualAccountId: f.a.account,
  }, expectedContext(f));
  await reverseExpectedIncomeReceipt({
    operationId: "reverse-reversed", occurrenceId: reversed.occurrenceId, reversalDate: "2026-10-07",
  }, expectedContext(f));

  f.db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("card-a", f.a.household, "Cartão A", "Banco A", "Titular", 500_000, 31, 10, AT, AT);
  for (const [id, month, due, closes] of [
    ["invoice-oct", "2026-10", "2026-10-10", "2026-09-30"],
    ["invoice-nov", "2026-11", "2026-11-10", "2026-10-31"],
  ]) {
    f.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, f.a.household, "card-a", month, due, closes, "open", AT, AT);
  }
  for (const item of [
    { purchase: "purchase-oct", installment: "installment-oct", invoice: "invoice-oct", description: "Compra atual", amount: 30_000, date: "2026-09-15", status: "active", installmentStatus: "pending" },
    { purchase: "purchase-nov", installment: "installment-nov", invoice: "invoice-nov", description: "Compra futura", amount: 10_000, date: "2026-10-02", status: "active", installmentStatus: "pending" },
    { purchase: "purchase-cancelled", installment: "installment-cancelled", invoice: "invoice-oct", description: "Compra cancelada", amount: 99_000, date: "2026-09-20", status: "cancelled", installmentStatus: "cancelled" },
  ]) {
    f.db.prepare(`INSERT INTO card_purchases(
      id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,
      status,created_by_user_id,origin,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      item.purchase, f.a.household, "card-a", item.description, item.amount, item.date, 1, f.a.expense,
      item.status, f.a.user, "web", AT, AT,
    );
    f.db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(item.installment, f.a.household, item.purchase, item.invoice, 1, 1, item.amount, item.installmentStatus, AT, AT);
  }
  f.db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("invoice-payment", f.a.household, "invoice-oct", f.a.account, 5_000, "2026-10-07", f.a.user, AT);
}

test("período usa uma data de corte de São Paulo, aceita mês atual até +23 e cobre viradas civis", () => {
  assert.deepEqual(resolveChatGptSummaryPeriod(new Date("2028-03-01T02:30:00.000Z")), {
    month: "2028-02", currentMonth: "2028-02", advance: 0, asOfDate: "2028-02-29",
    generatedAt: "2028-03-01T02:30:00.000Z", from: "2028-02-01", to: "2028-02-29",
    maximumMonth: "2030-01",
  });
  assert.equal(resolveChatGptSummaryPeriod(new Date("2026-12-31T15:00:00.000Z"), "2028-11").advance, 23);
  assert.throws(() => resolveChatGptSummaryPeriod(NOW, "2026-09"), ChatGptFinancialSummaryValidationError);
  assert.throws(() => resolveChatGptSummaryPeriod(NOW, "2028-10"), ChatGptFinancialSummaryValidationError);
  assert.throws(() => resolveChatGptSummaryPeriod(NOW, "2026-13"), ChatGptFinancialSummaryValidationError);
});

test("serviço compõe autoridades canônicas, isola household e não realiza escrita", async t => {
  const f = fixture(t);
  await seedSummaryData(f);
  f.d1.sql = [];
  const before = f.db.prepare("SELECT total_changes() AS value").get().value;
  const dto = await composeChatGptFinancialSummary(f.context, "2026-10");
  const after = f.db.prepare("SELECT total_changes() AS value").get().value;
  assert.equal(after, before);
  assert.ok(f.d1.sql.every((sql) => /^\s*(?:SELECT|WITH|PRAGMA)/iu.test(sql)));
  assert.equal(dto.period.generatedAt, AT);
  assert.equal(dto.period.asOfDate, "2026-10-08");
  assert.equal(dto.balances.totalAvailableCents, 147_500);
  assert.deepEqual(dto.balances.accounts.map((account) => account.name), ["Conta a"]);
  assert.ok(dto.realized.items.some((item) => item.description === "Salário"));
  assert.ok(dto.realized.items.some((item) => item.description === "Compra atual"));
  assert.ok(dto.realized.items.every((item) => !("responsibleName" in item)));
  assert.doesNotMatch(JSON.stringify(dto), /Segredo B|private-income|house-b|user-b|9000000/u);
});

test("contas e receitas preservam competência, caixa, atraso, recorrência, parcelas, desconto e estorno", async t => {
  const f = fixture(t);
  await seedSummaryData(f);
  const dto = await composeChatGptFinancialSummary(f.context, "2026-10");
  assert.equal(dto.bills.overdueCents, 7_000);
  assert.equal(dto.bills.pendingCents, 24_000);
  assert.equal(dto.bills.paidScheduledCents, 10_000);
  assert.equal(dto.bills.paidActualCents, 9_500);
  const paid = dto.bills.items.find((item) => item.description === "Conta com desconto");
  assert.deepEqual(paid.paymentAdjustment, { type: "discount", amountCents: -500 });
  assert.equal(dto.bills.items.find((item) => item.description === "Internet").recurrence.configuredDay, 31);
  assert.deepEqual(dto.bills.items.find((item) => item.description === "Curso").installment, { number: 1, count: 3, originalTotalCents: 30_000 });
  assert.equal(dto.expectedIncome.pendingCents, 20_000);
  assert.equal(dto.expectedIncome.overdueCents, 26_000);
  assert.equal(dto.expectedIncome.receivedCents, 22_000);
  assert.equal(dto.expectedIncome.items.find((item) => item.description === "Receita reversed").status, "pending");
  assert.equal(dto.expectedIncome.items.find((item) => item.description === "Receita received").receivedAmountCents, 22_000);
  assert.equal(dto.realized.incomeCents, 102_000);
});

test("faturas usam ledger/detalhe canônicos, excluem canceladas e preservam próxima fatura", async t => {
  const f = fixture(t);
  await seedSummaryData(f);
  const dto = await composeChatGptFinancialSummary(f.context, "2026-10");
  assert.equal(dto.cards.length, 1);
  const [card] = dto.cards;
  assert.equal(card.closingDay, 31);
  assert.equal(card.dueDay, 10);
  assert.deepEqual(card.invoices.map((invoice) => invoice.referenceMonth), ["2026-10", "2026-11"]);
  assert.deepEqual(card.invoices[0].purchases.map((purchase) => purchase.description), ["Compra atual"]);
  assert.equal(card.invoices[0].invoiceTotalCents, 30_000);
  assert.equal(card.invoices[0].paidCents, 5_000);
  assert.equal(card.invoices[0].remainingCents, 25_000);
  assert.equal(card.invoices[0].paymentStatus, "partial");
  assert.equal(card.invoices[1].purchases[0].description, "Compra futura");
  assert.doesNotMatch(JSON.stringify(card), /Compra cancelada/u);
});

test("opening balance e allocations usam o breakdown canônico sem virar compra ou saldo disponível", async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("card-opening", f.a.household, "Cartão Opening", "Banco A", "Titular", 500_000, 31, 10, AT, AT);
  await configureCardCurrentState({
    cardId: "card-opening",
    initialReferenceMonth: "2026-10",
    declaredCurrentInvoiceTotalCents: 10_000,
    expectedCardUpdatedAt: AT,
    expectedClosesOn: "2026-09-30",
    expectedDueOn: "2026-10-10",
    closedCycleConfirmed: true,
    idempotencyKey: "summary-opening",
    commitments: [{
      description: "Compra antiga",
      installmentAmountCents: 6_000,
      firstOriginalInstallmentNumber: 5,
      originalInstallmentCount: 10,
      originalTotalCents: 60_000,
      categoryId: f.a.expense,
    }],
  }, expectedContext(f));
  const dto = await composeChatGptFinancialSummary(f.context, "2026-10");
  const invoice = dto.cards.find((card) => card.name === "Cartão Opening").invoices[0];
  assert.deepEqual(invoice.openingBalance, {
    originalCents: 10_000,
    openingCents: 4_000,
    initialStateInstallmentsCents: 6_000,
    allocatedCents: 0,
    residualCents: 4_000,
    identifiedCents: 6_000,
  });
  assert.equal(invoice.invoiceTotalCents, 10_000);
  assert.equal(invoice.purchases.length, 1);
  assert.equal(dto.balances.totalAvailableCents, 100_000);
});

test("fatura quitada e estornada reflete o ledger atual sem duplicar despesa de cartão", async t => {
  const f = fixture(t);
  await seedSummaryData(f);
  const paid = await payInvoiceResidual({
    invoiceId: "invoice-oct",
    accountId: f.a.account,
    paidAt: "2026-10-08",
    idempotencyKey: "summary-pay",
    expectedRemainingCents: 25_000,
  }, expectedContext(f));
  const settled = await composeChatGptFinancialSummary(f.context, "2026-10");
  const settledInvoice = settled.cards[0].invoices.find((invoice) => invoice.referenceMonth === "2026-10");
  assert.equal(settledInvoice.paymentStatus, "settled");
  assert.equal(settledInvoice.remainingCents, 0);
  assert.equal(settled.realized.expenseCents, 49_500);
  await reverseInvoicePayment({
    paymentId: paid.paymentId,
    reversedAt: "2026-10-08",
    idempotencyKey: "summary-reverse",
  }, expectedContext(f));
  const reversed = await composeChatGptFinancialSummary(f.context, "2026-10");
  const reversedInvoice = reversed.cards[0].invoices.find((invoice) => invoice.referenceMonth === "2026-10");
  assert.equal(reversedInvoice.paymentStatus, "partial");
  assert.equal(reversedInvoice.remainingCents, 25_000);
  assert.equal(reversed.realized.expenseCents, 49_500);
});

test("forecast mantém identidades separadas, aloca overdue uma vez e expõe warnings sem IDs", async t => {
  const f = fixture(t);
  await seedSummaryData(f);
  const dto = await composeChatGptFinancialSummary(f.context, "2026-10");
  assert.equal(dto.projection.month, "2026-10");
  assert.equal(dto.projection.overdueExpectedIncomeCents, 26_000);
  assert.equal(dto.projection.overdueBillsCents, 7_000);
  assert.equal(dto.projection.cardInvoiceRemainingCents, 25_000);
  assert.ok(dto.commitments.some((item) => item.source === "expected_income"));
  assert.ok(dto.commitments.some((item) => item.source === "bill_installment"));
  assert.ok(dto.commitments.some((item) => item.source === "recurring_bill"));
  assert.ok(dto.commitments.some((item) => item.source === "card_invoice"));
  assert.ok(dto.warnings.some((warning) => warning.code === "UNREGISTERED_INCOME_NOT_INCLUDED"));
  assert.ok(dto.warnings.every((warning) => Object.keys(warning).sort().join(",") === "code,message"));
});

test("resposta final é allowlist, determinística e não expõe IDs, notas, membros ou payloads", async t => {
  const f = fixture(t);
  await seedSummaryData(f);
  const first = await getChatGptFinancialSummary(f.context, "2026-10");
  const second = await getChatGptFinancialSummary(f.context, "2026-10");
  assert.deepEqual(Object.keys(first).sort(), ["asOfDate", "generatedAt", "month", "summaryText", "warnings"]);
  assert.equal(first.summaryText, second.summaryText);
  assert.doesNotMatch(JSON.stringify(first), /user-a|house-a|member-a|invoice-oct|purchase-oct|installment-oct|@private\.invalid|idempotency|fingerprint|notes/iu);
  assert.match(first.summaryText, /RESUMO FINANCEIRO PARA PLANEJAMENTO/u);
});

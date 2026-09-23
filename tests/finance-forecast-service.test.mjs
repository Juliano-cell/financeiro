import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  FORECAST_DEFAULT_MONTHS,
  FORECAST_MAX_MONTHS,
  getFinanceForecast,
  resolveForecastWindow,
} from "../lib/finance-forecast-service.ts";

const AT = "2026-09-15T15:00:00.000Z";
const NOW = new Date(AT);

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async run() { const result = this.db.prepare(this.sql).run(...this.bindings); return { success: true, results: [], meta: { changes: result.changes } }; }
}

class LocalD1 {
  constructor(db) { this.db = db; this.batchCount = 0; this.statements = []; }
  prepare(sql) { this.statements.push(sql); return new Statement(this.db, sql); }
  async batch(statements) {
    this.batchCount += 1;
    return Promise.all(statements.map((statement) => statement.all()));
  }
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

function seedHousehold(db, suffix, initialBalance = 0) {
  const value = { user: `user-${suffix}`, household: `house-${suffix}`, account: `account-${suffix}`, category: `category-${suffix}` };
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(value.user, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(value.household, `House ${suffix}`, value.user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, value.household, value.user, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(value.account, value.household, `Account ${suffix}`, "bank", initialBalance, 1, AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(value.category, value.household, `Category ${suffix}`, "expense", "#397f72", AT, AT);
  return value;
}

function fixture(t, initialBalance = 0) {
  const db = database(t);
  const a = seedHousehold(db, "a", initialBalance);
  const b = seedHousehold(db, "b", 9_999_999);
  const d1 = new LocalD1(db);
  return { db, d1, a, b };
}

function forecast(f, months = FORECAST_DEFAULT_MONTHS, householdId = f.a.household, now = NOW) {
  return getFinanceForecast({ d1: f.d1, householdId, now }, months);
}

function transaction(db, owner, values) {
  db.prepare(`INSERT INTO transactions(
    id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,
    account_id,status,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.id, owner.household, values.type, values.amount, values.description ?? values.id,
    values.date, owner.user, values.account ?? owner.account, values.status ?? "confirmed", "dashboard", AT, AT,
  );
}

function bill(db, owner, values) {
  db.prepare(`INSERT INTO bills(
    id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,
    recurrence_series_id,recurrence_end_date,status,paid_at,payment_transaction_id,
    created_by_user_id,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.id, owner.household, values.description ?? values.id, values.amount, owner.category,
    values.date, values.account === undefined ? owner.account : values.account, values.recurrence ?? "none",
    values.recurrenceSeriesId ?? null, values.recurrenceEndDate ?? null, values.status ?? "pending",
    values.paidAt ?? null, values.paymentTransactionId ?? null, owner.user, "web", AT, AT,
  );
}

function card(db, owner, suffix = "a") {
  const cardId = `card-${suffix}`;
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(cardId, owner.household, `Card ${suffix}`, "Bank", "Holder", 1_000_000, 5, 10, AT, AT);
  return cardId;
}

function invoice(db, owner, values) {
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(values.id, owner.household, values.cardId, values.month, values.date, values.closesOn ?? `${values.month}-05`, values.status ?? "open", AT, AT);
}

function purchaseInstallment(db, owner, values) {
  const purchaseId = values.purchaseId ?? `purchase-${values.installmentId}`;
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(purchaseId, owner.household, values.cardId, values.description ?? purchaseId, values.amount, "2026-09-01", values.count ?? 1, owner.category, values.purchaseStatus ?? "active", owner.user, "web", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(values.installmentId, owner.household, purchaseId, values.invoiceId, values.number ?? 1, values.count ?? 1, values.amount, values.status ?? "pending", AT, AT);
  return purchaseId;
}

function payment(db, owner, values) {
  db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(values.id, owner.household, values.invoiceId, owner.account, values.amount, values.date ?? "2026-09-15", owner.user, AT);
}

function reversal(db, owner, values) {
  db.prepare(`INSERT INTO invoice_payment_operations(
    id,household_id,idempotency_key,kind,invoice_id,account_id,created_by_user_id,
    amount_cents,occurred_on,reversed_payment_id,request_fingerprint,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.id, owner.household, `${values.id}-key`, "reversal", values.invoiceId, owner.account,
    owner.user, values.amount, values.date ?? "2026-09-15", values.paymentId, `${values.id}-fingerprint`, AT,
  );
}

test("mês vazio conserva saldo atual e retorna somente a limitação explícita de receitas", async t => {
  const f = fixture(t, 200_000);
  const value = await forecast(f);
  assert.equal(value.currentBalanceCents, 200_000);
  assert.equal(value.projectedEndingBalanceCents, 200_000);
  assert.equal(value.months.length, 6);
  assert.ok(value.months.every((month) => month.projectedNetCashFlowCents === 0));
  assert.deepEqual(value.warnings.map((warning) => warning.code), ["UNREGISTERED_INCOME_NOT_INCLUDED"]);
  assert.equal(value.basis, "known_cash_only");
});

test("oracle A encadeia saldo 2.000 + entrada 3.000 - bill 1.500 - fatura 800 = 2.700", async t => {
  const f = fixture(t, 200_000);
  transaction(f.db, f.a, { id: "future-income", type: "income", amount: 300_000, date: "2026-10-01" });
  bill(f.db, f.a, { id: "future-bill", amount: 150_000, date: "2026-10-20" });
  const cardId = card(f.db, f.a);
  invoice(f.db, f.a, { id: "invoice-oct", cardId, month: "2026-10", date: "2026-10-10" });
  purchaseInstallment(f.db, f.a, { cardId, invoiceId: "invoice-oct", installmentId: "part-500", amount: 50_000 });
  purchaseInstallment(f.db, f.a, { cardId, invoiceId: "invoice-oct", installmentId: "part-300", amount: 30_000 });
  const value = await forecast(f);
  assert.equal(value.knownFutureIncomeCents, 300_000);
  assert.equal(value.knownFutureOutflowCents, 230_000);
  assert.equal(value.projectedEndingBalanceCents, 270_000);
  assert.equal(value.months[1].closingBalanceCents, 270_000);
  assert.deepEqual(value.months[1].details.cardInvoices.map((item) => item.amountCents), [80_000]);
  assert.ok(!JSON.stringify(value).includes("part-500"));
  assert.ok(!JSON.stringify(value).includes("part-300"));
});

test("transactions incluem somente confirmadas, futuras, da conta ativa e do household consultado", async t => {
  const f = fixture(t, 1_000);
  transaction(f.db, f.a, { id: "past", type: "income", amount: 100, date: "2026-09-15" });
  transaction(f.db, f.a, { id: "future-income", type: "income", amount: 200, date: "2026-09-16" });
  transaction(f.db, f.a, { id: "future-expense", type: "expense", amount: 300, date: "2026-10-01" });
  transaction(f.db, f.a, { id: "pending", type: "income", amount: 400, date: "2026-09-16", status: "pending" });
  transaction(f.db, f.a, { id: "cancelled", type: "expense", amount: 500, date: "2026-09-16", status: "cancelled" });
  f.db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("inactive-a", f.a.household, "Inactive", "bank", 900, 0, AT, AT);
  transaction(f.db, f.a, { id: "inactive-future", type: "income", amount: 600, date: "2026-09-16", account: "inactive-a" });
  transaction(f.db, f.b, { id: "private", type: "income", amount: 999_999, date: "2026-09-16" });
  const value = await forecast(f);
  assert.equal(value.currentBalanceCents, 1_100);
  assert.equal(value.knownFutureIncomeCents, 200);
  assert.equal(value.knownFutureOutflowCents, 300);
  assert.deepEqual(value.months.flatMap((month) => month.details.futureTransactions).map((item) => item.id), ["future-income", "future-expense"]);
  assert.doesNotMatch(JSON.stringify(value), /private|inactive-future|pending|cancelled/u);
});

test("bills pending entram, paid/cancelled saem e Definir ao pagar permanece no agregado", async t => {
  const f = fixture(t);
  bill(f.db, f.a, { id: "pending", amount: 100, date: "2026-09-20", account: null });
  bill(f.db, f.a, { id: "paid", amount: 200, date: "2026-09-21", status: "paid" });
  bill(f.db, f.a, { id: "cancelled", amount: 300, date: "2026-09-22", status: "cancelled" });
  const value = await forecast(f);
  assert.equal(value.knownFutureOutflowCents, 100);
  assert.deepEqual(value.months[0].details.dueBills.map((item) => item.id), ["pending"]);
});

test("oracle B aloca bill atrasada apenas no primeiro mês e preserva vencimento original", async t => {
  const f = fixture(t, 100_000);
  bill(f.db, f.a, { id: "overdue", amount: 40_000, date: "2026-08-20" });
  const value = await forecast(f, 3);
  assert.equal(value.months[0].overdueBillsCents, 40_000);
  assert.equal(value.months[0].closingBalanceCents, 60_000);
  assert.equal(value.months[1].overdueBillsCents, 0);
  assert.equal(value.months[1].openingBalanceCents, 60_000);
  assert.equal(value.months[2].closingBalanceCents, 60_000);
  assert.deepEqual(value.months[0].details.overdueBills[0], {
    id: "overdue", source: "bill", direction: "outflow", description: "overdue", amountCents: 40_000,
    originalDate: "2026-08-20", allocationMonth: "2026-09", status: "pending", qualification: "registered",
    overdue: true, installment: null, recurrenceSeriesId: null,
  });
});

test("oracle D usa somente parcelas-bill pending e nunca soma o total original da série", async t => {
  const f = fixture(t, 100_000);
  f.db.prepare(`INSERT INTO bill_installment_series(
    id,household_id,description,total_amount_cents,installment_count,first_due_date,configured_day,
    category_id,account_id,idempotency_key,request_fingerprint,created_by_user_id,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "series", f.a.household, "Parcelado", 10_000, 3, "2026-09-20", 20, f.a.category, f.a.account,
    "series-key", "a".repeat(64), f.a.user, "web", AT, AT,
  );
  const parts = [
    ["part-1", 3_333, "2026-09-20", "paid"],
    ["part-2", 3_333, "2026-10-20", "pending"],
    ["part-3", 3_334, "2026-11-20", "pending"],
  ];
  for (let index = 0; index < parts.length; index += 1) {
    const [id, amount, date, status] = parts[index];
    bill(f.db, f.a, { id, amount, date, status });
    f.db.prepare("INSERT INTO bill_installment_occurrences(household_id,series_id,bill_id,installment_number,created_at) VALUES(?,?,?,?,?)")
      .run(f.a.household, "series", id, index + 1, AT);
  }
  const value = await forecast(f);
  assert.equal(value.knownFutureOutflowCents, 6_667);
  assert.equal(value.months[1].dueBillsCents, 3_333);
  assert.equal(value.months[2].dueBillsCents, 3_334);
  assert.deepEqual(value.months[1].details.dueBills[0].installment, { seriesId: "series", number: 2, count: 3 });
  assert.equal("originalTotalCents" in value.months[1].details.dueBills[0], false);
});

test("recorrência usa somente ocorrência materializada e avisa quando a cobertura termina antes do horizonte", async t => {
  const f = fixture(t);
  f.db.prepare(`INSERT INTO recurring_bill_series(
    id,household_id,description,amount_cents,category_id,account_id,day_of_month,starts_on,ends_on,
    is_active,created_by_user_id,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "rent-series", f.a.household, "Aluguel", 50_000, f.a.category, f.a.account, 10, "2026-09-10", null,
    1, f.a.user, "web", AT, AT,
  );
  bill(f.db, f.a, { id: "rent-oct", description: "Aluguel", amount: 50_000, date: "2026-10-10", recurrence: "monthly", recurrenceSeriesId: "rent-series" });
  const value = await forecast(f, 3);
  assert.equal(value.knownFutureOutflowCents, 50_000);
  assert.equal(value.months[1].details.dueBills[0].qualification, "materialized_recurring");
  assert.deepEqual(value.warnings.map((warning) => warning.code), ["UNREGISTERED_INCOME_NOT_INCLUDED", "RECURRENCE_COVERAGE_LIMITED"]);
  assert.equal(value.warnings[1].seriesId, "rent-series");
});

test("recorrência totalmente materializada não produz alerta de cobertura", async t => {
  const f = fixture(t);
  f.db.prepare(`INSERT INTO recurring_bill_series(
    id,household_id,description,amount_cents,category_id,day_of_month,starts_on,ends_on,is_active,
    created_by_user_id,origin,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "short-series", f.a.household, "Curso", 1_000, f.a.category, 10, "2026-09-10", "2026-10-10", 1,
    f.a.user, "web", AT, AT,
  );
  bill(f.db, f.a, { id: "course-oct", amount: 1_000, date: "2026-10-10", recurrence: "monthly", recurrenceSeriesId: "short-series", recurrenceEndDate: "2026-10-10" });
  const value = await forecast(f, 6);
  assert.equal(value.warnings.some((warning) => warning.code === "RECURRENCE_COVERAGE_LIMITED"), false);
});

test("oracle C usa somente fatura restante para compras de 500 + 300", async t => {
  const f = fixture(t);
  const cardId = card(f.db, f.a);
  invoice(f.db, f.a, { id: "invoice", cardId, month: "2026-10", date: "2026-10-10" });
  purchaseInstallment(f.db, f.a, { cardId, invoiceId: "invoice", installmentId: "part-a", amount: 50_000 });
  purchaseInstallment(f.db, f.a, { cardId, invoiceId: "invoice", installmentId: "part-b", amount: 30_000 });
  const value = await forecast(f);
  assert.equal(value.knownFutureOutflowCents, 80_000);
  assert.equal(value.months[1].cardInvoiceRemainingCents, 80_000);
  assert.equal(value.months[1].details.cardInvoices.length, 1);
});

test("faturas abertas e fechadas entram pelo restante; paga sai e parcial usa somente residual", async t => {
  const f = fixture(t);
  const cardId = card(f.db, f.a);
  for (const [id, month, status, total, paid] of [
    ["open", "2026-09", "open", 1_000, 0],
    ["closed", "2026-10", "closed", 2_000, 0],
    ["paid", "2026-11", "paid", 3_000, 3_000],
    ["partial", "2026-12", "open", 4_000, 1_500],
  ]) {
    invoice(f.db, f.a, { id, cardId, month, date: `${month}-20`, status });
    purchaseInstallment(f.db, f.a, { cardId, invoiceId: id, installmentId: `part-${id}`, amount: total });
    if (paid) payment(f.db, f.a, { id: `payment-${id}`, invoiceId: id, amount: paid });
  }
  const value = await forecast(f);
  assert.equal(value.knownFutureOutflowCents, 5_500);
  assert.deepEqual(value.months.flatMap((month) => month.details.cardInvoices).map((item) => [item.id, item.amountCents, item.status]), [
    ["open", 1_000, "unpaid"], ["closed", 2_000, "unpaid"], ["partial", 2_500, "partial"],
  ]);
});

test("opening balance e allocation compõem a fatura exatamente uma vez", async t => {
  const f = fixture(t);
  const cardId = card(f.db, f.a);
  invoice(f.db, f.a, { id: "invoice", cardId, month: "2026-10", date: "2026-10-10" });
  f.db.prepare(`INSERT INTO card_import_batches(
    id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,import_kind,
    initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,
    imported_installment_count,status,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "initial-batch", f.a.household, cardId, f.a.user, "initial-key", "initial-fingerprint", "initial_state", "2026-10",
    500, 500, 0, 0, "pending", AT,
  );
  f.db.prepare("INSERT INTO card_invoice_adjustments(id,household_id,invoice_id,import_batch_id,kind,amount_cents,status,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("opening", f.a.household, "invoice", "initial-batch", "opening_balance", 500, "active", f.a.user, AT);
  f.db.prepare("UPDATE card_import_batches SET status='completed', completed_at=? WHERE id='initial-batch'").run(AT);
  purchaseInstallment(f.db, f.a, { cardId, invoiceId: "invoice", installmentId: "ordinary-part", amount: 300 });
  f.db.prepare(`INSERT INTO card_import_batches(
    id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,import_kind,
    initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,
    imported_installment_count,status,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "source-batch", f.a.household, cardId, f.a.user, "source-key", "source-fingerprint", "existing_installments", "2026-10",
    800, 0, 1, 1, "pending", AT,
  );
  const purchaseId = purchaseInstallment(f.db, f.a, {
    cardId, invoiceId: "invoice", installmentId: "allocated-part", purchaseId: "allocated-purchase",
    amount: 200, purchaseStatus: "active",
  });
  f.db.prepare("UPDATE card_purchases SET origin='system' WHERE id=?").run(purchaseId);
  f.db.prepare(`INSERT INTO card_purchase_import_metadata(
    id,household_id,purchase_id,import_batch_id,first_original_installment_number,original_installment_count,
    original_total_cents,original_purchase_date,imported_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    "metadata", f.a.household, purchaseId, "source-batch", 1, 1, 200, "2026-09-01", AT,
  );
  f.db.prepare(`INSERT INTO card_opening_balance_allocations(
    id,household_id,opening_adjustment_id,initial_import_batch_id,source_import_batch_id,invoice_id,
    purchase_id,installment_id,amount_cents,created_by_user_id,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    "allocation", f.a.household, "opening", "initial-batch", "source-batch", "invoice", purchaseId, "allocated-part", 200, f.a.user, AT,
  );
  f.db.prepare("UPDATE card_import_batches SET status='completed', completed_at=? WHERE id='source-batch'").run(AT);
  const value = await forecast(f);
  assert.equal(value.knownFutureOutflowCents, 800);
  assert.equal(value.months[1].details.cardInvoices[0].amountCents, 800);
});

test("estorno de pagamento restaura o saldo restante integral da fatura", async t => {
  const f = fixture(t);
  const cardId = card(f.db, f.a);
  invoice(f.db, f.a, { id: "invoice", cardId, month: "2026-10", date: "2026-10-10" });
  purchaseInstallment(f.db, f.a, { cardId, invoiceId: "invoice", installmentId: "part", amount: 1_000 });
  payment(f.db, f.a, { id: "payment", invoiceId: "invoice", amount: 1_000 });
  reversal(f.db, f.a, { id: "reversal", invoiceId: "invoice", paymentId: "payment", amount: 1_000 });
  const value = await forecast(f);
  assert.equal(value.knownFutureOutflowCents, 1_000);
  assert.equal(value.months[1].details.cardInvoices[0].status, "unpaid");
});

test("bills pagas com desconto/acréscimo não permanecem previstas; estorno devolve o valor planejado", async t => {
  const f = fixture(t, 10_000);
  transaction(f.db, f.a, { id: "payment-discount", type: "expense", amount: 380, date: "2026-09-13" });
  transaction(f.db, f.a, { id: "payment-surcharge", type: "expense", amount: 420, date: "2026-09-14" });
  bill(f.db, f.a, { id: "bill-discount", amount: 400, date: "2026-08-09", status: "paid", paidAt: "2026-09-13", paymentTransactionId: "payment-discount" });
  bill(f.db, f.a, { id: "bill-surcharge", amount: 400, date: "2026-08-10", status: "paid", paidAt: "2026-09-14", paymentTransactionId: "payment-surcharge" });
  let value = await forecast(f);
  assert.equal(value.currentBalanceCents, 9_200);
  assert.equal(value.knownFutureOutflowCents, 0);
  f.db.prepare("UPDATE bills SET status='pending', paid_at=NULL, payment_transaction_id=NULL WHERE id='bill-surcharge'").run();
  f.db.prepare("DELETE FROM transactions WHERE id='payment-surcharge'").run();
  value = await forecast(f);
  assert.equal(value.currentBalanceCents, 9_620);
  assert.equal(value.months[0].overdueBillsCents, 400);
});

test("encadeamento cruza ano, admite saldo negativo e preserva fevereiro civil", async t => {
  const f = fixture(t, 100);
  bill(f.db, f.a, { id: "dec", amount: 150, date: "2026-12-20" });
  transaction(f.db, f.a, { id: "jan-income", type: "income", amount: 25, date: "2027-01-10" });
  const value = await forecast(f, 4, f.a.household, new Date("2026-11-15T15:00:00.000Z"));
  assert.deepEqual(value.months.map((month) => month.month), ["2026-11", "2026-12", "2027-01", "2027-02"]);
  assert.equal(value.months[1].closingBalanceCents, -50);
  assert.equal(value.months[2].openingBalanceCents, -50);
  assert.equal(value.months[2].closingBalanceCents, -25);
  assert.equal(resolveForecastWindow(new Date("2028-02-10T12:00:00.000Z"), 1).horizonEnd, "2028-02-29");
});

test("uma única data de corte em São Paulo governa meia-noite e o horizonte", () => {
  const beforeLocalMidnight = resolveForecastWindow(new Date("2027-01-01T02:59:59.000Z"), 2);
  const afterLocalMidnight = resolveForecastWindow(new Date("2027-01-01T03:00:00.000Z"), 2);
  assert.equal(beforeLocalMidnight.today, "2026-12-31");
  assert.equal(beforeLocalMidnight.firstMonth, "2026-12");
  assert.equal(afterLocalMidnight.today, "2027-01-01");
  assert.equal(afterLocalMidnight.firstMonth, "2027-01");
  assert.equal(beforeLocalMidnight.asOf, "2027-01-01T02:59:59.000Z");
});

test("horizonte aceita limites seguros e rejeita valores inválidos", () => {
  assert.equal(resolveForecastWindow(NOW).monthKeys.length, 6);
  assert.equal(resolveForecastWindow(NOW, 1).monthKeys.length, 1);
  assert.equal(resolveForecastWindow(NOW, FORECAST_MAX_MONTHS).monthKeys.length, 24);
  for (const value of [0, -1, 25, 1.5, NaN]) assert.throws(() => resolveForecastWindow(NOW, value));
  assert.throws(() => resolveForecastWindow(new Date("invalid"), 6));
});

test("consulta é read-only, usa um batch fixo de cinco SELECTs e mantém isolamento", async t => {
  const f = fixture(t, 123);
  bill(f.db, f.b, { id: "private-bill", amount: 999_999, date: "2026-10-01" });
  const before = f.db.prepare("SELECT total_changes() AS value").get().value;
  const value = await forecast(f);
  const after = f.db.prepare("SELECT total_changes() AS value").get().value;
  assert.equal(after, before);
  assert.equal(f.d1.batchCount, 1);
  assert.equal(f.d1.statements.length, 5);
  assert.ok(f.d1.statements.every((sql) => /^\s*(?:WITH|SELECT)/u.test(sql)));
  assert.doesNotMatch(f.d1.statements.join("\n"), /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/u);
  assert.equal(value.currentBalanceCents, 123);
  assert.doesNotMatch(JSON.stringify(value), /private-bill|999999/u);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

const serviceEnv = globalThis.__telegramHandlerTestEnv ?? {};
globalThis.__telegramHandlerTestEnv = serviceEnv;
const loaderSource = `
  import { existsSync, statSync } from "node:fs";
  import { dirname, extname, resolve as resolvePath } from "node:path";
  import { fileURLToPath, pathToFileURL } from "node:url";
  const root = ${JSON.stringify(process.cwd())};
  function resolveFile(path) {
    const candidates = extname(path) ? [path] : [path, path + ".ts", path + ".mjs", path + ".tsx", resolvePath(path, "index.ts")];
    return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  }
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { shortCircuit: true, url: "data:text/javascript,export const env=globalThis.__telegramHandlerTestEnv" };
    if (specifier.startsWith("@/")) {
      const path = resolveFile(resolvePath(root, specifier.slice(2)));
      if (!path) throw new Error("Módulo de teste não encontrado: " + specifier);
      return { shortCircuit: true, url: pathToFileURL(path).href };
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:") && !extname(specifier)) {
      const path = resolveFile(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier));
      if (path) return { shortCircuit: true, url: pathToFileURL(path).href };
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);

const { configureCardCurrentState, getCardOnboardingEligibility, getCardOnboardingPreview, CardOnboardingError } = await import("../lib/card-onboarding-service.ts?tests");
const { getInvoiceState, payInvoiceResidual, reverseInvoicePayment } = await import("../lib/invoice-service.ts?onboarding-tests");
const { getInvoiceDetail } = await import("../lib/invoice-detail-service.ts?onboarding-tests");
const { createCardPurchase } = await import("../lib/finance-service.ts?onboarding-tests");
const { FINANCIAL_EVENTS_CTE, CURRENT_ACCOUNT_BALANCES_SQL } = await import("../lib/finance-analytics.mjs?onboarding-tests");

class LocalStatement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new LocalStatement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async raw() { const statement = this.db.prepare(this.sql); const columns = statement.columns().map((column) => column.name); return statement.all(...this.bindings).map((row) => columns.map((column) => row[column])); }
  runSync() { const result = this.db.prepare(this.sql).run(...this.bindings); return { success: true, results: [], meta: { changes: result.changes } }; }
  async run() { return this.runSync(); }
}

class LocalD1 {
  constructor(db) { this.db = db; this.beforeBatch = null; this.beforeStatement = null; }
  prepare(sql) { return new LocalStatement(this.db, sql); }
  async batch(statements) {
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; await hook(); }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (this.beforeStatement) this.beforeStatement(statements[index], index);
        result.push(statements[index].runSync());
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const AT = "2026-09-18T12:00:00.000Z";
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

function database(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) {
    const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

function seedHousehold(db, suffix, card = {}) {
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `House ${suffix}`, `u${suffix}`, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(`a${suffix}`, `h${suffix}`, `Account ${suffix}`, "bank", 200000, 1, AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`category-${suffix}`, `h${suffix}`, `Category ${suffix}`, "expense", 1, AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`subcategory-${suffix}`, `h${suffix}`, `category-${suffix}`, `Subcategory ${suffix}`, 1, AT, AT);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(`card-${suffix}`, `h${suffix}`, `Card ${suffix}`, "Bank", `User ${suffix}`, card.limitCents ?? 200000, card.closingDay ?? 5, card.dueDay ?? 12, 1, AT, AT);
}

function setup(t, card = {}) {
  const db = database(t);
  seedHousehold(db, "a", card);
  seedHousehold(db, "b");
  const d1 = new LocalD1(db);
  serviceEnv.DB = d1;
  return { db, d1, context: { d1, householdId: "ha", userId: "ua", timestamp: AT } };
}

const openingOnly = {
  cardId: "card-a",
  initialReferenceMonth: "2026-10",
  declaredCurrentInvoiceTotalCents: 140000,
  expectedCardUpdatedAt: AT,
  expectedClosesOn: "2026-10-05",
  expectedDueOn: "2026-10-12",
  closedCycleConfirmed: false,
  idempotencyKey: "opening-only",
  commitments: [],
};

const importedCommitment = {
  description: "Compra anterior",
  installmentAmountCents: 10000,
  firstOriginalInstallmentNumber: 5,
  originalInstallmentCount: 10,
  originalTotalCents: 100000,
  originalPurchaseDate: "2026-05-10",
  categoryId: "category-a",
  subcategoryId: "subcategory-a",
};

function counts(db) {
  const names = ["card_import_batches", "card_invoice_adjustments", "card_purchase_import_metadata", "card_purchases", "card_invoices", "card_installments", "transactions", "audit_logs"];
  return Object.fromEntries(names.map((name) => [name, db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n]));
}

function isCode(code) {
  return (error) => error instanceof CardOnboardingError && error.code === code;
}

test("opening balance sozinho compõe total/remaining/limite sem transaction, renda ou despesa", async (t) => {
  const f = setup(t);
  const result = await configureCardCurrentState(openingOnly, f.context);
  assert.equal(result.openingBalanceCents, 140000);
  assert.equal(f.db.prepare("SELECT amount_cents FROM card_invoice_adjustments").get().amount_cents, 140000);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
  assert.equal(f.db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT COUNT(*) n FROM financial_events`).get("ha", "ha").n, 0);
  const state = await getInvoiceState(result.invoiceId, f.context);
  assert.deepEqual({ total: state.invoiceTotalCents, paid: state.paidCents, remaining: state.remainingCents }, { total: 140000, paid: 0, remaining: 140000 });
  const availableLimit = f.db.prepare("SELECT limit_cents - ? available FROM credit_cards WHERE id='card-a'").get(state.remainingCents).available;
  assert.equal(availableLimit, 60000);
  const audit = f.db.prepare("SELECT new_data FROM audit_logs WHERE entity_type='card_import_batch'").get();
  assert.equal(JSON.parse(audit.new_data).openingBalanceCents, 140000);
  assert.doesNotMatch(audit.new_data, /opening-only|fingerprint|idempotency/iu);
});

test("pagamento quita opening balance, reduz saldo bancário; reversão restaura ambos", async (t) => {
  const f = setup(t);
  const configured = await configureCardCurrentState(openingOnly, f.context);
  const payment = await payInvoiceResidual({ invoiceId: configured.invoiceId, accountId: "aa", paidAt: "2026-09-18", idempotencyKey: "pay", expectedRemainingCents: 140000 }, f.context);
  assert.equal((await getInvoiceState(configured.invoiceId, f.context)).remainingCents, 0);
  const paidBalance = f.db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all("ha", "2026-09-18", "ha", "2026-09-18", "ha").find((row) => row.account_id === "aa");
  assert.equal(paidBalance.current_balance_cents, 60000);
  await reverseInvoicePayment({ paymentId: payment.paymentId, reversedAt: "2026-09-18", idempotencyKey: "reverse" }, f.context);
  assert.equal((await getInvoiceState(configured.invoiceId, f.context)).remainingCents, 140000);
  const reversedBalance = f.db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all("ha", "2026-09-18", "ha", "2026-09-18", "ha").find((row) => row.account_id === "aa");
  assert.equal(reversedBalance.current_balance_cents, 200000);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
});

test("R$ 1.400 com parcela atual de R$ 100 cria opening de R$ 1.300, nunca R$ 1.500", async (t) => {
  const f = setup(t);
  const result = await configureCardCurrentState({ ...openingOnly, idempotencyKey: "with-parts", commitments: [importedCommitment] }, f.context);
  assert.equal(result.openingBalanceCents, 130000);
  assert.equal((await getInvoiceState(result.invoiceId, f.context)).invoiceTotalCents, 140000);
  assert.equal(f.db.prepare("SELECT SUM(amount_cents) n FROM card_invoice_adjustments").get().n, 130000);
  assert.equal(f.db.prepare("SELECT SUM(amount_cents) n FROM card_installments WHERE invoice_id=?").get(result.invoiceId).n, 10000);
});

test("R$ 1.400 com parcelas atuais de R$ 100 e R$ 200 cria opening de R$ 1.100", async (t) => {
  const f = setup(t);
  const commitments = [
    { ...importedCommitment, description: "Parcela 100", firstOriginalInstallmentNumber: 10, installmentAmountCents: 10000 },
    { ...importedCommitment, description: "Parcela 200", firstOriginalInstallmentNumber: 10, installmentAmountCents: 20000, originalTotalCents: 200000 },
  ];
  const result = await configureCardCurrentState({ ...openingOnly, idempotencyKey: "two-current-parts", commitments }, f.context);
  assert.equal(result.openingBalanceCents, 110000);
  assert.equal((await getInvoiceState(result.invoiceId, f.context)).invoiceTotalCents, 140000);
  assert.equal(f.db.prepare("SELECT SUM(amount_cents) n FROM card_installments WHERE invoice_id=?").get(result.invoiceId).n, 30000);
  assert.equal(f.db.prepare("SELECT SUM(amount_cents) n FROM card_invoice_adjustments").get().n, 110000);
});

test("opening zero não cria adjustment e total permanece canônico", async (t) => {
  const f = setup(t);
  const result = await configureCardCurrentState({ ...openingOnly, idempotencyKey: "zero", declaredCurrentInvoiceTotalCents: 10000, commitments: [importedCommitment] }, f.context);
  assert.equal(result.openingBalanceCents, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_invoice_adjustments").get().n, 0);
  assert.equal((await getInvoiceState(result.invoiceId, f.context)).invoiceTotalCents, 10000);
});

test("opening negativo rejeita tudo sem consumir idempotência", async (t) => {
  const f = setup(t);
  const before = counts(f.db);
  const input = { ...openingOnly, idempotencyKey: "negative", declaredCurrentInvoiceTotalCents: 5000, commitments: [importedCommitment] };
  await assert.rejects(configureCardCurrentState(input, f.context), isCode("CARD_ONBOARDING_NEGATIVE_OPENING_BALANCE"));
  assert.deepEqual(counts(f.db), before);
  await configureCardCurrentState({ ...input, declaredCurrentInvoiceTotalCents: 10000 }, f.context);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 1);
});

test("parcelamento antigo armazena somente 5/10 até 10/10 e metadata preserva origem", async (t) => {
  const f = setup(t);
  await configureCardCurrentState({ ...openingOnly, idempotencyKey: "mapping", commitments: [importedCommitment] }, f.context);
  const physical = f.db.prepare(`SELECT s.installment_number,s.installment_count,i.reference_month,s.amount_cents
    FROM card_installments s JOIN card_invoices i ON i.id=s.invoice_id ORDER BY s.installment_number`).all();
  assert.deepEqual(physical.map((row) => row.installment_number), [1, 2, 3, 4, 5, 6]);
  assert.ok(physical.every((row) => row.installment_count === 6 && row.amount_cents === 10000));
  assert.deepEqual(physical.map((row) => row.reference_month), ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
  const metadata = f.db.prepare("SELECT first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date FROM card_purchase_import_metadata").get();
  assert.deepEqual({ ...metadata }, { first_original_installment_number: 5, original_installment_count: 10, original_total_cents: 100000, original_purchase_date: "2026-05-10" });
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_installments").get().n, 6);
});

test("metadata original opcional não inventa data histórica", async (t) => {
  const f = setup(t);
  const commitment = { ...importedCommitment, originalTotalCents: null, originalPurchaseDate: null };
  await configureCardCurrentState({ ...openingOnly, idempotencyKey: "optional", commitments: [commitment] }, f.context);
  const metadata = f.db.prepare("SELECT original_total_cents,original_purchase_date FROM card_purchase_import_metadata").get();
  assert.equal(metadata.original_total_cents, null); assert.equal(metadata.original_purchase_date, null);
  assert.equal(f.db.prepare("SELECT purchase_date FROM card_purchases").get().purchase_date, "2026-09-18");
});

test("analytics ignora opening balance e inclui somente competências importadas reais", async (t) => {
  const f = setup(t);
  await configureCardCurrentState({ ...openingOnly, idempotencyKey: "analytics", commitments: [importedCommitment] }, f.context);
  const events = f.db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT entity_type,competence_month,amount_cents FROM financial_events ORDER BY competence_month`).all("ha", "ha");
  assert.equal(events.length, 6);
  assert.ok(events.every((row) => row.entity_type === "card_installment" && row.amount_cents === 10000));
  assert.deepEqual(events.map((row) => row.competence_month), ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
  assert.equal(events.reduce((sum, row) => sum + row.amount_cents, 0), 60000);
});

test("preview autoritativo sugere sem selecionar e aceita competência histórica/futura no range seguro", async (t) => {
  const f = setup(t);
  const preview = await getCardOnboardingPreview("card-a", "2024-09", f.context);
  assert.equal(preview.eligible, true);
  assert.equal(preview.today, "2026-09-18");
  assert.equal(preview.minimumReferenceMonth, "2024-09");
  assert.equal(preview.maximumReferenceMonth, "2027-09");
  assert.equal(preview.suggestedReferenceMonth, "2026-10");
  assert.deepEqual(preview.cycles.find((cycle) => cycle.referenceMonth === "2024-09"), {
    referenceMonth: "2024-09", closesOn: "2024-09-05", dueOn: "2024-09-12",
    state: "closed", requiresClosedCycleConfirmation: true,
  });
  assert.equal((await getCardOnboardingPreview("card-a", "2027-09", f.context)).eligible, true);
  await assert.rejects(getCardOnboardingPreview("card-a", "2024-08", f.context), isCode("CARD_ONBOARDING_REFERENCE_RANGE"));
  await assert.rejects(getCardOnboardingPreview("card-a", "2027-10", f.context), isCode("CARD_ONBOARDING_REFERENCE_RANGE"));
});

test("preview respeita a meia-noite civil de São Paulo e exige confirmação para ciclo fechado", async (t) => {
  const before = setup(t);
  const openPreview = await getCardOnboardingPreview("card-a", "2026-09", { ...before.context, timestamp: "2026-09-06T02:30:00.000Z" });
  assert.equal(openPreview.today, "2026-09-05");
  assert.equal(openPreview.cycles.find((cycle) => cycle.referenceMonth === "2026-09")?.state, "open");

  const after = setup(t);
  const closedPreview = await getCardOnboardingPreview("card-a", "2026-09", { ...after.context, timestamp: "2026-09-06T03:30:00.000Z" });
  const closed = closedPreview.cycles.find((cycle) => cycle.referenceMonth === "2026-09");
  assert.equal(closedPreview.today, "2026-09-06");
  assert.equal(closed?.state, "closed");
  await assert.rejects(configureCardCurrentState({
    ...openingOnly, initialReferenceMonth: "2026-09", expectedClosesOn: "2026-09-05", expectedDueOn: "2026-09-12",
    closedCycleConfirmed: false, idempotencyKey: "closed-without-confirmation",
  }, { ...after.context, timestamp: "2026-09-06T03:30:00.000Z" }), isCode("CARD_ONBOARDING_CLOSED_CONFIRMATION_REQUIRED"));
});

test("POST rejeita preview forjado ou obsoleto antes de gravar", async (t) => {
  const forged = setup(t);
  await assert.rejects(configureCardCurrentState({ ...openingOnly, expectedClosesOn: "2026-10-06" }, forged.context), isCode("CARD_ONBOARDING_PREVIEW_STALE"));
  assert.equal(forged.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 0);

  const stale = setup(t);
  stale.db.prepare("UPDATE credit_cards SET updated_at=? WHERE id='card-a'").run("2026-09-18T13:00:00.000Z");
  await assert.rejects(configureCardCurrentState(openingOnly, stale.context), isCode("CARD_ONBOARDING_PREVIEW_STALE"));
  assert.equal(stale.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 0);
});

test("calendário canônico cobre dezembro→janeiro, fevereiro normal/bissexto e dia 31", async (t) => {
  const f = setup(t);
  const cases = [
    { suffix: "c", timestamp: "2026-11-10T12:00:00Z", initial: "2026-12", months: ["2026-12", "2027-01"], dueDates: ["2026-12-31", "2027-01-31"], closes: ["2026-11-30", "2026-12-31"] },
    { suffix: "d", timestamp: "2027-01-10T12:00:00Z", initial: "2027-02", months: ["2027-02", "2027-03"], dueDates: ["2027-02-28", "2027-03-31"], closes: ["2027-01-31", "2027-02-28"] },
    { suffix: "e", timestamp: "2028-01-10T12:00:00Z", initial: "2028-02", months: ["2028-02", "2028-03"], dueDates: ["2028-02-29", "2028-03-31"], closes: ["2028-01-31", "2028-02-29"] },
  ];
  for (const item of cases) {
    seedHousehold(f.db, item.suffix, { closingDay: 31, dueDay: 31 });
    const context = { d1: f.d1, householdId: `h${item.suffix}`, userId: `u${item.suffix}`, timestamp: item.timestamp };
    await configureCardCurrentState({ cardId: `card-${item.suffix}`, initialReferenceMonth: item.initial, declaredCurrentInvoiceTotalCents: 100, expectedCardUpdatedAt: AT, expectedClosesOn: item.closes[0], expectedDueOn: item.dueDates[0], closedCycleConfirmed: false, idempotencyKey: `calendar-${item.suffix}`, commitments: [{ description: "Calendar", installmentAmountCents: 100, firstOriginalInstallmentNumber: 1, originalInstallmentCount: 2 }] }, context);
    const rows = f.db.prepare("SELECT reference_month,due_date,closes_on FROM card_invoices WHERE household_id=? ORDER BY reference_month").all(`h${item.suffix}`);
    assert.deepEqual(rows.map((row) => row.reference_month), item.months);
    assert.deepEqual(rows.map((row) => row.due_date), item.dueDates);
    assert.deepEqual(rows.map((row) => row.closes_on), item.closes);
  }
});

test("closing_day 31 e due_day 28 preservam regra de mês anterior", async (t) => {
  const f = setup(t, { closingDay: 31, dueDay: 28 });
  const result = await configureCardCurrentState({ ...openingOnly, initialReferenceMonth: "2026-10", declaredCurrentInvoiceTotalCents: 1, expectedClosesOn: "2026-09-30", expectedDueOn: "2026-10-28", idempotencyKey: "days", commitments: [{ description: "One", installmentAmountCents: 1, firstOriginalInstallmentNumber: 1, originalInstallmentCount: 1 }] }, f.context);
  const invoice = f.db.prepare("SELECT due_date,closes_on FROM card_invoices WHERE id=?").get(result.invoiceId);
  assert.deepEqual({ ...invoice }, { due_date: "2026-10-28", closes_on: "2026-09-30" });
});

test("retry e concorrência com a mesma key resultam em uma única configuração", async (t) => {
  const f = setup(t);
  const first = await configureCardCurrentState(openingOnly, f.context);
  const replay = await configureCardCurrentState(openingOnly, f.context);
  assert.equal(replay.batchId, first.batchId); assert.equal(replay.replayed, true);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE entity_type='card_import_batch'").get().n, 1);

  const other = setup(t);
  const rows = await Promise.all([configureCardCurrentState(openingOnly, other.context), configureCardCurrentState(openingOnly, other.context)]);
  assert.equal(new Set(rows.map((row) => row.batchId)).size, 1);
  assert.equal(other.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 1);
});

test("mesma key com payload diferente e keys concorrentes diferentes não duplicam", async (t) => {
  const first = setup(t);
  await configureCardCurrentState(openingOnly, first.context);
  await assert.rejects(configureCardCurrentState({ ...openingOnly, declaredCurrentInvoiceTotalCents: 130000 }, first.context), isCode("CARD_ONBOARDING_IDEMPOTENCY_CONFLICT"));
  assert.equal(first.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 1);

  const second = setup(t);
  const rows = await Promise.allSettled([
    configureCardCurrentState({ ...openingOnly, idempotencyKey: "race-a" }, second.context),
    configureCardCurrentState({ ...openingOnly, idempotencyKey: "race-b" }, second.context),
  ]);
  assert.equal(rows.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(rows.filter((row) => row.status === "rejected").length, 1);
  assert.equal(second.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 1);
});

test("atividade anterior torna cartão inelegível, inclusive invoice vazia", async (t) => {
  for (const kind of ["purchase", "invoice"]) {
    const f = setup(t);
    if (kind === "purchase") f.db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("existing", "ha", "card-a", "Existing", 100, "2026-09-01", 1, "active", "ua", "web", AT, AT);
    else f.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("existing", "ha", "card-a", "2026-10", "2026-10-12", "open", AT, AT);
    assert.deepEqual(await getCardOnboardingEligibility("card-a", f.context), { eligible: false, reason: "existing_activity" });
    await assert.rejects(configureCardCurrentState({ ...openingOnly, idempotencyKey: `used-${kind}` }, f.context), isCode("CARD_ONBOARDING_INELIGIBLE"));
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 0);
  }
});

test("household e membership impedem IDs cruzados", async (t) => {
  const f = setup(t);
  await assert.rejects(configureCardCurrentState({ ...openingOnly, cardId: "card-b" }, f.context), isCode("CARD_ONBOARDING_CARD_NOT_FOUND"));
  f.db.prepare("UPDATE household_members SET status='inactive' WHERE id='ma'").run();
  await assert.rejects(configureCardCurrentState(openingOnly, f.context), (error) => error.status === 403);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 0);
});

test("categoria/subcategoria cross-household é rejeitada sem escrita", async (t) => {
  const f = setup(t);
  await assert.rejects(configureCardCurrentState({ ...openingOnly, commitments: [{ ...importedCommitment, categoryId: "category-b", subcategoryId: "subcategory-b" }] }, f.context), /Categoria inválida/iu);
  await assert.rejects(configureCardCurrentState({ ...openingOnly, commitments: [{ ...importedCommitment, subcategoryId: "subcategory-b" }] }, f.context), /Subcategoria inválida/iu);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 0);
});

test("falha tardia de auditoria e invoice concorrente revertem integralmente", async (t) => {
  const first = setup(t);
  first.db.exec("CREATE TEMP TRIGGER reject_import_audit BEFORE INSERT ON audit_logs WHEN NEW.entity_type='card_import_batch' BEGIN SELECT RAISE(ABORT,'forced audit failure'); END");
  const before = counts(first.db);
  await assert.rejects(configureCardCurrentState(openingOnly, first.context), /forced audit failure/iu);
  assert.deepEqual(counts(first.db), before);

  const second = setup(t);
  second.d1.beforeBatch = async () => {
    second.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("concurrent", "ha", "card-a", "2026-10", "2026-10-12", "open", AT, AT);
  };
  await assert.rejects(configureCardCurrentState(openingOnly, second.context), isCode("CARD_ONBOARDING_INELIGIBLE"));
  assert.equal(second.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 0);
  assert.equal(second.db.prepare("SELECT COUNT(*) n FROM card_invoice_adjustments").get().n, 0);
  assert.equal(second.db.prepare("SELECT COUNT(*) n FROM card_purchases").get().n, 0);

  const third = setup(t);
  third.d1.beforeBatch = async () => {
    third.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run("concurrent-installment-invoice", "ha", "card-a", "2026-10", "2026-10-12", "open", AT, AT);
    third.db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("concurrent-installment-purchase", "ha", "card-a", "Concorrente", 100, "2026-09-18", 1, "active", "ua", "web", AT, AT);
    third.db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("concurrent-installment", "ha", "concurrent-installment-purchase", "concurrent-installment-invoice", 1, 1, 100, "pending", AT, AT);
  };
  await assert.rejects(configureCardCurrentState(openingOnly, third.context), isCode("CARD_ONBOARDING_INELIGIBLE"));
  assert.equal(third.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 0);
  assert.equal(third.db.prepare("SELECT COUNT(*) n FROM card_invoice_adjustments").get().n, 0);
  assert.equal(third.db.prepare("SELECT COUNT(*) n FROM card_purchases WHERE origin='system'").get().n, 0);
});

for (const failure of [
  { name: "segunda installment", needle: "INSERT INTO card_installments", occurrence: 2 },
  { name: "metadata", needle: "INSERT INTO card_purchase_import_metadata", occurrence: 1 },
  { name: "adjustment", needle: "INSERT INTO card_invoice_adjustments", occurrence: 1 },
  { name: "auditoria final", needle: "INSERT INTO audit_logs", occurrence: 1 },
]) test(`falha intermediária na ${failure.name} reverte integralmente o onboarding`, async (t) => {
  const f = setup(t);
  const before = counts(f.db);
  let seen = 0;
  f.d1.beforeStatement = (statement) => {
    if (statement.sql.includes(failure.needle)) {
      seen += 1;
      if (seen === failure.occurrence) throw new Error(`forced ${failure.name} failure`);
    }
  };
  await assert.rejects(
    configureCardCurrentState({ ...openingOnly, idempotencyKey: `atomic-${failure.needle.length}-${failure.occurrence}`, commitments: [importedCommitment] }, f.context),
    new RegExp(`forced ${failure.name} failure`, "u"),
  );
  assert.equal(seen, failure.occurrence);
  assert.deepEqual(counts(f.db), before);
});

test("detalhe read-only e invoices legadas sem adjustment permanecem coerentes", async (t) => {
  const f = setup(t);
  const imported = await configureCardCurrentState({ ...openingOnly, idempotencyKey: "detail", commitments: [importedCommitment] }, f.context);
  const detail = await getInvoiceDetail({ invoiceId: imported.invoiceId }, f.context);
  assert.equal(detail.invoice.invoiceTotalCents, 140000);
  assert.equal(detail.active.items.length, 1);
  assert.equal(detail.active.items[0].installmentAmountCents, 10000);
  assert.equal(detail.active.items[0].installmentNumber, 5);
  assert.equal(detail.active.items[0].installmentCount, 10);
  assert.deepEqual(detail.openingBalance, { originalCents: 130000, allocatedCents: 0, residualCents: 130000, identifiedCents: 0 });
  const importedInvoices = f.db.prepare("SELECT id, reference_month FROM card_invoices WHERE household_id='ha' ORDER BY reference_month").all();
  const nextDetail = await getInvoiceDetail({ invoiceId: importedInvoices.find((item) => item.reference_month === "2026-11").id }, f.context);
  const lastDetail = await getInvoiceDetail({ invoiceId: importedInvoices.find((item) => item.reference_month === "2027-03").id }, f.context);
  assert.deepEqual([nextDetail.active.items[0].installmentNumber, nextDetail.active.items[0].installmentCount], [6, 10]);
  assert.deepEqual([lastDetail.active.items[0].installmentNumber, lastDetail.active.items[0].installmentCount], [10, 10]);
  assert.deepEqual(detail.adjustments, [{ adjustmentId: detail.adjustments[0].adjustmentId, itemType: "opening_balance", description: "Saldo inicial ainda não identificado", amountCents: 130000, status: "active", includedInTotal: true }]);
  assert.equal(detail.active.items.reduce((sum, item) => sum + item.installmentAmountCents, 0) + detail.adjustments.reduce((sum, item) => sum + item.amountCents, 0), detail.invoice.invoiceTotalCents);

  seedHousehold(f.db, "legacy");
  f.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)").run("legacy-invoice", "hlegacy", "card-legacy", "2026-10", "2026-10-12", "2026-10-05", "open", AT, AT);
  f.db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("legacy-purchase", "hlegacy", "card-legacy", "Legacy", 50000, "2026-09-01", 1, "active", "ulegacy", "web", AT, AT);
  f.db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("legacy-part", "hlegacy", "legacy-purchase", "legacy-invoice", 1, 1, 50000, "pending", AT, AT);
  const legacyContext = { d1: f.d1, householdId: "hlegacy", userId: "ulegacy", timestamp: AT };
  assert.equal((await getInvoiceState("legacy-invoice", legacyContext)).invoiceTotalCents, 50000);
  assert.deepEqual((await getInvoiceDetail({ invoiceId: "legacy-invoice" }, legacyContext)).adjustments, []);
});

test("detalhe falha de forma controlada quando metadata importada não reconcilia", async (t) => {
  const f = setup(t);
  const imported = await configureCardCurrentState({ ...openingOnly, idempotencyKey: "inconsistent-detail", commitments: [importedCommitment] }, f.context);
  f.db.exec("DROP TRIGGER card_installments_completed_import_update");
  f.db.prepare("UPDATE card_installments SET installment_count = 5 WHERE invoice_id = ?").run(imported.invoiceId);
  await assert.rejects(
    getInvoiceDetail({ invoiceId: imported.invoiceId }, f.context),
    (error) => error instanceof CardOnboardingError === false && error?.status === 409 && error?.code === "INVOICE_DETAIL_INCONSISTENT",
  );
});

test("pagamento parcial, quitação posterior e reversão preservam lifecycle", async (t) => {
  const f = setup(t);
  const configured = await configureCardCurrentState(openingOnly, f.context);
  f.db.prepare("INSERT INTO invoice_payment_operations(id,household_id,idempotency_key,kind,invoice_id,account_id,created_by_user_id,amount_cents,occurred_on,reversed_payment_id,request_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("partial-op", "ha", "partial", "payment", configured.invoiceId, "aa", "ua", 40000, "2026-09-18", null, "manual-fixture", AT);
  f.db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at,operation_id) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("partial-payment", "ha", configured.invoiceId, "aa", 40000, "2026-09-18", "ua", AT, "partial-op");
  assert.equal((await getInvoiceState(configured.invoiceId, f.context)).remainingCents, 100000);
  const final = await payInvoiceResidual({ invoiceId: configured.invoiceId, accountId: "aa", paidAt: "2026-09-18", idempotencyKey: "final", expectedRemainingCents: 100000 }, f.context);
  assert.equal((await getInvoiceState(configured.invoiceId, f.context)).remainingCents, 0);
  await reverseInvoicePayment({ paymentId: final.paymentId, reversedAt: "2026-09-18", idempotencyKey: "reverse-final" }, f.context);
  assert.equal((await getInvoiceState(configured.invoiceId, f.context)).remainingCents, 100000);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
});

test("pagamento antecipado seguido de compra normal aumenta somente o residual e permite nova quitação", async (t) => {
  const f = setup(t);
  const configured = await configureCardCurrentState(openingOnly, f.context);
  await payInvoiceResidual({ invoiceId: configured.invoiceId, accountId: "aa", paidAt: "2026-09-18", idempotencyKey: "early-pay", expectedRemainingCents: 140000 }, f.context);
  assert.equal((await getInvoiceState(configured.invoiceId, f.context)).remainingCents, 0);
  await createCardPurchase({ cardId: "card-a", description: "Compra posterior", totalCents: 100, purchaseDate: "2026-09-18", installmentCount: 1, categoryId: "category-a", subcategoryId: "subcategory-a" }, { householdId: "ha", userId: "ua", origin: "dashboard", timestamp: AT });
  const afterPurchase = await getInvoiceState(configured.invoiceId, f.context);
  assert.equal(afterPurchase.invoiceTotalCents, 140100);
  assert.equal(afterPurchase.paidCents, 140000);
  assert.equal(afterPurchase.remainingCents, 100);
  await payInvoiceResidual({ invoiceId: configured.invoiceId, accountId: "aa", paidAt: "2026-09-18", idempotencyKey: "residual-pay", expectedRemainingCents: 100 }, f.context);
  assert.equal((await getInvoiceState(configured.invoiceId, f.context)).remainingCents, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
});

test("estado importado acima do limite é preservado sem truncamento", async (t) => {
  const f = setup(t, { limitCents: 100000 });
  const result = await configureCardCurrentState({ ...openingOnly, declaredCurrentInvoiceTotalCents: 140000, idempotencyKey: "negative-limit" }, f.context);
  const state = await getInvoiceState(result.invoiceId, f.context);
  assert.equal(f.db.prepare("SELECT limit_cents - ? available FROM credit_cards WHERE id='card-a'").get(state.remainingCents).available, -40000);
});

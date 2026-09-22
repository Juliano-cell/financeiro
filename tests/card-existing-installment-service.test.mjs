import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

register(`data:text/javascript,${encodeURIComponent(`
  import { existsSync, statSync } from "node:fs";
  import { dirname, extname, resolve as resolvePath } from "node:path";
  import { fileURLToPath, pathToFileURL } from "node:url";
  const root = ${JSON.stringify(process.cwd())};
  function file(path) { return (extname(path) ? [path] : [path, path + ".ts", path + ".mjs", path + ".tsx", resolvePath(path, "index.ts")]).find(p => existsSync(p) && statSync(p).isFile()); }
  export async function resolve(specifier, context, next) {
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);

const { addExistingCardInstallment, configureCardCurrentState, getExistingCardInstallmentContext, CardOnboardingError } = await import("../lib/card-onboarding-service.ts?existing-installments-tests");
const { getInvoiceState } = await import("../lib/invoice-service.ts?existing-installments-tests");
const { getInvoiceDetail } = await import("../lib/invoice-detail-service.ts?existing-installments-tests");
const { resolveInstallmentDisplay } = await import("../lib/card-onboarding-ui-rules.mjs?existing-installments-tests");
const { FINANCIAL_EVENTS_CTE } = await import("../lib/finance-analytics.mjs?existing-installments-tests");
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
const AT = "2026-09-18T12:00:00.000Z";

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  runSync() { const statement = this.db.prepare(this.sql); const result = statement.columns().length ? { changes: 0 } : statement.run(...this.bindings); return { success: true, results: [], meta: { changes: result.changes } }; }
  async run() { return this.runSync(); }
}

class LocalD1 {
  constructor(db) { this.db = db; this.beforeStatement = null; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (this.beforeStatement) this.beforeStatement(statements[index], index);
        results.push(statements[index].runSync());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function seedHousehold(db, suffix) {
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `House ${suffix}`, `u${suffix}`, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(`account-${suffix}`, `h${suffix}`, `Account ${suffix}`, "bank", 200000, 1, AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`category-${suffix}`, `h${suffix}`, `Category ${suffix}`, "expense", 1, AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`subcategory-${suffix}`, `h${suffix}`, `category-${suffix}`, `Subcategory ${suffix}`, 1, AT, AT);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(`card-${suffix}`, `h${suffix}`, `Card ${suffix}`, "Bank", `User ${suffix}`, 500000, 5, 12, 1, AT, AT);
}

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) for (const sql of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(sql);
  seedHousehold(db, "a"); seedHousehold(db, "b");
  const d1 = new LocalD1(db);
  const context = { d1, householdId: "ha", userId: "ua", timestamp: AT };
  t.after(() => { assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0); db.close(); });
  return { db, d1, context };
}

const initial = { cardId: "card-a", initialReferenceMonth: "2026-10", declaredCurrentInvoiceTotalCents: 140000, expectedCardUpdatedAt: AT, expectedClosesOn: "2026-10-05", expectedDueOn: "2026-10-12", closedCycleConfirmed: false, idempotencyKey: "initial", commitments: [] };
const supplemental = {
  cardId: "card-a", firstReferenceMonth: "2026-10", mode: "additional", expectedOpeningResidualCents: 140000, idempotencyKey: "supplemental-1",
  commitment: { description: "Compra esquecida", installmentAmountCents: 10000, originalInstallmentCount: 12, firstOriginalInstallmentNumber: 10, originalTotalCents: 120000, originalPurchaseDate: "2025-11-10", categoryId: "category-a", subcategoryId: "subcategory-a", notes: "Importada depois" },
};
const included = { ...supplemental, mode: "included", idempotencyKey: "included-1" };

async function configured(t) { const fixture = setup(t); await configureCardCurrentState(initial, fixture.context); return fixture; }
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

test("indicador soma initial_state e included, mas não additional, no cenário visual de R$ 1.400", async (t) => {
  const f = setup(t);
  const configured = await configureCardCurrentState({
    ...initial,
    idempotencyKey: "manual-ux-initial",
    commitments: [{
      description: "Celular Teste",
      installmentAmountCents: 20000,
      firstOriginalInstallmentNumber: 5,
      originalInstallmentCount: 10,
      originalTotalCents: 200000,
      originalPurchaseDate: "2026-05-10",
      categoryId: "category-a",
      subcategoryId: "subcategory-a",
    }],
  }, f.context);
  const initialContext = await getExistingCardInstallmentContext("card-a", f.context);
  assert.deepEqual({ original: initialContext.initialInvoiceOriginalCents, initialState: initialContext.initialStateInstallmentsCents, identified: initialContext.identifiedCents, residual: initialContext.openingResidualCents, total: initialContext.invoiceTotalCents }, { original: 140000, initialState: 20000, identified: 20000, residual: 120000, total: 140000 });
  const usedCents = async () => {
    const invoiceIds = f.db.prepare("SELECT id FROM card_invoices WHERE card_id='card-a'").all().map((row) => row.id);
    const states = await Promise.all(invoiceIds.map((invoiceId) => getInvoiceState(invoiceId, f.context)));
    return states.reduce((sum, state) => sum + state.remainingCents, 0);
  };
  assert.equal(await usedCents(), 240000);

  const includedResult = await addExistingCardInstallment({
    cardId: "card-a", firstReferenceMonth: "2026-10", mode: "included", expectedOpeningResidualCents: 120000, idempotencyKey: "manual-ux-included",
    commitment: { description: "Notebook Teste", installmentAmountCents: 15000, originalInstallmentCount: 3, firstOriginalInstallmentNumber: 1, originalTotalCents: 45000, originalPurchaseDate: "2026-09-10", categoryId: "category-a", subcategoryId: "subcategory-a", notes: null },
  }, f.context);
  assert.deepEqual({ residual: includedResult.openingResidualCents, total: includedResult.invoiceTotalCents }, { residual: 105000, total: 140000 });
  const includedContext = await getExistingCardInstallmentContext("card-a", f.context);
  assert.deepEqual({ identified: includedContext.identifiedCents, residual: includedContext.openingResidualCents, total: includedContext.invoiceTotalCents }, { identified: 35000, residual: 105000, total: 140000 });
  const includedDetail = await getInvoiceDetail({ invoiceId: configured.invoiceId }, f.context);
  assert.deepEqual(includedDetail.openingBalance, { originalCents: 140000, openingCents: 120000, initialStateInstallmentsCents: 20000, allocatedCents: 15000, residualCents: 105000, identifiedCents: 35000 });
  assert.equal(await usedCents(), 270000);

  const additionalResult = await addExistingCardInstallment({
    cardId: "card-a", firstReferenceMonth: "2026-10", mode: "additional", expectedOpeningResidualCents: 105000, idempotencyKey: "manual-ux-additional",
    commitment: { description: "TV Teste", installmentAmountCents: 10000, originalInstallmentCount: 2, firstOriginalInstallmentNumber: 1, originalTotalCents: 20000, originalPurchaseDate: "2026-09-11", categoryId: "category-a", subcategoryId: "subcategory-a", notes: null },
  }, f.context);
  assert.deepEqual({ residual: additionalResult.openingResidualCents, total: additionalResult.invoiceTotalCents }, { residual: 105000, total: 150000 });
  const additionalContext = await getExistingCardInstallmentContext("card-a", f.context);
  assert.deepEqual({ identified: additionalContext.identifiedCents, residual: additionalContext.openingResidualCents, total: additionalContext.invoiceTotalCents }, { identified: 35000, residual: 105000, total: 150000 });
  const additionalDetail = await getInvoiceDetail({ invoiceId: configured.invoiceId }, f.context);
  assert.deepEqual(additionalDetail.openingBalance, includedDetail.openingBalance);

  assert.equal(await usedCents(), 290000);
});

test("primeiro parcelamento complementar cria somente 10/12–12/12 e preserva opening balance", async (t) => {
  const f = await configured(t);
  const beforeAdjustment = f.db.prepare("SELECT id, amount_cents FROM card_invoice_adjustments").get();
  const result = await addExistingCardInstallment(supplemental, f.context);
  assert.equal(result.importedPurchaseCount, 1); assert.equal(result.importedInstallmentCount, 3); assert.equal(result.openingBalanceCents, 0);
  const batch = f.db.prepare("SELECT import_kind, opening_balance_cents, status FROM card_import_batches WHERE id=?").get(result.batchId);
  assert.deepEqual({ ...batch }, { import_kind: "existing_installments", opening_balance_cents: 0, status: "completed" });
  const metadata = f.db.prepare("SELECT first_original_installment_number first, original_installment_count total FROM card_purchase_import_metadata WHERE import_batch_id=?").get(result.batchId);
  const physical = f.db.prepare("SELECT installment_number n, installment_count c FROM card_installments WHERE purchase_id=(SELECT purchase_id FROM card_purchase_import_metadata WHERE import_batch_id=?) ORDER BY n").all(result.batchId);
  assert.deepEqual(physical.map((part) => resolveInstallmentDisplay({ physicalNumber: part.n, physicalCount: part.c, origin: "system", metadataValid: true, firstOriginalNumber: metadata.first, originalCount: metadata.total })), [{ installmentNumber: 10, installmentCount: 12 }, { installmentNumber: 11, installmentCount: 12 }, { installmentNumber: 12, installmentCount: 12 }]);
  assert.deepEqual(f.db.prepare("SELECT id, amount_cents FROM card_invoice_adjustments").get(), beforeAdjustment);
  assert.equal(count(f.db, "card_invoice_adjustments"), 1);
  assert.equal(count(f.db, "card_opening_balance_allocations"), 0);
});

test("segundo e terceiro batches complementares são permitidos e segundo initial_state continua proibido", async (t) => {
  const f = await configured(t);
  await addExistingCardInstallment(supplemental, f.context);
  await addExistingCardInstallment({ ...supplemental, idempotencyKey: "supplemental-2", commitment: { ...supplemental.commitment, description: "Outra compra", firstOriginalInstallmentNumber: 11 } }, f.context);
  await addExistingCardInstallment({ ...supplemental, idempotencyKey: "supplemental-3", commitment: { ...supplemental.commitment, description: "Terceira compra", firstOriginalInstallmentNumber: 12 } }, f.context);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_import_batches WHERE import_kind='existing_installments' AND status='completed'").get().n, 3);
  await assert.rejects(configureCardCurrentState({ ...initial, idempotencyKey: "second-initial" }, f.context), (error) => error instanceof CardOnboardingError && error.code === "CARD_ONBOARDING_INELIGIBLE");
});

test("invoice existente é reutilizada, futuras são criadas uma vez e totais são derivados", async (t) => {
  const f = await configured(t);
  const initialInvoiceId = f.db.prepare("SELECT id FROM card_invoices WHERE reference_month='2026-10'").get().id;
  await addExistingCardInstallment(supplemental, f.context);
  assert.equal(f.db.prepare("SELECT id FROM card_invoices WHERE reference_month='2026-10'").get().id, initialInvoiceId);
  assert.deepEqual(f.db.prepare("SELECT reference_month month, COUNT(*) n FROM card_invoices GROUP BY reference_month ORDER BY month").all().map((row) => ({ ...row })), [{ month: "2026-10", n: 1 }, { month: "2026-11", n: 1 }, { month: "2026-12", n: 1 }]);
  const total = f.db.prepare(`SELECT COALESCE((SELECT SUM(amount_cents) FROM card_installments WHERE invoice_id=i.id AND status<>'cancelled'),0)+COALESCE((SELECT SUM(amount_cents) FROM card_invoice_adjustments WHERE invoice_id=i.id AND status='active'),0) total FROM card_invoices i WHERE reference_month='2026-10'`).get().total;
  assert.equal(total, 150000);
});

test("invoice existente preserva snapshot histórico após mudança de vencimento do cartão", async (t) => {
  const f = await configured(t);
  const original = { ...f.db.prepare("SELECT id, due_date, closes_on FROM card_invoices WHERE reference_month='2026-10'").get() };
  f.db.prepare("UPDATE credit_cards SET closing_day=10, due_day=20, updated_at=? WHERE id='card-a'").run("2026-09-18T13:00:00.000Z");
  await addExistingCardInstallment(supplemental, { ...f.context, timestamp: "2026-09-18T13:00:00.000Z" });
  assert.deepEqual({ ...f.db.prepare("SELECT id, due_date, closes_on FROM card_invoices WHERE reference_month='2026-10'").get() }, original);
  assert.deepEqual({ ...f.db.prepare("SELECT due_date, closes_on FROM card_invoices WHERE reference_month='2026-11'").get() }, { due_date: "2026-11-20", closes_on: "2026-11-10" });
});

test("inclusão não movimenta contas, transactions ou pagamentos", async (t) => {
  const f = await configured(t);
  const balance = f.db.prepare("SELECT initial_balance_cents FROM accounts WHERE id='account-a'").get().initial_balance_cents;
  await addExistingCardInstallment(supplemental, f.context);
  assert.equal(f.db.prepare("SELECT initial_balance_cents FROM accounts WHERE id='account-a'").get().initial_balance_cents, balance);
  assert.equal(count(f.db, "transactions"), 0); assert.equal(count(f.db, "invoice_payments"), 0); assert.equal(count(f.db, "invoice_payment_operations"), 0);
});

test("retry é idempotente e mesma chave com payload diferente conflita", async (t) => {
  const f = await configured(t);
  const first = await addExistingCardInstallment(supplemental, f.context);
  const replay = await addExistingCardInstallment(supplemental, f.context);
  assert.equal(replay.batchId, first.batchId); assert.equal(replay.replayed, true); assert.equal(count(f.db, "card_purchases"), 1);
  await assert.rejects(addExistingCardInstallment({ ...supplemental, commitment: { ...supplemental.commitment, description: "Mudou" } }, f.context), (error) => error.code === "CARD_ONBOARDING_IDEMPOTENCY_CONFLICT");
});

test("cartão inativo, outro household e membership inativa são rejeitados", async (t) => {
  const f = await configured(t);
  f.db.exec("UPDATE credit_cards SET is_active=0 WHERE id='card-a'");
  await assert.rejects(addExistingCardInstallment(supplemental, f.context), (error) => error.code === "CARD_IMPORT_CARD_NOT_FOUND");
  f.db.exec("UPDATE credit_cards SET is_active=1 WHERE id='card-a'");
  await assert.rejects(addExistingCardInstallment({ ...supplemental, cardId: "card-b" }, f.context), (error) => error.code === "CARD_IMPORT_CARD_NOT_FOUND");
  f.db.exec("UPDATE household_members SET status='inactive' WHERE id='ma'");
  await assert.rejects(addExistingCardInstallment(supplemental, f.context), (error) => error.status === 403);
});

test("ciclo fechado rejeita e falha intermediária reverte tudo", async (t) => {
  const closed = await configured(t);
  closed.db.exec("UPDATE card_invoices SET status='closed' WHERE reference_month='2026-10'");
  const beforeClosed = count(closed.db, "card_import_batches");
  await assert.rejects(addExistingCardInstallment(supplemental, closed.context), (error) => error.code === "CARD_IMPORT_INVOICE_CLOSED");
  assert.equal(count(closed.db, "card_import_batches"), beforeClosed);

  const failed = await configured(t);
  const before = Object.fromEntries(["card_import_batches", "card_purchases", "card_installments", "card_invoices", "card_purchase_import_metadata", "audit_logs"].map((table) => [table, count(failed.db, table)]));
  failed.d1.beforeStatement = (_statement, index) => { if (index === 4) throw new Error("forced intermediate failure"); };
  await assert.rejects(addExistingCardInstallment(supplemental, failed.context), /forced intermediate failure/iu);
  assert.deepEqual(Object.fromEntries(Object.keys(before).map((table) => [table, count(failed.db, table)])), before);
});

test("identificação parcial reduz somente o residual e mantém o total da primeira fatura", async (t) => {
  const f = await configured(t);
  const invoiceId = f.db.prepare("SELECT id FROM card_invoices WHERE reference_month='2026-10'").get().id;
  const beforeState = await getInvoiceState(invoiceId, f.context);
  const result = await addExistingCardInstallment(included, f.context);
  const afterState = await getInvoiceState(invoiceId, f.context);
  assert.equal(result.mode, "included");
  assert.equal(result.allocatedAmountCents, 10000);
  assert.equal(result.openingOriginalCents, 140000);
  assert.equal(result.openingResidualCents, 130000);
  assert.equal(result.invoiceTotalCents, 140000);
  assert.deepEqual({ ...f.db.prepare("SELECT invoice_id,amount_cents FROM card_opening_balance_allocations").get() }, { invoice_id: invoiceId, amount_cents: 10000 });
  assert.equal(f.db.prepare("SELECT SUM(amount_cents) n FROM card_installments WHERE invoice_id=?").get(invoiceId).n, 10000);
  assert.equal(f.db.prepare("SELECT SUM(amount_cents) n FROM card_installments s JOIN card_invoices i ON i.id=s.invoice_id WHERE i.reference_month IN ('2026-11','2026-12')").get().n, 20000);
  assert.deepEqual({ total: afterState.invoiceTotalCents, paid: afterState.paidCents, remaining: afterState.remainingCents }, { total: beforeState.invoiceTotalCents, paid: beforeState.paidCents, remaining: beforeState.remainingCents });
  assert.equal(500000 - afterState.remainingCents, 500000 - beforeState.remainingCents);
  const events = f.db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT competence_month,amount_cents FROM financial_events ORDER BY competence_month`).all("ha", "ha");
  assert.deepEqual(events.map((row) => ({ ...row })), [
    { competence_month: "2026-10", amount_cents: 10000 },
    { competence_month: "2026-11", amount_cents: 10000 },
    { competence_month: "2026-12", amount_cents: 10000 },
  ]);
});

test("identificação total zera o residual sem alterar opening original", async (t) => {
  const f = await configured(t);
  const result = await addExistingCardInstallment({ ...included, idempotencyKey: "included-total", commitment: { ...included.commitment, installmentAmountCents: 140000, originalInstallmentCount: 1, firstOriginalInstallmentNumber: 1, originalTotalCents: 140000 } }, f.context);
  assert.equal(result.openingResidualCents, 0);
  assert.equal(result.invoiceTotalCents, 140000);
  assert.equal(f.db.prepare("SELECT amount_cents FROM card_invoice_adjustments").get().amount_cents, 140000);
});

test("identificação acima do residual, residual zero e competência diferente são rejeitados sem escrita", async (t) => {
  const f = await configured(t);
  const before = count(f.db, "card_import_batches");
  await assert.rejects(addExistingCardInstallment({ ...included, commitment: { ...included.commitment, installmentAmountCents: 140001 } }, f.context), (error) => error.code === "CARD_IMPORT_ALLOCATION_EXCEEDS_RESIDUAL");
  await assert.rejects(addExistingCardInstallment({ ...included, firstReferenceMonth: "2026-11" }, f.context), (error) => error.code === "CARD_IMPORT_INITIAL_REFERENCE_REQUIRED");
  assert.equal(count(f.db, "card_import_batches"), before);

  const zero = setup(t);
  await configureCardCurrentState({ ...initial, idempotencyKey: "zero-initial", declaredCurrentInvoiceTotalCents: 0 }, zero.context);
  await assert.rejects(addExistingCardInstallment({ ...included, idempotencyKey: "zero-identify", expectedOpeningResidualCents: 0 }, zero.context), (error) => error.code === "CARD_IMPORT_NO_OPENING_RESIDUAL");
});

test("múltiplas identificações usam residual esperado e fingerprint inclui o modo", async (t) => {
  const f = await configured(t);
  const first = await addExistingCardInstallment(included, f.context);
  const replay = await addExistingCardInstallment(included, f.context);
  assert.equal(replay.batchId, first.batchId); assert.equal(replay.replayed, true);
  await assert.rejects(addExistingCardInstallment({ ...included, mode: "additional" }, f.context), (error) => error.code === "CARD_ONBOARDING_IDEMPOTENCY_CONFLICT");
  const second = await addExistingCardInstallment({ ...included, idempotencyKey: "included-2", expectedOpeningResidualCents: 130000, commitment: { ...included.commitment, description: "Segunda identificação" } }, f.context);
  assert.equal(second.openingResidualCents, 120000);
  assert.equal(count(f.db, "card_opening_balance_allocations"), 2);
  const audit = JSON.parse(f.db.prepare("SELECT new_data FROM audit_logs WHERE entity_id=?").get(second.batchId).new_data);
  assert.deepEqual({ mode: audit.mode, before: audit.openingResidualBeforeCents, after: audit.openingResidualAfterCents }, { mode: "included", before: 130000, after: 120000 });
});

test("identificação atravessa dezembro para janeiro sem alterar a competência inicial", async (t) => {
  const f = await configured(t);
  const result = await addExistingCardInstallment({
    ...included, idempotencyKey: "included-year-crossing",
    commitment: { ...included.commitment, originalInstallmentCount: 15, firstOriginalInstallmentNumber: 10, originalTotalCents: 150000 },
  }, f.context);
  assert.equal(result.invoiceTotalCents, 140000);
  assert.deepEqual(f.db.prepare("SELECT reference_month FROM card_invoices ORDER BY reference_month").all().map((row) => row.reference_month), ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
});

test("fatura inicial fechada aceita reclassificação, mas futura incompatível reverte tudo", async (t) => {
  const closedInitial = await configured(t);
  closedInitial.db.exec("UPDATE card_invoices SET status='closed' WHERE reference_month='2026-10'");
  const result = await addExistingCardInstallment(included, closedInitial.context);
  assert.equal(result.invoiceTotalCents, 140000);

  const futureClosed = await configured(t);
  futureClosed.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("future-closed", "ha", "card-a", "2026-11", "2026-11-12", "2026-11-05", "closed", AT, AT);
  const before = Object.fromEntries(["card_import_batches", "card_purchases", "card_installments", "card_opening_balance_allocations"].map((table) => [table, count(futureClosed.db, table)]));
  await assert.rejects(addExistingCardInstallment(included, futureClosed.context), (error) => error.code === "CARD_IMPORT_INVOICE_CLOSED");
  assert.deepEqual(Object.fromEntries(Object.keys(before).map((table) => [table, count(futureClosed.db, table)])), before);
});

test("disputa concorrente do mesmo residual permite no máximo uma conclusão", async (t) => {
  const f = await configured(t);
  const large = { ...included, commitment: { ...included.commitment, installmentAmountCents: 100000, originalInstallmentCount: 1, firstOriginalInstallmentNumber: 1, originalTotalCents: 100000 } };
  const outcomes = await Promise.allSettled([
    addExistingCardInstallment({ ...large, idempotencyKey: "race-included-a" }, f.context),
    addExistingCardInstallment({ ...large, idempotencyKey: "race-included-b" }, f.context),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  assert.equal(f.db.prepare("SELECT SUM(amount_cents) n FROM card_opening_balance_allocations").get().n, 100000);
});

test("initial state, adjustment e invoice inicial ausentes falham fechados", async (t) => {
  const missingInitial = setup(t);
  await assert.rejects(addExistingCardInstallment(included, missingInitial.context), (error) => error.code === "CARD_IMPORT_INITIAL_REQUIRED");

  const inconsistentAdjustment = await configured(t);
  inconsistentAdjustment.db.exec("DROP TRIGGER card_invoice_adjustments_identity_update; DROP TRIGGER card_invoice_adjustments_completed_batch_update");
  inconsistentAdjustment.db.exec("UPDATE card_invoice_adjustments SET amount_cents=139999");
  await assert.rejects(addExistingCardInstallment(included, inconsistentAdjustment.context), (error) => error.code === "CARD_IMPORT_OPENING_INCONSISTENT");

  const missingInvoice = await configured(t);
  const savedInvoice = missingInvoice.db.prepare("SELECT * FROM card_invoices").get();
  missingInvoice.db.exec("PRAGMA foreign_keys=OFF; DELETE FROM card_invoices; PRAGMA foreign_keys=ON");
  await assert.rejects(addExistingCardInstallment(included, missingInvoice.context), (error) => error.code === "CARD_IMPORT_INITIAL_REQUIRED");
  missingInvoice.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,closes_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(savedInvoice.id, savedInvoice.household_id, savedInvoice.card_id, savedInvoice.reference_month, savedInvoice.due_date, savedInvoice.closes_on, savedInvoice.status, savedInvoice.created_at, savedInvoice.updated_at);
});

test("falha tardia após preparar allocation reverte batch, compra, parcelas, allocation e auditoria", async (t) => {
  const f = await configured(t);
  const tables = ["card_import_batches", "card_purchases", "card_installments", "card_opening_balance_allocations", "audit_logs"];
  const before = Object.fromEntries(tables.map((table) => [table, count(f.db, table)]));
  f.d1.beforeStatement = (statement) => { if (statement.sql.includes("INSERT INTO audit_logs")) throw new Error("forced late audit failure"); };
  await assert.rejects(addExistingCardInstallment(included, f.context), /forced late audit failure/iu);
  assert.deepEqual(Object.fromEntries(tables.map((table) => [table, count(f.db, table)])), before);
});

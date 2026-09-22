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
    if (specifier === "next/headers") return { shortCircuit: true, url: "data:text/javascript,export async function cookies(){const value=globalThis.__cardOnboardingApiCookie ?? globalThis.__invoiceTestCookie;return {get:()=>value ? {value} : undefined}}" };
    if (specifier === "next/server") return next("next/server.js", context);
    const path = specifier.startsWith("@/") ? file(resolvePath(root, specifier.slice(2))) : (specifier.startsWith(".") && !extname(specifier) && context.parentURL?.startsWith("file:")) ? file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) : null;
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  }
`)}`, import.meta.url);

const route = await import("../app/api/finance/card-onboarding/route.ts?api-tests");
const existingInstallmentRoute = await import("../app/api/finance/card-existing-installments/route.ts?api-tests");
const COOKIE = "card-onboarding-api-session";
const SESSION_ID = await digestToken(COOKIE);
const AT = "2026-09-18T12:00:00.000Z";
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first(column) { const row = this.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async raw() { const statement = this.db.prepare(this.sql); const columns = statement.columns().map((column) => column.name); return statement.all(...this.bindings).map((row) => columns.map((column) => row[column])); }
  runSync() {
    const statement = this.db.prepare(this.sql);
    if (statement.columns().length) return { success: true, results: statement.all(...this.bindings), meta: { changes: 0 } };
    const result = statement.run(...this.bindings);
    return { success: true, results: [], meta: { changes: result.changes } };
  }
  async run() { return this.runSync(); }
}

class LocalD1 {
  constructor(db) { this.db = db; this.beforeBatch = null; this.beforeStatement = null; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; await hook(); }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (this.beforeStatement) this.beforeStatement(statements[index], index);
        results.push(statements[index].runSync());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function seedHousehold(db, suffix) {
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `House ${suffix}`, `u${suffix}`, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`category-${suffix}`, `h${suffix}`, `Category ${suffix}`, "expense", 1, AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`subcategory-${suffix}`, `h${suffix}`, `category-${suffix}`, `Subcategory ${suffix}`, 1, AT, AT);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(`card-${suffix}`, `h${suffix}`, `Card ${suffix}`, "Bank", `User ${suffix}`, 500000, 5, 12, 1, AT, AT);
}

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) {
    for (const sql of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(sql);
  }
  seedHousehold(db, "a");
  seedHousehold(db, "b");
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)").run(SESSION_ID, "ua", "2027-12-01T00:00:00.000Z", AT, AT);
  const d1 = new LocalD1(db);
  runtime.DB = d1;
  globalThis.__cardOnboardingApiCookie = COOKIE;
  t.after(() => {
    globalThis.__cardOnboardingApiCookie = undefined;
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
  });
  return { db, d1 };
}

const installment = {
  description: "Compra anterior",
  originalTotalCents: 100000,
  originalInstallmentCount: 10,
  currentInstallmentNumber: 5,
  installmentAmountCents: 10000,
  originalPurchaseDate: "2026-05-10",
  categoryId: "category-a",
  subcategoryId: "subcategory-a",
};

const validPayload = {
  cardId: "card-a",
  referenceMonth: "2026-09",
  declaredCurrentInvoiceTotalCents: 140000,
  idempotencyKey: "configure-card-a",
  existingInstallments: [],
};

async function post(payload = validPayload, options = {}) {
  const body = options.raw ?? JSON.stringify(payload);
  const headers = { origin: "https://fixture.invalid", "content-type": "application/json", ...options.headers };
  const response = await route.POST(new Request("https://fixture.invalid/api/finance/card-onboarding", { method: "POST", headers, body }));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function eligibility(query = "cardId=card-a") {
  const response = await route.GET(new Request(`https://fixture.invalid/api/finance/card-onboarding?${query}`));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

const existingInstallmentPayload = {
  cardId: "card-a",
  firstReferenceMonth: "2026-10",
  idempotencyKey: "existing-card-a",
  description: "Compra lembrada depois",
  installmentAmountCents: 10000,
  originalInstallmentCount: 12,
  firstOriginalInstallmentNumber: 10,
  originalTotalCents: 120000,
  originalPurchaseDate: "2025-11-10",
  categoryId: "category-a",
  subcategoryId: "subcategory-a",
};

async function postExisting(payload = existingInstallmentPayload, options = {}) {
  const response = await existingInstallmentRoute.POST(new Request("https://fixture.invalid/api/finance/card-existing-installments", {
    method: "POST",
    headers: { origin: "https://fixture.invalid", "content-type": "application/json", ...options.headers },
    body: options.raw ?? JSON.stringify(payload),
  }));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function counts(db) {
  return Object.fromEntries(["card_import_batches", "card_invoice_adjustments", "card_purchase_import_metadata", "card_purchases", "card_invoices", "card_installments", "transactions", "audit_logs"]
    .map((name) => [name, db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n]));
}

test("POST sem sessão retorna 401 sem escrita", async (t) => {
  const f = setup(t); globalThis.__cardOnboardingApiCookie = undefined;
  assert.equal((await post()).status, 401); assert.deepEqual(counts(f.db), { card_import_batches: 0, card_invoice_adjustments: 0, card_purchase_import_metadata: 0, card_purchases: 0, card_invoices: 0, card_installments: 0, transactions: 0, audit_logs: 0 });
});

test("POST exige origem igual sem consumir operação", async (t) => {
  const f = setup(t); assert.equal((await post(validPayload, { headers: { origin: "https://evil.invalid" } })).status, 403); assert.equal(counts(f.db).card_import_batches, 0);
});

test("membership inativa retorna 403", async (t) => {
  const f = setup(t); f.db.exec("UPDATE household_members SET status='inactive' WHERE id='ma'"); assert.equal((await post()).status, 403); assert.equal(counts(f.db).card_import_batches, 0);
});

test("card inexistente retorna 404", async (t) => {
  const f = setup(t); const result = await post({ ...validPayload, cardId: "missing" }); assert.equal(result.status, 404); assert.equal(counts(f.db).card_import_batches, 0);
});

test("card de outro household falha sem revelar existência", async (t) => {
  const f = setup(t); const foreign = await post({ ...validPayload, cardId: "card-b" }); const missing = await post({ ...validPayload, cardId: "missing" });
  assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, missing.body); assert.equal(counts(f.db).card_import_batches, 0);
});

test("payload vazio é rejeitado", async (t) => {
  const f = setup(t); assert.equal((await post({})).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("JSON malformado é rejeitado sem detalhes internos", async (t) => {
  const f = setup(t); const result = await post(undefined, { raw: "{not-json" }); assert.equal(result.status, 400); assert.equal(result.body.code, "CARD_ONBOARDING_INVALID_JSON"); assert.equal(counts(f.db).card_import_batches, 0);
});

test("content-type não JSON é rejeitado", async (t) => {
  const f = setup(t); assert.equal((await post(validPayload, { headers: { "content-type": "text/plain" } })).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("payload acima do limite é rejeitado", async (t) => {
  const f = setup(t); const result = await post(undefined, { raw: JSON.stringify({ ...validPayload, extra: "x".repeat(130 * 1024) }) }); assert.equal(result.status, 400); assert.equal(result.body.code, "CARD_ONBOARDING_PAYLOAD_TOO_LARGE"); assert.equal(counts(f.db).card_import_batches, 0);
});

test("campos extras no payload são rejeitados", async (t) => {
  const f = setup(t); assert.equal((await post({ ...validPayload, householdId: "hb" })).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("cents em float são rejeitados", async (t) => {
  const f = setup(t); assert.equal((await post({ ...validPayload, declaredCurrentInvoiceTotalCents: 10.5 })).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("cents negativos são rejeitados", async (t) => {
  const f = setup(t); assert.equal((await post({ ...validPayload, declaredCurrentInvoiceTotalCents: -1 })).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("unsafe integer é rejeitado", async (t) => {
  const f = setup(t); assert.equal((await post({ ...validPayload, declaredCurrentInvoiceTotalCents: Number.MAX_SAFE_INTEGER + 1 })).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("referenceMonth inválido é rejeitado", async (t) => {
  const f = setup(t); assert.equal((await post({ ...validPayload, referenceMonth: "2026-13" })).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("quantidade original de parcelas inválida é rejeitada", async (t) => {
  const f = setup(t); assert.equal((await post({ ...validPayload, existingInstallments: [{ ...installment, originalInstallmentCount: 0 }] })).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("parcela atual maior que total é rejeitada", async (t) => {
  const f = setup(t); assert.equal((await post({ ...validPayload, existingInstallments: [{ ...installment, currentInstallmentNumber: 11 }] })).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("descrição excessiva é rejeitada", async (t) => {
  const f = setup(t); assert.equal((await post({ ...validPayload, existingInstallments: [{ ...installment, description: "x".repeat(121) }] })).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("array excessivo é rejeitado", async (t) => {
  const f = setup(t); const items = Array.from({ length: 51 }, (_, index) => ({ ...installment, description: `Compra ${index}` })); assert.equal((await post({ ...validPayload, existingInstallments: items })).status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("onboarding sem parcelamentos retorna contrato mínimo", async (t) => {
  const f = setup(t); const result = await post(); assert.equal(result.status, 201); assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(result.body).sort(), ["batchId", "cardId", "declaredCurrentInvoiceTotalCents", "importedInstallmentCount", "importedPurchaseCount", "invoiceId", "openingBalanceCents", "referenceMonth", "replayed", "status"]);
  assert.equal(result.body.openingBalanceCents, 140000); assert.equal(counts(f.db).transactions, 0);
});

test("opening zero não cria adjustment fictício", async (t) => {
  const f = setup(t); const result = await post({ ...validPayload, declaredCurrentInvoiceTotalCents: 10000, existingInstallments: [{ ...installment, currentInstallmentNumber: 10 }] });
  assert.equal(result.status, 201); assert.equal(result.body.openingBalanceCents, 0); assert.equal(counts(f.db).card_invoice_adjustments, 0);
});

test("parcelamento em andamento cria somente fatos remanescentes", async (t) => {
  setup(t); const result = await post({ ...validPayload, existingInstallments: [installment] }); assert.equal(result.status, 201); assert.equal(result.body.importedPurchaseCount, 1); assert.equal(result.body.importedInstallmentCount, 6);
});

test("parcela 5/10 gera somente 5–10 e preserva metadata original", async (t) => {
  const f = setup(t); await post({ ...validPayload, existingInstallments: [installment] });
  assert.deepEqual(f.db.prepare("SELECT installment_number FROM card_installments ORDER BY installment_number").all().map((row) => row.installment_number), [1, 2, 3, 4, 5, 6]);
  const metadata = f.db.prepare("SELECT first_original_installment_number first, original_installment_count total FROM card_purchase_import_metadata").get();
  assert.equal(metadata.first, 5); assert.equal(metadata.total, 10);
});

test("opening é calculado somente pelo serviço canônico", async (t) => {
  const f = setup(t); const result = await post({ ...validPayload, existingInstallments: [installment] }); assert.equal(result.body.openingBalanceCents, 130000);
  assert.equal(f.db.prepare("SELECT amount_cents FROM card_invoice_adjustments").get().amount_cents, 130000);
});

test("parcelas acima do declarado rejeitam tudo", async (t) => {
  const f = setup(t); const before = counts(f.db); const result = await post({ ...validPayload, declaredCurrentInvoiceTotalCents: 9999, existingInstallments: [installment] });
  assert.equal(result.status, 409); assert.deepEqual(counts(f.db), before);
});

test("mesma idempotency key e payload retorna retry seguro", async (t) => {
  const f = setup(t); const first = await post(); const second = await post(); assert.equal(first.status, 201); assert.equal(second.status, 201); assert.equal(second.body.batchId, first.body.batchId); assert.equal(second.body.replayed, true); assert.equal(counts(f.db).card_import_batches, 1);
});

test("mesma key com payload diferente retorna conflito", async (t) => {
  const f = setup(t); await post(); const conflict = await post({ ...validPayload, declaredCurrentInvoiceTotalCents: 150000 }); assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "CARD_ONBOARDING_IDEMPOTENCY_CONFLICT"); assert.equal(counts(f.db).card_import_batches, 1);
});

test("requests concorrentes não duplicam onboarding", async (t) => {
  const f = setup(t); const [first, second] = await Promise.all([post(), post()]); assert.deepEqual([first.status, second.status], [201, 201]); assert.equal(first.body.batchId, second.body.batchId); assert.equal(counts(f.db).card_import_batches, 1); assert.equal(counts(f.db).audit_logs, 1);
});

test("cartão já configurado é inelegível para nova key", async (t) => {
  const f = setup(t); await post(); const result = await post({ ...validPayload, idempotencyKey: "another-key" }); assert.equal(result.status, 409); assert.equal(result.body.code, "CARD_ONBOARDING_INELIGIBLE"); assert.equal(counts(f.db).card_import_batches, 1);
});

test("cartão com atividade incompatível é rejeitado", async (t) => {
  const f = setup(t); f.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("old", "ha", "card-a", "2026-08", "2026-08-12", "open", AT, AT);
  const result = await post(); assert.equal(result.status, 409); assert.equal(result.body.code, "CARD_ONBOARDING_INELIGIBLE"); assert.equal(counts(f.db).card_import_batches, 0);
});

test("falha interna não vaza SQL nem stack", async (t) => {
  const f = setup(t); f.d1.beforeStatement = (_statement, index) => { if (index === 2) throw new Error("SQL SELECT secret_table stack-marker"); };
  const original = console.error; console.error = () => {};
  try {
    const result = await post({ ...validPayload, existingInstallments: [installment] }); const serialized = JSON.stringify(result.body);
    assert.equal(result.status, 500); assert.doesNotMatch(serialized, /SELECT|secret_table|stack-marker/iu);
  } finally { console.error = original; }
});

test("resposta não expõe fingerprint", async (t) => {
  setup(t); const result = await post(); assert.doesNotMatch(JSON.stringify(result.body), /fingerprint/iu);
});

test("resposta não expõe idempotency key", async (t) => {
  setup(t); const result = await post(); assert.doesNotMatch(JSON.stringify(result.body), /configure-card-a|idempotency/iu);
});

test("sucesso cria exatamente um audit canônico", async (t) => {
  const f = setup(t); await post(); await post(); const audits = f.db.prepare("SELECT action, entity_type, new_data FROM audit_logs").all(); assert.equal(audits.length, 1); assert.equal(audits[0].action, "configure_initial_state"); assert.equal(audits[0].entity_type, "card_import_batch");
});

test("falha tardia causa rollback integral", async (t) => {
  const f = setup(t); const before = counts(f.db); f.d1.beforeStatement = (_statement, index) => { if (index === 3) throw new Error("late failure"); };
  const original = console.error; console.error = () => {};
  try { assert.equal((await post({ ...validPayload, existingInstallments: [installment] })).status, 500); } finally { console.error = original; }
  assert.deepEqual(counts(f.db), before);
});

test("categoria de outro household é rejeitada sem escrita", async (t) => {
  const f = setup(t); const result = await post({ ...validPayload, existingInstallments: [{ ...installment, categoryId: "category-b", subcategoryId: "subcategory-b" }] }); assert.equal(result.status, 400); assert.equal(counts(f.db).card_import_batches, 0);
});

test("GET informa elegibilidade mínima de cartão local", async (t) => {
  setup(t); const result = await eligibility(); assert.equal(result.status, 200); assert.deepEqual(result.body, { cardId: "card-a", eligible: true }); assert.equal(result.headers.get("cache-control"), "private, no-store");
});

test("GET não revela card de outro household", async (t) => {
  setup(t); const foreign = await eligibility("cardId=card-b"); const missing = await eligibility("cardId=missing"); assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, missing.body);
});

test("GET informa atividade existente sem dados financeiros", async (t) => {
  const f = setup(t); f.db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("old", "ha", "card-a", "2026-08", "2026-08-12", "open", AT, AT);
  const result = await eligibility(); assert.equal(result.status, 200); assert.deepEqual(result.body, { cardId: "card-a", eligible: false, reasonCode: "existing_activity" });
});

test("GET rejeita campos extras e membership inativa", async (t) => {
  const f = setup(t); assert.equal((await eligibility("cardId=card-a&householdId=hb")).status, 400); f.db.exec("UPDATE household_members SET status='inactive' WHERE id='ma'"); assert.equal((await eligibility()).status, 403);
});

test("parcelamento complementar sem sessão e membership inativa são rejeitados", async (t) => {
  const f = setup(t); globalThis.__cardOnboardingApiCookie = undefined;
  assert.equal((await postExisting()).status, 401);
  globalThis.__cardOnboardingApiCookie = COOKIE; f.db.exec("UPDATE household_members SET status='inactive' WHERE id='ma'");
  assert.equal((await postExisting()).status, 403); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_import_batches").get().n, 0);
});

test("API adiciona parcelamento complementar após onboarding e não expõe dados internos", async (t) => {
  const f = setup(t);
  assert.equal((await post({ ...validPayload, referenceMonth: "2026-10" })).status, 201);
  const result = await postExisting();
  assert.equal(result.status, 201); assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(result.body.importedInstallmentCount, 3); assert.equal(result.body.replayed, false);
  assert.doesNotMatch(JSON.stringify(result.body), /fingerprint|idempotency/iu);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_import_batches WHERE import_kind='existing_installments'").get().n, 1);
});

test("API complementar mantém idempotência e isolamento de household", async (t) => {
  const f = setup(t); await post({ ...validPayload, referenceMonth: "2026-10" });
  const first = await postExisting(); const replay = await postExisting();
  assert.equal(first.status, 201); assert.equal(replay.status, 201); assert.equal(replay.body.batchId, first.body.batchId); assert.equal(replay.body.replayed, true);
  const conflict = await postExisting({ ...existingInstallmentPayload, description: "Payload diferente" }); assert.equal(conflict.status, 409);
  const foreign = await postExisting({ ...existingInstallmentPayload, cardId: "card-b", idempotencyKey: "foreign-key" }); assert.equal(foreign.status, 404);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM card_import_batches WHERE import_kind='existing_installments'").get().n, 1);
});

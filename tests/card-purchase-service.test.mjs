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
const { createCardPurchase, DuplicateTelegramUpdateError } = await import("../lib/finance-service.ts?card-purchase-service");

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
  constructor(db) { this.db = db; }
  prepare(sql) { return new LocalStatement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map((statement) => statement.runSync());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

function setup() {
  const db = database();
  const at = "2026-09-14T12:00:00.000Z";
  for (const suffix of ["a", "b"]) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `User ${suffix}`, `${suffix}@example.com`, at, at);
    db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `House ${suffix}`, `u${suffix}`, at, at);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", at);
    db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`category-${suffix}`, `h${suffix}`, `Category ${suffix}`, "expense", 1, at, at);
    db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`subcategory-${suffix}`, `h${suffix}`, `category-${suffix}`, `Subcategory ${suffix}`, 1, at, at);
    db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(`card-${suffix}`, `h${suffix}`, `Card ${suffix}`, "Bank", `User ${suffix}`, 100000, 5, 12, 1, at, at);
  }
  db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("category-empty", "ha", "No subs", "expense", 1, at, at);
  db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("category-inactive", "ha", "Inactive", "expense", 0, at, at);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("subcategory-inactive", "ha", "category-a", "Inactive", 0, at, at);
  serviceEnv.DB = new LocalD1(db);
  return db;
}

const baseInput = { cardId: "card-a", description: "Purchase", totalCents: 1000, purchaseDate: "2026-09-01", installmentCount: 1, categoryId: "category-a", subcategoryId: "subcategory-a" };
const webContext = { householdId: "ha", userId: "ua", origin: "dashboard" };

test("createCardPurchase exige classificação ativa e isolada por household", async () => {
  setup();
  await assert.rejects(createCardPurchase({ ...baseInput, categoryId: null }, webContext), /categoria/iu);
  await assert.rejects(createCardPurchase({ ...baseInput, categoryId: "category-inactive", subcategoryId: null }, webContext), /Categoria inválida/iu);
  await assert.rejects(createCardPurchase({ ...baseInput, categoryId: "category-b", subcategoryId: "subcategory-b" }, webContext), /Categoria inválida/iu);
  await assert.rejects(createCardPurchase({ ...baseInput, subcategoryId: null }, webContext), /subcategoria/iu);
  await assert.rejects(createCardPurchase({ ...baseInput, subcategoryId: "subcategory-b" }, webContext), /Subcategoria inválida/iu);
  await assert.rejects(createCardPurchase({ ...baseInput, subcategoryId: "subcategory-inactive" }, webContext), /Subcategoria inválida/iu);
});

test("createCardPurchase persiste subcategoria e permite NULL quando categoria não possui subs ativas", async () => {
  const db = setup();
  await createCardPurchase(baseInput, webContext);
  await createCardPurchase({ ...baseInput, description: "No subcategory", categoryId: "category-empty", subcategoryId: null }, webContext);
  assert.deepEqual(db.prepare("SELECT category_id,subcategory_id,origin,created_by_user_id FROM card_purchases ORDER BY description").all().map((row) => ({ ...row })), [
    { category_id: "category-empty", subcategory_id: null, origin: "web", created_by_user_id: "ua" },
    { category_id: "category-a", subcategory_id: "subcategory-a", origin: "web", created_by_user_id: "ua" },
  ]);
});

test("createCardPurchase valida datas civis sem deslocamento UTC", async () => {
  const db = setup();
  for (const date of ["2027-02-29", "2026-02-31", "2026-13-10", "2026-00-10"]) await assert.rejects(createCardPurchase({ ...baseInput, purchaseDate: date }, webContext), /Data inválida/iu);
  await createCardPurchase({ ...baseInput, purchaseDate: "2028-02-29" }, webContext);
  assert.equal(db.prepare("SELECT purchase_date FROM card_purchases").get().purchase_date, "2028-02-29");
});

test("parcelas não podem superar centavos e três centavos em três parcelas permanecem válidos", async () => {
  const db = setup();
  await createCardPurchase({ ...baseInput, totalCents: 3, installmentCount: 3 }, webContext);
  assert.deepEqual(db.prepare("SELECT amount_cents FROM card_installments ORDER BY installment_number").all().map((row) => row.amount_cents), [1, 1, 1]);
  await assert.rejects(createCardPurchase({ ...baseInput, description: "Invalid", totalCents: 3, installmentCount: 4 }, webContext), /insuficiente/iu);
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 1);
});

for (const status of ["closed", "paid"]) {
  test(`createCardPurchase rejeita fatura ${status} sem persistência parcial`, async () => {
    const db = setup();
    const at = "2026-09-14T12:00:00.000Z";
    db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(`invoice-${status}`, "ha", "card-a", "2026-09", "2026-09-12", status, at, at);
    await assert.rejects(createCardPurchase(baseInput, webContext), /não está aberta/iu);
    assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 0);
    assert.equal(db.prepare("SELECT count(*) total FROM card_installments").get().total, 0);
    assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_type='card_purchase'").get().total, 0);
  });
}

test("fatura open é reutilizada e concorrência de criação preserva uma competência", async () => {
  const db = setup();
  const at = "2026-09-14T12:00:00.000Z";
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)").run("open", "ha", "card-a", "2026-09", "2026-09-12", at, at);
  await createCardPurchase(baseInput, webContext);
  assert.equal(db.prepare("SELECT invoice_id FROM card_installments").get().invoice_id, "open");

  const otherDb = setup();
  await Promise.all([
    createCardPurchase({ ...baseInput, description: "Concurrent A" }, webContext),
    createCardPurchase({ ...baseInput, description: "Concurrent B" }, webContext),
  ]);
  assert.equal(otherDb.prepare("SELECT count(*) total FROM card_invoices WHERE household_id='ha' AND card_id='card-a' AND reference_month='2026-09'").get().total, 1);
  assert.equal(otherDb.prepare("SELECT count(*) total FROM card_purchases").get().total, 2);
  assert.equal(otherDb.prepare("SELECT count(*) total FROM card_installments").get().total, 2);
});

test("guarda Telegram impede sessão antiga de criar compra ou remover state novo", async () => {
  const db = setup();
  const at = "2026-09-14T12:00:00.000Z";
  db.prepare("INSERT INTO telegram_conversation_states(telegram_user_id,household_id,payload_json,expires_at,updated_at) VALUES(?,?,?,?,?)").run("42", "ha", JSON.stringify({ sessionId: "NEWSESSION" }), "2026-09-15T12:00:00.000Z", at);
  await assert.rejects(createCardPurchase(baseInput, { householdId: "ha", userId: "ua", origin: "telegram", source: { updateId: "9001", operationId: "OLDSESSION", telegramUserId: "42" }, clearTelegramStateFor: "42" }), DuplicateTelegramUpdateError);
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_type='card_purchase'").get().total, 0);
  assert.equal(JSON.parse(db.prepare("SELECT payload_json FROM telegram_conversation_states WHERE telegram_user_id='42'").get().payload_json).sessionId, "NEWSESSION");
});

test("falha tardia na auditoria reverte markers, compra, fatura, parcelas e remoção do state", async () => {
  const db = setup();
  const at = "2026-09-14T12:00:00.000Z";
  db.prepare("INSERT INTO telegram_conversation_states(telegram_user_id,household_id,payload_json,expires_at,updated_at) VALUES(?,?,?,?,?)").run("42", "ha", JSON.stringify({ sessionId: "SESSIONLATE" }), "2026-09-15T12:00:00.000Z", at);
  db.exec("CREATE TEMP TRIGGER reject_card_purchase_audit BEFORE INSERT ON audit_logs WHEN NEW.entity_type = 'card_purchase' BEGIN SELECT RAISE(ABORT, 'forced late audit failure'); END");

  await assert.rejects(createCardPurchase(baseInput, { householdId: "ha", userId: "ua", origin: "telegram", source: { updateId: "9002", operationId: "SESSIONLATE", telegramUserId: "42" }, clearTelegramStateFor: "42" }), /forced late audit failure/iu);

  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id IN ('9002','financial:SESSIONLATE')").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM card_invoices").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM card_installments").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_type='card_purchase'").get().total, 0);
  const state = db.prepare("SELECT payload_json FROM telegram_conversation_states WHERE telegram_user_id='42' AND household_id='ha'").get();
  assert.equal(JSON.parse(state.payload_json).sessionId, "SESSIONLATE");
});

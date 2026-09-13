import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createSubcategory, setSubcategoryActive, SubcategoryServiceError, subcategoryIsInUse, updateSubcategory } from "../lib/subcategory-service.ts";

const AT = "2026-09-13T15:00:00.000Z";

class LocalStatement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new LocalStatement(this.db, this.sql, bindings); }
  async first() { return this.db.prepare(this.sql).get(...this.bindings) ?? null; }
  async run() { const result = this.db.prepare(this.sql).run(...this.bindings); return { success: true, results: [], meta: { changes: result.changes } }; }
}

class LocalD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new LocalStatement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        const result = this.db.prepare(statement.sql).run(...statement.bindings);
        results.push({ success: true, results: [], meta: { changes: result.changes } });
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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

function seedHousehold(db, suffix) {
  const ids = { user: `user_${suffix}`, household: `house_${suffix}`, account: `account_${suffix}`, category: `category_${suffix}`, otherCategory: `category_${suffix}_other`, inactiveCategory: `category_${suffix}_inactive` };
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(ids.user, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(ids.household, `House ${suffix}`, ids.user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member_${suffix}`, ids.household, ids.user, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(ids.account, ids.household, "Conta", "bank", 0, 1, AT, AT);
  for (const [id, active] of [[ids.category, 1], [ids.otherCategory, 1], [ids.inactiveCategory, 0]]) db.prepare("INSERT INTO categories(id,household_id,name,type,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, ids.household, id, "expense", active, AT, AT);
  return ids;
}

function context(db, ids) { return { d1: new LocalD1(db), householdId: ids.household, userId: ids.user, timestamp: AT }; }
function serviceError(status, code) { return (error) => error instanceof SubcategoryServiceError && error.status === status && (!code || error.code === code); }

async function create(db, ids, name = "Mercado", categoryId = ids.category) {
  return createSubcategory({ name, categoryId }, context(db, ids));
}

function insertTransaction(db, ids, subcategoryId) {
  db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,category_id,subcategory_id,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`tx_${crypto.randomUUID()}`, ids.household, "expense", 1000, "Histórico", ids.category, subcategoryId, "2026-09-13", ids.user, ids.account, "confirmed", "dashboard", AT, AT);
}

function insertBill(db, ids, subcategoryId) {
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,subcategory_id,due_date,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`bill_${crypto.randomUUID()}`, ids.household, "Histórico", 1000, ids.category, subcategoryId, "2026-09-20", "none", "pending", ids.user, "web", AT, AT);
}

function insertSeries(db, ids, subcategoryId) {
  db.prepare("INSERT INTO recurring_bill_series(id,household_id,description,amount_cents,category_id,subcategory_id,day_of_month,starts_on,is_active,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`series_${crypto.randomUUID()}`, ids.household, "Histórico", 1000, ids.category, subcategoryId, 20, "2026-09-20", 1, ids.user, "web", AT, AT);
}

test("cria subcategoria válida com trim e auditoria", async () => {
  const db = database(); const a = seedHousehold(db, "a");
  const created = await create(db, a, "  Mercado  ");
  assert.equal(created.name, "Mercado");
  assert.deepEqual({ ...db.prepare("SELECT name,category_id,is_active FROM subcategories WHERE id=?").get(created.id) }, { name: "Mercado", category_id: a.category, is_active: 1 });
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_type='subcategory' AND entity_id=?").get(created.id).total, 1);
});

test("rejeita nome vazio e membership inativa", async () => {
  const db = database(); const a = seedHousehold(db, "a");
  await assert.rejects(create(db, a, "   "), serviceError(400));
  db.prepare("UPDATE household_members SET status='inactive' WHERE household_id=?").run(a.household);
  await assert.rejects(create(db, a, "Mercado"), serviceError(403));
});

test("rejeita duplicidade case-insensitive inclusive sob tentativas concorrentes", async () => {
  const db = database(); const a = seedHousehold(db, "a");
  const attempts = await Promise.allSettled([create(db, a, "Mercado"), create(db, a, "MERCADO")]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  assert.ok(rejected && serviceError(409, "SUBCATEGORY_DUPLICATE")(rejected.reason));
  assert.equal(db.prepare("SELECT count(*) total FROM subcategories WHERE household_id=? AND category_id=?").get(a.household, a.category).total, 1);
});

test("permite o mesmo nome em categorias diferentes", async () => {
  const db = database(); const a = seedHousehold(db, "a");
  await create(db, a, "Mercado", a.category);
  await create(db, a, "mercado", a.otherCategory);
  assert.equal(db.prepare("SELECT count(*) total FROM subcategories WHERE household_id=?").get(a.household).total, 2);
});

test("rejeita categoria inativa ou de outro household", async () => {
  const db = database(); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b");
  await assert.rejects(create(db, a, "Teste", a.inactiveCategory), serviceError(400, "SUBCATEGORY_CATEGORY_INVALID"));
  await assert.rejects(create(db, a, "Teste", b.category), serviceError(400, "SUBCATEGORY_CATEGORY_INVALID"));
});

test("edita nome e move subcategoria ainda sem histórico", async () => {
  const db = database(); const a = seedHousehold(db, "a"); const created = await create(db, a);
  const updated = await updateSubcategory({ id: created.id, name: "  Supermercado ", categoryId: a.otherCategory }, context(db, a));
  assert.equal(updated.name, "Supermercado");
  assert.equal(updated.categoryId, a.otherCategory);
  assert.equal(updated.isInUse, false);
});

test("não edita subcategoria pertencente a outro household", async () => {
  const db = database(); const a = seedHousehold(db, "a"); const b = seedHousehold(db, "b"); const foreign = await create(db, b);
  await assert.rejects(updateSubcategory({ id: foreign.id, name: "Inválida", categoryId: a.category }, context(db, a)), serviceError(404));
});

for (const [label, insertUsage] of [["transaction", insertTransaction], ["bill", insertBill], ["série recorrente", insertSeries]]) {
  test(`impede mover subcategoria utilizada por ${label}`, async () => {
    const db = database(); const a = seedHousehold(db, "a"); const created = await create(db, a);
    insertUsage(db, a, created.id);
    assert.equal(await subcategoryIsInUse(context(db, a), created.id), true);
    await assert.rejects(updateSubcategory({ id: created.id, name: "Mercado", categoryId: a.otherCategory }, context(db, a)), serviceError(409, "SUBCATEGORY_IN_USE"));
    assert.equal(db.prepare("SELECT category_id FROM subcategories WHERE id=?").get(created.id).category_id, a.category);
  });
}

test("permite renomear subcategoria utilizada sem alterar vínculos históricos", async () => {
  const db = database(); const a = seedHousehold(db, "a"); const created = await create(db, a); insertTransaction(db, a, created.id);
  await updateSubcategory({ id: created.id, name: "Compras de mercado", categoryId: a.category }, context(db, a));
  assert.equal(db.prepare("SELECT subcategory_id FROM transactions LIMIT 1").get().subcategory_id, created.id);
});

test("desativa sem excluir e preserva histórico e relatórios por nome", async () => {
  const db = database(); const a = seedHousehold(db, "a"); const created = await create(db, a); insertTransaction(db, a, created.id); insertBill(db, a, created.id); insertSeries(db, a, created.id);
  await setSubcategoryActive({ id: created.id, isActive: false }, context(db, a));
  assert.equal(db.prepare("SELECT is_active FROM subcategories WHERE id=?").get(created.id).is_active, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM subcategories WHERE id=?").get(created.id).total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM subcategories WHERE id=? AND is_active=1").get(created.id).total, 0);
  assert.equal(db.prepare("SELECT s.name FROM transactions t JOIN subcategories s ON s.id=t.subcategory_id WHERE t.subcategory_id=?").get(created.id).name, "Mercado");
  assert.equal(db.prepare("SELECT subcategory_id FROM bills LIMIT 1").get().subcategory_id, created.id);
  assert.equal(db.prepare("SELECT subcategory_id FROM recurring_bill_series LIMIT 1").get().subcategory_id, created.id);
});

test("reativa subcategoria quando a categoria pai está ativa", async () => {
  const db = database(); const a = seedHousehold(db, "a"); const created = await create(db, a);
  await setSubcategoryActive({ id: created.id, isActive: false }, context(db, a));
  await setSubcategoryActive({ id: created.id, isActive: true }, context(db, a));
  assert.equal(db.prepare("SELECT is_active FROM subcategories WHERE id=?").get(created.id).is_active, 1);
});

test("rejeita reativação se a categoria pai estiver inativa", async () => {
  const db = database(); const a = seedHousehold(db, "a"); const created = await create(db, a);
  await setSubcategoryActive({ id: created.id, isActive: false }, context(db, a));
  db.prepare("UPDATE categories SET is_active=0 WHERE id=?").run(a.category);
  await assert.rejects(setSubcategoryActive({ id: created.id, isActive: true }, context(db, a)), serviceError(400, "SUBCATEGORY_CATEGORY_INVALID"));
  assert.equal(db.prepare("SELECT is_active FROM subcategories WHERE id=?").get(created.id).is_active, 0);
});

test("serviço não possui exclusão física de subcategorias", () => {
  const source = readFileSync(new URL("../lib/subcategory-service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DELETE\s+FROM\s+subcategories/i);
  assert.match(source, /subcategories_household_category_name_unique/);
  assert.match(source, /COLLATE NOCASE/);
});

test("API deriva household da membership e rejeita householdId no payload estrito", () => {
  const source = readFileSync(new URL("../app/api/finance/route.ts", import.meta.url), "utf8");
  assert.match(source, /const householdId = membership\.householdId/);
  assert.match(source, /z\.literal\("create_subcategory"\).*\.strict\(\)/s);
  assert.match(source, /SubcategoryServiceError/);
  assert.doesNotMatch(source, /createSubcategory\([^\n]*body\.householdId/);
});

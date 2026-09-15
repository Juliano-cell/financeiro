import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

function applyMigration(db, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
}

function databaseThrough(lastMigration) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) {
    applyMigration(db, name);
    if (name === lastMigration) break;
  }
  return db;
}

function seedHousehold(db, suffix) {
  const at = "2026-09-14T12:00:00.000Z";
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `User ${suffix}`, `${suffix}@example.com`, at, at);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `House ${suffix}`, `u${suffix}`, at, at);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", at);
  db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`c${suffix}`, `h${suffix}`, `Category ${suffix}`, "expense", at, at);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`s${suffix}`, `h${suffix}`, `c${suffix}`, `Subcategory ${suffix}`, at, at);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`card${suffix}`, `h${suffix}`, `Card ${suffix}`, "Bank", `User ${suffix}`, 100000, 5, 12, at, at);
}

function insertPurchase(db, { id, householdId, cardId, categoryId, subcategoryId = null, userId }) {
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,subcategory_id,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, householdId, cardId, id, 1000, "2026-09-14", 1, categoryId, subcategoryId, "active", userId, "web", "2026-09-14T12:00:00.000Z", "2026-09-14T12:00:00.000Z");
}

test("0004 adiciona subcategoria nullable e preserva compra legada", () => {
  const db = databaseThrough("0003_bill_subcategories.sql");
  seedHousehold(db, "a");
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("legacy", "ha", "carda", "Legacy", 1000, "2026-09-14", 1, "ca", "active", "ua", "web", "2026-09-14T12:00:00.000Z", "2026-09-14T12:00:00.000Z");

  applyMigration(db, "0004_card_purchase_subcategories.sql");

  const column = db.prepare("PRAGMA table_info(card_purchases)").all().find((item) => item.name === "subcategory_id");
  assert.equal(column.notnull, 0);
  assert.equal(db.prepare("SELECT subcategory_id FROM card_purchases WHERE id='legacy'").get().subcategory_id, null);
  assert.ok(db.prepare("PRAGMA foreign_key_list(card_purchases)").all().some((key) => key.from === "subcategory_id" && key.table === "subcategories"));
  assert.equal(db.prepare("SELECT count(*) total FROM sqlite_master WHERE type='index' AND name='idx_card_purchases_household_subcategory'").get().total, 1);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("0004 protege household, categoria e subcategoria em insert e update", () => {
  const db = databaseThrough("0004_card_purchase_subcategories.sql");
  seedHousehold(db, "a");
  seedHousehold(db, "b");
  const at = "2026-09-14T12:00:00.000Z";
  db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("ca2", "ha", "Other A", "expense", at, at);
  insertPurchase(db, { id: "valid", householdId: "ha", cardId: "carda", categoryId: "ca", subcategoryId: "sa", userId: "ua" });
  assert.throws(() => insertPurchase(db, { id: "cross", householdId: "ha", cardId: "carda", categoryId: "ca", subcategoryId: "sb", userId: "ua" }), /does not belong/);
  assert.throws(() => insertPurchase(db, { id: "mismatch", householdId: "ha", cardId: "carda", categoryId: "ca2", subcategoryId: "sa", userId: "ua" }), /does not belong/);
  assert.throws(() => db.prepare("UPDATE card_purchases SET subcategory_id=? WHERE id=?").run("sb", "valid"), /does not belong/);
  assert.throws(() => db.prepare("UPDATE card_purchases SET category_id=? WHERE id=?").run("ca2", "valid"), /does not belong/);
});

test("schema Drizzle permanece alinhado à coluna e ao índice da 0004", () => {
  const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
  assert.match(schema, /subcategoryId: text\("subcategory_id"\)\.references\(\(\) => subcategories\.id\)/u);
  assert.match(schema, /idx_card_purchases_household_subcategory/u);
});

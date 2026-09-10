import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function database() {
  const db = new DatabaseSync(":memory:");
  const migration = readFileSync(new URL("../drizzle/0000_family_finance.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  const timestamp = "2026-09-10T12:00:00.000Z";
  db.prepare("INSERT INTO users (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user_juliano", "Juliano", "juliano@example.com", timestamp, timestamp);
  db.prepare("INSERT INTO households (id,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?)").run("house_a", "Família A", "user_juliano", timestamp, timestamp);
  db.prepare("INSERT INTO household_members (id,household_id,user_id,invited_email,role,status,joined_at,created_at) VALUES (?,?,?,?,?,?,?,?)").run("member_a", "house_a", "user_juliano", "juliano@example.com", "owner", "active", timestamp, timestamp);
  db.prepare("INSERT INTO accounts (id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("account_a", "house_a", "Conta", "bank", 50000, 1, timestamp, timestamp);
  return db;
}

function balance(db, householdId = "house_a") {
  return db.prepare("SELECT a.initial_balance_cents + COALESCE(SUM(CASE WHEN t.status='confirmed' AND t.type='income' THEN t.amount_cents WHEN t.status='confirmed' AND t.type='expense' THEN -t.amount_cents ELSE 0 END),0) AS balance FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id AND t.household_id=a.household_id WHERE a.household_id=? GROUP BY a.id").get(householdId)?.balance ?? 0;
}

test("a migração cria todas as tabelas principais da Fase 1", () => {
  const db = database();
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name);
  for (const name of ["users", "households", "household_members", "accounts", "categories", "subcategories", "transactions", "audit_logs"]) assert.ok(names.includes(name), `missing ${name}`);
});

test("entradas e saídas confirmadas atualizam o saldo sem ponto flutuante", () => {
  const db = database(); const timestamp = "2026-09-10T12:00:00.000Z";
  const insert = db.prepare("INSERT INTO transactions (id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  insert.run("income_1", "house_a", "income", 20000, "Diária", "2026-09-10", "user_juliano", "account_a", "confirmed", "dashboard", timestamp, timestamp);
  insert.run("expense_1", "house_a", "expense", 10000, "Gasolina", "2026-09-10", "user_juliano", "account_a", "confirmed", "dashboard", timestamp, timestamp);
  assert.equal(balance(db), 60000);
});

test("pendente não altera saldo; editar e excluir recalculam corretamente", () => {
  const db = database(); const timestamp = "2026-09-10T12:00:00.000Z";
  db.prepare("INSERT INTO transactions (id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("expense_1", "house_a", "expense", 10000, "Mercado", "2026-09-10", "user_juliano", "account_a", "pending", "dashboard", timestamp, timestamp);
  assert.equal(balance(db), 50000);
  db.prepare("UPDATE transactions SET status='confirmed', amount_cents=12000 WHERE id='expense_1'").run();
  assert.equal(balance(db), 38000);
  db.prepare("DELETE FROM transactions WHERE id='expense_1'").run();
  assert.equal(balance(db), 50000);
});

test("consultas com household impedem vazamento entre famílias", () => {
  const db = database(); const timestamp = "2026-09-10T12:00:00.000Z";
  db.prepare("INSERT INTO users (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user_other", "Outro", "outro@example.com", timestamp, timestamp);
  db.prepare("INSERT INTO households (id,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?)").run("house_b", "Família B", "user_other", timestamp, timestamp);
  db.prepare("INSERT INTO accounts (id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("account_b", "house_b", "Conta B", "bank", 999999, 1, timestamp, timestamp);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE household_id=?").get("house_a").count, 1);
  assert.equal(balance(db, "house_a"), 50000);
});

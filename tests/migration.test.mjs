import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { backupToSql } from "../scripts/backup-to-sql.mjs";

function emptyDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    const migration = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

test("backup familiar gera SQL importável sem credenciais ou sessões", () => {
  const timestamp = "2026-09-11T00:00:00.000Z";
  const backup = {
    format: "nossa-casa-family-backup", version: 1, householdId: "house_a",
    security: { credentialsIncluded: false, sessionsIncluded: false },
    tables: {
      users: [{ id: "user_a", name: "Família d'Ávila", email: "a@example.com", avatarUrl: null, status: "active", createdAt: timestamp, updatedAt: timestamp }],
      households: [{ id: "house_a", name: "Família A", createdBy: "user_a", createdAt: timestamp, updatedAt: timestamp }],
      household_members: [{ id: "member_a", householdId: "house_a", userId: "user_a", invitedEmail: "a@example.com", role: "owner", status: "active", joinedAt: timestamp, createdAt: timestamp }],
      accounts: [{ id: "account_a", householdId: "house_a", name: "Conta", type: "bank", initialBalanceCents: 50000, isActive: true, createdAt: timestamp, updatedAt: timestamp }],
      categories: [], subcategories: [], transactions: [], audit_logs: [],
    },
  };
  const sql = backupToSql(backup);
  assert.doesNotMatch(sql, /password_credentials|sessions/);
  assert.match(sql, /INSERT OR IGNORE INTO `users`/);
  const db = emptyDatabase();
  db.exec(sql);
  assert.equal(db.prepare("SELECT name FROM users WHERE id='user_a'").get().name, "Família d'Ávila");
  assert.equal(db.prepare("SELECT initial_balance_cents FROM accounts WHERE id='account_a'").get().initial_balance_cents, 50000);
});

test("conversor rejeita backup de formato desconhecido", () => {
  assert.throws(() => backupToSql({ format: "desconhecido", version: 1, tables: {} }), /incompatível/);
});

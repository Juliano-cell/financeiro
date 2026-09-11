import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PASSWORD_HASH_ITERATIONS, digestToken, generateOpaqueToken, generateRecoveryCode, hashPassword, normalizeRecoveryCode, verifyPassword } from "../lib/auth-crypto.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    const migration = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

const now = "2026-09-10T12:00:00.000Z";

async function createAccount(db, id, email, password = "Senha segura 123") {
  const passwordHash = await hashPassword(password, 100_000);
  const recoveryCode = generateRecoveryCode();
  const recoveryHash = await digestToken(normalizeRecoveryCode(recoveryCode));
  db.prepare("INSERT INTO users (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, id, email, now, now);
  db.prepare("INSERT INTO password_credentials (user_id,password_hash,password_changed_at,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, passwordHash, now, now, now);
  db.prepare("INSERT INTO password_recovery_codes (user_id,code_hash,created_at,updated_at) VALUES (?,?,?,?)").run(id, recoveryHash, now, now);
  return { passwordHash, recoveryCode, recoveryHash };
}

test("cadastro guarda hash seguro e nunca a senha em texto puro", async () => {
  assert.equal(PASSWORD_HASH_ITERATIONS, 100_000, "Cloudflare Workers aceita no máximo 100.000 iterações de PBKDF2");
  const db = database();
  const account = await createAccount(db, "user_a", "a@example.com");
  const stored = db.prepare("SELECT password_hash FROM password_credentials WHERE user_id=?").get("user_a").password_hash;
  assert.notEqual(stored, "Senha segura 123");
  assert.match(stored, /^pbkdf2-sha256\$100000\$/);
  assert.equal(await verifyPassword("Senha segura 123", account.passwordHash), true);
  assert.equal(await verifyPassword("senha errada", account.passwordHash), false);
});

test("login cria sessão usando somente o hash do token", async () => {
  const db = database();
  const { passwordHash } = await createAccount(db, "user_a", "a@example.com");
  assert.equal(await verifyPassword("Senha segura 123", passwordHash), true);
  const rawToken = generateOpaqueToken();
  const tokenHash = await digestToken(rawToken);
  db.prepare("INSERT INTO sessions (id,user_id,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?)").run(tokenHash, "user_a", "2026-09-17T12:00:00.000Z", now, now);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id=?").get(rawToken).count, 0);
  assert.equal(db.prepare("SELECT user_id FROM sessions WHERE id=? AND revoked_at IS NULL").get(tokenHash).user_id, "user_a");
});

test("logout revoga a sessão atual", async () => {
  const db = database();
  await createAccount(db, "user_a", "a@example.com");
  const tokenHash = await digestToken(generateOpaqueToken());
  db.prepare("INSERT INTO sessions (id,user_id,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?)").run(tokenHash, "user_a", "2026-09-17T12:00:00.000Z", now, now);
  db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run("2026-09-10T13:00:00.000Z", tokenHash);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id=? AND revoked_at IS NULL").get(tokenHash).count, 0);
});

test("recuperação troca senha e código e revoga sessões anteriores", async () => {
  const db = database();
  const account = await createAccount(db, "user_a", "a@example.com");
  const tokenHash = await digestToken(generateOpaqueToken());
  db.prepare("INSERT INTO sessions (id,user_id,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?)").run(tokenHash, "user_a", "2026-09-17T12:00:00.000Z", now, now);
  assert.equal(await digestToken(normalizeRecoveryCode(account.recoveryCode)), account.recoveryHash);
  const newPasswordHash = await hashPassword("Nova senha segura 456", 100_000);
  const newRecoveryHash = await digestToken(normalizeRecoveryCode(generateRecoveryCode()));
  db.prepare("UPDATE password_credentials SET password_hash=?,password_changed_at=?,updated_at=? WHERE user_id=?").run(newPasswordHash, now, now, "user_a");
  db.prepare("UPDATE password_recovery_codes SET code_hash=?,updated_at=? WHERE user_id=?").run(newRecoveryHash, now, "user_a");
  db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(now, "user_a");
  assert.equal(await verifyPassword("Senha segura 123", newPasswordHash), false);
  assert.equal(await verifyPassword("Nova senha segura 456", newPasswordHash), true);
  assert.notEqual(newRecoveryHash, account.recoveryHash);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id=? AND revoked_at IS NULL").get("user_a").count, 0);
});

test("sessão acessa somente a família vinculada ao usuário", async () => {
  const db = database();
  await createAccount(db, "user_a", "a@example.com");
  await createAccount(db, "user_b", "b@example.com");
  db.prepare("INSERT INTO households (id,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?)").run("house_a", "Família A", "user_a", now, now);
  db.prepare("INSERT INTO households (id,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?)").run("house_b", "Família B", "user_b", now, now);
  db.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,joined_at,created_at) VALUES (?,?,?,?,?,?,?)").run("member_a", "house_a", "user_a", "owner", "active", now, now);
  db.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,joined_at,created_at) VALUES (?,?,?,?,?,?,?)").run("member_b", "house_b", "user_b", "owner", "active", now, now);
  db.prepare("INSERT INTO accounts (id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("account_a", "house_a", "Conta A", "bank", 100, 1, now, now);
  db.prepare("INSERT INTO accounts (id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("account_b", "house_b", "Conta B", "bank", 999, 1, now, now);
  const householdId = db.prepare("SELECT household_id FROM household_members WHERE user_id=? AND status='active'").get("user_a").household_id;
  const visible = db.prepare("SELECT id FROM accounts WHERE household_id=?").all(householdId).map((row) => row.id);
  assert.deepEqual(visible, ["account_a"]);
});

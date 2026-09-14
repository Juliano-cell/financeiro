import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

function seed(db) {
  const at = "2026-09-14T12:00:00.000Z";
  for (const [userId, householdId] of [["user-a", "house-a"], ["user-c", "house-b"]]) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(userId, userId, `${userId}@example.com`, at, at);
    db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(householdId, householdId, userId, at, at);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,joined_at,created_at) VALUES(?,?,?,?,?,?,?)").run(`member-${userId}`, householdId, userId, "owner", "active", at, at);
  }
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("user-b", "user-b", "user-b@example.com", at, at);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,joined_at,created_at) VALUES(?,?,?,?,?,?,?)").run("member-user-b", "house-a", "user-b", "member", "active", at, at);
  for (const [suffix, householdId, userId, telegramId] of [["a", "house-a", "user-a", "telegram-a"], ["b", "house-a", "user-b", "telegram-b"], ["c", "house-b", "user-c", "telegram-c"]]) {
    db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,is_active,linked_at,updated_at) VALUES(?,?,?,?,?,1,?,?)").run(`link-${suffix}`, householdId, userId, telegramId, `chat-${suffix}`, at, at);
    db.prepare("INSERT INTO telegram_link_codes(id,household_id,user_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)").run(`code-${suffix}`, householdId, userId, `hash-${suffix}`, "2026-09-14T13:00:00.000Z", at);
    db.prepare("INSERT INTO telegram_conversation_states(telegram_user_id,household_id,payload_json,expires_at,updated_at) VALUES(?,?,?,?,?)").run(telegramId, householdId, "{}", "2026-09-14T13:00:00.000Z", at);
  }
  return at;
}

function connected(db, householdId, userId) {
  return Boolean(db.prepare("SELECT id FROM telegram_links WHERE household_id=? AND user_id=? AND is_active=1 LIMIT 1").get(householdId, userId));
}

function disconnect(db, householdId, userId, at) {
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at) SELECT ?, ?, ?, 'unlink', 'telegram_link', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM telegram_links WHERE household_id = ? AND user_id = ? AND is_active = 1)").run(`audit-${crypto.randomUUID()}`, householdId, userId, userId, '{"connected":true}', '{"connected":false}', at, householdId, userId);
    db.prepare("DELETE FROM telegram_conversation_states WHERE household_id = ? AND telegram_user_id IN (SELECT telegram_user_id FROM telegram_links WHERE household_id = ? AND user_id = ? AND is_active = 1)").run(householdId, householdId, userId);
    db.prepare("UPDATE telegram_link_codes SET used_at = ? WHERE household_id = ? AND user_id = ? AND used_at IS NULL").run(at, householdId, userId);
    db.prepare("UPDATE telegram_links SET is_active = 0, updated_at = ? WHERE household_id = ? AND user_id = ? AND is_active = 1").run(at, householdId, userId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("status distingue usuário conectado e desconectado sem misturar households", () => {
  const db = database(); seed(db);
  assert.equal(connected(db, "house-a", "user-a"), true);
  assert.equal(connected(db, "house-a", "user-c"), false);
  assert.equal(connected(db, "house-b", "user-a"), false);
  db.prepare("UPDATE telegram_links SET is_active=0 WHERE id='link-a'").run();
  assert.equal(connected(db, "house-a", "user-a"), false);
});

test("desvinculação desativa somente o usuário correto e preserva outros membros", () => {
  const db = database(); const at = seed(db);
  disconnect(db, "house-a", "user-a", at);
  assert.equal(connected(db, "house-a", "user-a"), false);
  assert.equal(connected(db, "house-a", "user-b"), true);
  assert.equal(connected(db, "house-b", "user-c"), true);
  assert.equal(db.prepare("SELECT is_active FROM telegram_links WHERE id='link-b'").get().is_active, 1);
  assert.equal(db.prepare("SELECT is_active FROM telegram_links WHERE id='link-c'").get().is_active, 1);
});

test("desvinculação invalida códigos, limpa estado e registra auditoria sem IDs do Telegram", () => {
  const db = database(); const at = seed(db);
  disconnect(db, "house-a", "user-a", at);
  assert.notEqual(db.prepare("SELECT used_at FROM telegram_link_codes WHERE id='code-a'").get().used_at, null);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states WHERE telegram_user_id='telegram-a'").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states WHERE telegram_user_id IN ('telegram-b','telegram-c')").get().total, 2);
  const audit = db.prepare("SELECT action,old_data,new_data FROM audit_logs WHERE household_id='house-a' AND user_id='user-a' AND entity_type='telegram_link'").get();
  assert.equal(audit.action, "unlink");
  assert.equal(audit.old_data, '{"connected":true}');
  assert.equal(audit.new_data, '{"connected":false}');
  assert.doesNotMatch(`${audit.old_data}${audit.new_data}`, /telegram-a|chat-a/);
});

test("DELETE sem vínculo ativo é idempotente e ainda invalida código pendente", () => {
  const db = database(); const at = seed(db);
  disconnect(db, "house-a", "user-a", at);
  assert.doesNotThrow(() => disconnect(db, "house-a", "user-a", "2026-09-14T12:01:00.000Z"));
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE household_id='house-a' AND user_id='user-a' AND action='unlink'").get().total, 1);
  assert.equal(db.prepare("SELECT used_at FROM telegram_link_codes WHERE id='code-a'").get().used_at, at);
});

test("após desvincular é possível gerar código e reativar o mesmo vínculo", () => {
  const db = database(); const at = seed(db);
  assert.equal(connected(db, "house-a", "user-a"), true, "geração deve permanecer bloqueada enquanto houver vínculo ativo");
  disconnect(db, "house-a", "user-a", at);
  assert.equal(connected(db, "house-a", "user-a"), false);
  db.prepare("INSERT INTO telegram_link_codes(id,household_id,user_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)").run("new-code", "house-a", "user-a", "new-hash", "2026-09-14T14:00:00.000Z", at);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_link_codes WHERE user_id='user-a' AND used_at IS NULL").get().total, 1);
  db.prepare("UPDATE telegram_links SET is_active=1,chat_id='new-chat',updated_at=? WHERE telegram_user_id='telegram-a' AND household_id='house-a' AND user_id='user-a'").run(at);
  assert.equal(connected(db, "house-a", "user-a"), true);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_links WHERE user_id='user-a'").get().total, 1);
});

test("backend deriva identidade da sessão e não expõe IDs sensíveis", () => {
  const route = readFileSync(new URL("../app/api/telegram/link/route.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../lib/telegram-link-service.ts", import.meta.url), "utf8");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(service, /eq\(householdMembers\.status, "active"\)/);
  assert.match(service, /eq\(telegramLinks\.userId, userId\)/);
  assert.match(service, /eq\(telegramLinks\.householdId, membership\.householdId\)/);
  assert.match(service, /d1\.batch/);
  assert.match(service, /UPDATE telegram_links SET is_active = 0/);
  assert.match(service, /UPDATE telegram_link_codes SET used_at/);
  assert.match(service, /DELETE FROM telegram_conversation_states/);
  assert.match(service, /INSERT INTO audit_logs/);
  assert.match(service, /NOT EXISTS \(SELECT 1 FROM telegram_links AS active_link/);
  assert.match(service, /if \(linked\) throw new FinanceValidationError\("Este usuário já possui um Telegram conectado\."\)/);
  assert.doesNotMatch(route, /request\.json|householdId|userId|telegram_user_id|chat_id/);
  assert.match(route, /Cache-Control.*private, no-store/);
});

test("frontend exibe ações mutuamente exclusivas conforme o status real", () => {
  const frontend = readFileSync(new URL("../app/advanced-finance.tsx", import.meta.url), "utf8");
  const connectedBranch = frontend.slice(frontend.indexOf('connection === "connected"'), frontend.indexOf('connection === "disconnected"'));
  const disconnectedBranch = frontend.slice(frontend.indexOf('connection === "disconnected"'), frontend.indexOf("</div></div><form", frontend.indexOf('connection === "disconnected"')));
  assert.match(frontend, /Verificando conexão\.\.\./);
  assert.match(frontend, /fetch\("\/api\/telegram\/link"/);
  assert.match(connectedBranch, /Telegram conectado/);
  assert.match(connectedBranch, /Desvincular Telegram/);
  assert.doesNotMatch(connectedBranch, /Gerar código de conexão/);
  assert.match(disconnectedBranch, /Telegram não conectado/);
  assert.match(disconnectedBranch, /Gerar código de conexão/);
  assert.doesNotMatch(disconnectedBranch, /Desvincular Telegram/);
  assert.doesNotMatch(frontend, /telegramUserId|chatId|householdId/);
});

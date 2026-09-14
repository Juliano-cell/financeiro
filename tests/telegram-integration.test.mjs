import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { hasTelegramDeliveryFailure } from "../lib/telegram-delivery.mjs";
import { classifyTelegramUpdate } from "../lib/telegram-update.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

function seed(db) {
  const at = "2026-09-11T12:00:00.000Z";
  for (const suffix of ["a", "b"]) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `User ${suffix}`, `${suffix}@example.com`, at, at);
    db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `House ${suffix}`, `u${suffix}`, at, at);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,joined_at,created_at) VALUES(?,?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", at, at);
    db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`a${suffix}`, `h${suffix}`, `Account ${suffix}`, "bank", at, at);
  }
  return at;
}

function atomic(db, operation) {
  db.exec("BEGIN");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

test("vínculo Telegram não aceita usuário de outro household", () => {
  const db = database(); const at = seed(db);
  assert.throws(() => db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("link", "ha", "ub", "42", "42", at, at), /FOREIGN KEY/);
});

test("usuário Telegram não vinculado não resolve família nem conta", () => {
  const db = database(); seed(db);
  const link = db.prepare("SELECT household_id,user_id FROM telegram_links WHERE telegram_user_id=? AND chat_id=? AND is_active=1").get("999", "999");
  assert.equal(link, undefined);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE origin='telegram'").get().total, 0);
});

test("código expirado ou consumido não satisfaz o consumo condicional", () => {
  const db = database(); const at = seed(db);
  db.prepare("INSERT INTO telegram_link_codes(id,household_id,user_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)").run("expired", "ha", "ua", "hash-1", "2026-09-11T11:00:00.000Z", at);
  db.prepare("INSERT INTO telegram_link_codes(id,household_id,user_id,code_hash,expires_at,used_at,created_at) VALUES(?,?,?,?,?,?,?)").run("used", "ha", "ua", "hash-2", "2026-09-11T13:00:00.000Z", at, at);
  const consume = db.prepare("UPDATE telegram_link_codes SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?");
  assert.equal(consume.run(at, "expired", at).changes, 0);
  assert.equal(consume.run(at, "used", at).changes, 0);
});

test("confirmação atômica cria transação, auditoria e update uma única vez", () => {
  const db = database(); const at = seed(db);
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("link", "ha", "ua", "42", "42", at, at);
  db.prepare("INSERT INTO telegram_conversation_states(telegram_user_id,household_id,payload_json,expires_at,updated_at) VALUES(?,?,?,?,?)").run("42", "ha", "{}", "2026-09-11T13:00:00.000Z", at);
  const confirm = (updateId, transactionId) => atomic(db, () => {
    db.prepare("INSERT INTO telegram_processed_updates(update_id,received_at) VALUES(?,?)").run(updateId, at);
    db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(transactionId, "ha", "expense", 8_500, "Mercado", "2026-09-11", "ua", "aa", "confirmed", "telegram", at, at);
    db.prepare("INSERT INTO audit_logs(id,household_id,user_id,action,entity_type,entity_id,new_data,created_at) VALUES(?,?,?,?,?,?,?,?)").run(`audit-${transactionId}`, "ha", "ua", "create", "transaction", transactionId, JSON.stringify({ source: { originalTelegramUpdateId: "100" } }), at);
    db.prepare("DELETE FROM telegram_conversation_states WHERE telegram_user_id=? AND household_id=?").run("42", "ha");
  });
  confirm("101", "t1");
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE origin='telegram'").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_id='t1'").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states").get().total, 0);
  assert.throws(() => confirm("101", "t2"), /UNIQUE/);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE origin='telegram'").get().total, 1);
});

test("falha na auditoria reverte update e transação", () => {
  const db = database(); const at = seed(db);
  const broken = () => atomic(db, () => {
    db.prepare("INSERT INTO telegram_processed_updates(update_id,received_at) VALUES(?,?)").run("200", at);
    db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("t-broken", "ha", "expense", 100, "Teste", "2026-09-11", "ua", "aa", "confirmed", "telegram", at, at);
    db.prepare("INSERT INTO audit_logs(id,household_id,user_id,action,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?)").run("audit-broken", "missing-household", "ua", "create", "transaction", "t-broken", at);
  });
  assert.throws(() => broken(), /FOREIGN KEY/);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id='200'").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id='t-broken'").get().total, 0);
});

test("cancelamento remove estado sem criar movimentação", () => {
  const db = database(); const at = seed(db);
  db.prepare("INSERT INTO telegram_conversation_states(telegram_user_id,household_id,payload_json,expires_at,updated_at) VALUES(?,?,?,?,?)").run("42", "ha", "{}", "2026-09-11T13:00:00.000Z", at);
  atomic(db, () => {
    db.prepare("INSERT INTO telegram_processed_updates(update_id,received_at) VALUES(?,?)").run("cancel-1", at);
    db.prepare("DELETE FROM telegram_conversation_states WHERE telegram_user_id=? AND household_id=?").run("42", "ha");
  });
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
});

test("handler exige confirmação, auditoria, household e payload limitado", () => {
  const handler = readFileSync(new URL("../lib/telegram-handler.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../lib/finance-service.ts", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
  assert.match(handler, /phase: "confirming"/); assert.match(handler, /clearTelegramStateFor/); assert.match(handler, /eq\(householdMembers\.status, "active"\)/);
  assert.match(service, /INSERT INTO audit_logs/); assert.match(service, /INSERT INTO telegram_processed_updates/); assert.match(service, /env\.DB\.batch|d1\.batch/);
  assert.match(webhook, /16_384/); assert.match(webhook, /safeSecretEqual/); assert.doesNotMatch(webhook, /TELEGRAM_BOT_TOKEN/);
});

test("mensagens e callbacks suportados continuam processáveis", () => {
  const message = (updateId, text) => ({
    update_id: updateId,
    message: {
      text,
      chat: { id: 42, type: "private" },
      from: { id: 42 },
    },
  });

  for (const update of [message(301, "/start"), message(302, "/conectar 123456"), message(303, "Gastei 85 no mercado")]) {
    assert.equal(classifyTelegramUpdate(update).kind, "processable");
  }

  assert.equal(classifyTelegramUpdate({
    update_id: 304,
    callback_query: {
      id: "callback-304",
      data: "ok",
      from: { id: 42 },
      message: { chat: { id: 42, type: "private" } },
    },
  }).kind, "processable");
});

test("updates Telegram legítimos mas não suportados são ignorados", () => {
  const chat = { id: 42, type: "private" };
  const from = { id: 42 };
  const unsupported = [
    { update_id: 401, my_chat_member: { chat, from, new_chat_member: {} } },
    { update_id: 402, chat_member: { chat, from, new_chat_member: {} } },
    { update_id: 403, edited_message: { text: "/start", chat, from } },
    { update_id: 404, channel_post: { text: "publicação", chat: { id: -10042, type: "channel" } } },
    { update_id: 405, message: { photo: [{ file_id: "photo" }], chat, from } },
    { update_id: 406, message: { sticker: { file_id: "sticker" }, chat, from } },
    { update_id: 407, message: { new_chat_members: [from], chat, from } },
    { update_id: 408, callback_query: { id: "callback-408", data: "ok", from, inline_message_id: "inline" } },
  ];

  for (const update of unsupported) assert.equal(classifyTelegramUpdate(update).kind, "unsupported");
});

test("somente envelopes realmente inválidos são classificados como inválidos", () => {
  for (const update of [null, [], {}, { update_id: -1 }, { update_id: "409" }, { update_id: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(classifyTelegramUpdate(update).kind, "invalid");
  }
});

test("webhook encerra update não suportado antes de handler, banco ou entrega", () => {
  const webhook = readFileSync(new URL("../app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
  const classifier = readFileSync(new URL("../lib/telegram-update.mjs", import.meta.url), "utf8");
  const ignoredBranch = webhook.indexOf('classification.kind === "unsupported"');
  const handlerCall = webhook.indexOf("await handleTelegramUpdate(candidate)");

  assert.ok(ignoredBranch >= 0 && handlerCall > ignoredBranch);
  assert.match(webhook.slice(ignoredBranch, handlerCall), /ok: true, ignored: true/);
  assert.doesNotMatch(classifier, /getDb|env\.DB|transactions|telegramLinks|connectTelegramWithCode/);
  assert.match(webhook, /JSON inválido[\s\S]+status: 400/);
  assert.match(webhook, /Webhook não autorizado[\s\S]+status: 401/);
});

test("webhook retorna 5xx antes do commit e mantém 2xx quando apenas a entrega ao Telegram falha", async () => {
  const webhook = readFileSync(new URL("../app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
  const processing = webhook.indexOf("await handleTelegramUpdate(candidate)");
  const delivery = webhook.indexOf("await hasTelegramDeliveryFailure(deliveries)");
  assert.ok(processing >= 0 && delivery > processing);
  assert.match(webhook, /telegram_webhook_processing_failed/);
  assert.match(webhook, /status: 503/);
  assert.match(webhook, /telegram_webhook_response_failed/);
  assert.match(webhook, /responseDeliveryFailed: true/);
  assert.equal(await hasTelegramDeliveryFailure([Promise.resolve()]), false);
  assert.equal(await hasTelegramDeliveryFailure([Promise.reject(new Error("Telegram indisponível"))]), true);
});

test("callback query é reconhecida sem transformar falha de confirmação visual em retry", () => {
  const webhook = readFileSync(new URL("../app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
  const telegram = readFileSync(new URL("../lib/telegram.ts", import.meta.url), "utf8");
  assert.match(webhook, /answerTelegramCallback\(callbackQueryId\)/);
  assert.match(webhook, /hasTelegramDeliveryFailure\(deliveries\)/);
  assert.match(telegram, /answerCallbackQuery/);
  assert.match(telegram, /callback_query_id: callbackQueryId/);
});

test("handler não deixa operação falível relevante depois de confirmação isolada do update", () => {
  const handler = readFileSync(new URL("../lib/telegram-handler.ts", import.meta.url), "utf8");
  const balanceRead = handler.indexOf("const reply = await balanceText(link.householdId)");
  const balanceCommit = handler.indexOf("await commitUpdate(updateId)", balanceRead);
  assert.ok(balanceRead >= 0 && balanceCommit > balanceRead);
  assert.match(handler, /catch \{ console\.error\("telegram_rate_limit_cleanup_failed"\); \}/);
});

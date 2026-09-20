import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  NOTIFICATION_DISPATCH_LEASE_MS,
  runNotificationDispatcher,
} from "../lib/notification-dispatcher.ts";

const AT = "2026-09-20T12:00:00.000Z";

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first() { return this.db.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async run() { const result = this.db.prepare(this.sql).run(...this.bindings); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
}

class LocalD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
}

function database(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  t.after(() => {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
  });
  return db;
}

function ensureUser(db, user) {
  if (!db.prepare("SELECT id FROM users WHERE id=?").get(user)) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(user, user, `${user}@example.com`, AT, AT);
  }
}

function addHousehold(db, suffix, user) {
  const household = `house-${suffix}`;
  ensureUser(db, user);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(`member-${suffix}`, household, user, "owner", "active", AT);
  return household;
}

function referenceFor(eventType, dueDate) {
  if (eventType !== "bill_overdue") return "2026-09-20";
  const date = new Date(`${dueDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function seedDispatchable(db, options = {}) {
  const suffix = options.suffix ?? "a";
  const user = options.user ?? `user-${suffix}`;
  const household = addHousehold(db, suffix, user);
  const eventType = options.eventType ?? "bill_due_today";
  const dueDate = options.dueDate ?? {
    bill_due_tomorrow: "2026-09-21",
    bill_due_today: "2026-09-20",
    bill_overdue: "2026-09-19",
  }[eventType];
  const bill = `bill-${suffix}`;
  const outbox = `outbox-${suffix}`;
  db.prepare(`INSERT INTO user_notification_preferences(
    household_id,user_id,channel,enabled,bill_due_tomorrow,bill_due_today,bill_overdue,
    upcoming_digest,preferred_local_time,timezone,created_at,updated_at
  ) VALUES(?,?,'telegram',1,1,1,1,0,'09:00','America/Sao_Paulo',?,?)`).run(household, user, AT, AT);
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,is_active,linked_at,updated_at) VALUES(?,?,?,?,?,1,?,?)")
    .run(`link-${suffix}`, household, user, `telegram-${suffix}`, `chat-${suffix}`, AT, AT);
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,due_date,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,'none','pending',?,'web',?,?)")
    .run(bill, household, options.description ?? "Internet", options.amountCents ?? 11990, dueDate, user, AT, AT);
  const status = options.status ?? "pending";
  const leaseUntil = status === "processing" ? options.leaseUntil : null;
  db.prepare(`INSERT INTO notification_outbox(
    id,household_id,recipient_user_id,channel,entity_type,entity_id,event_type,
    reference_date,dedupe_key,status,attempts,next_attempt_at,lease_until,
    provider_message_id,last_error,created_at,updated_at,sent_at
  ) VALUES(?, ?, ?, 'telegram', 'bill', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`).run(
    outbox,
    household,
    user,
    bill,
    eventType,
    options.referenceDate ?? referenceFor(eventType, dueDate),
    `dedupe-${suffix}`,
    status,
    options.attempts ?? 0,
    options.nextAttemptAt ?? null,
    leaseUntil,
    AT,
    AT,
  );
  return { household, user, bill, outbox, chatId: `chat-${suffix}`, dueDate };
}

function fakeTransport(result = { kind: "sent", providerMessageId: "provider-1" }) {
  const calls = [];
  return {
    calls,
    async send(message) {
      calls.push(message);
      if (typeof result === "function") return result(message);
      return result;
    },
  };
}

function run(db, transport, options = {}) {
  return runNotificationDispatcher({
    d1: new LocalD1(db),
    transport,
    now: options.now ?? AT,
    leaseDurationMs: options.leaseDurationMs,
    maxAttempts: options.maxAttempts,
    maxItems: options.maxItems,
  });
}

function outbox(db, id) {
  return { ...db.prepare("SELECT * FROM notification_outbox WHERE id=?").get(id) };
}

test("claim de pending processa um único item elegível", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  const transport = fakeTransport();
  const summary = await run(db, transport);
  assert.equal(summary.claimed, 1);
  assert.equal(transport.calls.length, 1);
  assert.equal(outbox(db, fixture.outbox).status, "sent");
});

test("dois workers concorrentes fazem somente um claim efetivo", async (t) => {
  const db = database(t);
  seedDispatchable(db);
  const transport = fakeTransport();
  const summaries = await Promise.all([run(db, transport), run(db, transport)]);
  assert.equal(summaries.reduce((total, value) => total + value.claimed, 0), 1);
  assert.equal(transport.calls.length, 1);
});

test("lease válido impede segundo claim", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db, { status: "processing", leaseUntil: "2026-09-20T12:05:00.000Z" });
  const transport = fakeTransport();
  assert.deepEqual(await run(db, transport), { claimed: 0, sent: 0, failed: 0, retried: 0, uncertain: 0, cancelled: 0, skipped: 0 });
  assert.equal(outbox(db, fixture.outbox).status, "processing");
  assert.equal(transport.calls.length, 0);
});

test("bill paga antes do dispatch é cancelada", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  db.prepare("UPDATE bills SET status='paid',paid_at=? WHERE id=?").run(AT, fixture.bill);
  const transport = fakeTransport();
  assert.equal((await run(db, transport)).cancelled, 1);
  assert.equal(outbox(db, fixture.outbox).status, "cancelled");
  assert.equal(transport.calls.length, 0);
});

test("bill cancelada antes do dispatch é cancelada na outbox", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  db.prepare("UPDATE bills SET status='cancelled' WHERE id=?").run(fixture.bill);
  const transport = fakeTransport();
  assert.equal((await run(db, transport)).cancelled, 1);
  assert.match(outbox(db, fixture.outbox).last_error, /bill_cancelled/u);
  assert.equal(transport.calls.length, 0);
});

test("bill inexistente cancela sem chamar transport", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  db.prepare("DELETE FROM bills WHERE id=?").run(fixture.bill);
  const transport = fakeTransport();
  assert.equal((await run(db, transport)).cancelled, 1);
  assert.match(outbox(db, fixture.outbox).last_error, /bill_missing/u);
  assert.equal(transport.calls.length, 0);
});

test("vencimento alterado invalida o evento planejado", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  db.prepare("UPDATE bills SET due_date='2026-09-22' WHERE id=?").run(fixture.bill);
  const transport = fakeTransport();
  assert.equal((await run(db, transport)).cancelled, 1);
  assert.match(outbox(db, fixture.outbox).last_error, /event_no_longer_relevant/u);
  assert.equal(transport.calls.length, 0);
});

test("membership inativa cancela o item", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  db.prepare("UPDATE household_members SET status='inactive' WHERE household_id=? AND user_id=?").run(fixture.household, fixture.user);
  const transport = fakeTransport();
  assert.equal((await run(db, transport)).cancelled, 1);
  assert.equal(transport.calls.length, 0);
});

test("preferência desativada cancela o item", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  db.prepare("UPDATE user_notification_preferences SET enabled=0 WHERE household_id=? AND user_id=? AND channel='telegram'")
    .run(fixture.household, fixture.user);
  const transport = fakeTransport();
  assert.equal((await run(db, transport)).cancelled, 1);
  assert.equal(transport.calls.length, 0);
});

test("evento específico desativado cancela o item", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db, { eventType: "bill_due_tomorrow" });
  db.prepare("UPDATE user_notification_preferences SET bill_due_tomorrow=0 WHERE household_id=? AND user_id=? AND channel='telegram'")
    .run(fixture.household, fixture.user);
  const transport = fakeTransport();
  assert.equal((await run(db, transport)).cancelled, 1);
  assert.equal(transport.calls.length, 0);
});

test("Telegram desvinculado cancela sem resolver destino", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  db.prepare("UPDATE telegram_links SET is_active=0 WHERE household_id=? AND user_id=?").run(fixture.household, fixture.user);
  const transport = fakeTransport();
  assert.equal((await run(db, transport)).cancelled, 1);
  assert.equal(transport.calls.length, 0);
});

test("vínculo Telegram de outro household não autoriza envio", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  db.prepare("DELETE FROM telegram_links WHERE household_id=? AND user_id=?").run(fixture.household, fixture.user);
  const otherHousehold = addHousehold(db, "other", fixture.user);
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,is_active,linked_at,updated_at) VALUES(?,?,?,?,?,1,?,?)")
    .run("link-other", otherHousehold, fixture.user, "telegram-other", "chat-other", AT, AT);
  const transport = fakeTransport();
  assert.equal((await run(db, transport)).cancelled, 1);
  assert.equal(transport.calls.length, 0);
});

test("sucesso do transport fake marca sent e sent_at", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  const summary = await run(db, fakeTransport({ kind: "sent" }));
  const row = outbox(db, fixture.outbox);
  assert.equal(summary.sent, 1);
  assert.equal(row.status, "sent");
  assert.equal(row.sent_at, AT);
  assert.equal(row.attempts, 1);
  assert.equal(row.lease_until, null);
});

test("provider_message_id de sucesso é registrado", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  await run(db, fakeTransport({ kind: "sent", providerMessageId: "telegram-message-42" }));
  assert.equal(outbox(db, fixture.outbox).provider_message_id, "telegram-message-42");
});

test("erro permanente marca failed sem retry", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  const summary = await run(db, fakeTransport({ kind: "permanent_failure", errorCode: "recipient_blocked" }));
  const row = outbox(db, fixture.outbox);
  assert.equal(summary.failed, 1);
  assert.equal(row.status, "failed");
  assert.equal(row.next_attempt_at, null);
  assert.equal(row.attempts, 1);
});

test("erro persistido é sanitizado e não contém segredo ou chat_id", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  const malicious = { kind: "permanent_failure", errorCode: "token=123456:ABC_secret chat_id=chat-a", error: "Internet R$ 119,90" };
  await run(db, fakeTransport(malicious));
  const error = outbox(db, fixture.outbox).last_error;
  assert.equal(error, "transport_permanent");
  assert.doesNotMatch(error, /123456|chat-a|Internet|119,90/iu);
});

test("429 retorna item a pending com retry agendado", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  const summary = await run(db, fakeTransport({ kind: "rate_limited", retryAfterSeconds: 90 }));
  const row = outbox(db, fixture.outbox);
  assert.equal(summary.retried, 1);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.equal(row.lease_until, null);
});

test("429 respeita retry_after sem loop imediato", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  const transport = fakeTransport({ kind: "rate_limited", retryAfterSeconds: 125 });
  await run(db, transport);
  assert.equal(outbox(db, fixture.outbox).next_attempt_at, "2026-09-20T12:02:05.000Z");
  assert.equal((await run(db, transport)).claimed, 0);
  assert.equal(transport.calls.length, 1);
});

test("5xx conhecido agenda backoff exponencial", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db, { attempts: 1 });
  const summary = await run(db, fakeTransport({ kind: "transient_failure", errorCode: "http_503" }));
  const row = outbox(db, fixture.outbox);
  assert.equal(summary.retried, 1);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 2);
  assert.equal(row.next_attempt_at, "2026-09-20T12:02:00.000Z");
});

test("máximo de tentativas encerra 5xx como failed", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db, { attempts: 3 });
  const summary = await run(db, fakeTransport({ kind: "transient_failure", errorCode: "http_500" }), { maxAttempts: 4 });
  const row = outbox(db, fixture.outbox);
  assert.equal(summary.failed, 1);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 4);
  assert.equal(row.next_attempt_at, null);
});

test("timeout lançado pelo transport fica uncertain", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  const transport = fakeTransport(() => { throw new Error("timeout após possível aceite"); });
  const summary = await run(db, transport);
  const row = outbox(db, fixture.outbox);
  assert.equal(summary.uncertain, 1);
  assert.equal(row.status, "uncertain");
  assert.equal(row.attempts, 1);
  assert.equal(row.lease_until, null);
});

test("uncertain nunca é reenviado automaticamente", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  const transport = fakeTransport({ kind: "uncertain", errorCode: "timeout" });
  assert.equal((await run(db, transport)).uncertain, 1);
  assert.equal((await run(db, transport, { now: "2026-09-21T12:00:00.000Z" })).claimed, 0);
  assert.equal(outbox(db, fixture.outbox).status, "uncertain");
  assert.equal(transport.calls.length, 1);
});

test("lease expirado antes do envio pode ser retomado", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db, { status: "processing", leaseUntil: "2026-09-20T11:59:59.000Z" });
  const transport = fakeTransport();
  const summary = await run(db, transport);
  assert.equal(summary.claimed, 1);
  assert.equal(summary.sent, 1);
  assert.equal(outbox(db, fixture.outbox).status, "sent");
  assert.equal(transport.calls.length, 1);
});

test("fence uncertain é gravado antes de chamar o transport", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  const transport = fakeTransport(() => {
    const row = outbox(db, fixture.outbox);
    assert.equal(row.status, "uncertain");
    assert.equal(row.attempts, 1);
    assert.equal(row.lease_until, null);
    return { kind: "sent" };
  });
  await run(db, transport);
  assert.equal(outbox(db, fixture.outbox).status, "sent");
});

test("concorrência mantém estado final consistente e uma chamada", async (t) => {
  const db = database(t);
  const fixture = seedDispatchable(db);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const transport = fakeTransport(async () => { await gate; return { kind: "sent", providerMessageId: "one" }; });
  const first = run(db, transport);
  const second = run(db, transport);
  release();
  await Promise.all([first, second]);
  const row = outbox(db, fixture.outbox);
  assert.equal(transport.calls.length, 1);
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 1);
});

test("mensagem de tomorrow usa conteúdo revalidado", async (t) => {
  const db = database(t);
  seedDispatchable(db, { eventType: "bill_due_tomorrow", dueDate: "2026-09-21" });
  const transport = fakeTransport();
  await run(db, transport);
  assert.equal(transport.calls[0].text, "🔔 Lembrete de vencimento\n\nInternet\nR$ 119,90\nVence amanhã, 21/09.");
});

test("mensagem de today usa conteúdo revalidado", async (t) => {
  const db = database(t);
  seedDispatchable(db, { eventType: "bill_due_today" });
  const transport = fakeTransport();
  await run(db, transport);
  assert.equal(transport.calls[0].text, "⚠️ Vence hoje\n\nInternet\nR$ 119,90\nAinda consta como pendente.");
});

test("mensagem de overdue usa conteúdo revalidado", async (t) => {
  const db = database(t);
  seedDispatchable(db, { eventType: "bill_overdue", dueDate: "2026-09-19" });
  const transport = fakeTransport();
  await run(db, transport);
  assert.equal(transport.calls[0].text, "🚨 Conta atrasada\n\nInternet\nR$ 119,90\nVenceu em 19/09 e continua pendente.");
});

test("formatação pt-BR preserva moeda e data civil", async (t) => {
  const db = database(t);
  seedDispatchable(db, { eventType: "bill_due_tomorrow", dueDate: "2026-09-21", amountCents: 11366, description: "Seguro do carro" });
  const transport = fakeTransport();
  await run(db, transport);
  assert.match(transport.calls[0].text, /Seguro do carro\nR\$ 113,66\nVence amanhã, 21\/09\./u);
});

test("resumo técnico não expõe dados sensíveis", async (t) => {
  const db = database(t);
  seedDispatchable(db, { description: "Descrição confidencial", amountCents: 987654 });
  const summary = await run(db, fakeTransport());
  assert.deepEqual(Object.keys(summary), ["claimed", "sent", "failed", "retried", "uncertain", "cancelled", "skipped"]);
  assert.ok(Object.values(summary).every((value) => typeof value === "number"));
  assert.doesNotMatch(JSON.stringify(summary), /Descrição|987654|chat-|telegram-/u);
});

test("dispatcher não referencia transport real, token, rota ou Cron", () => {
  const source = readFileSync(new URL("../lib/notification-dispatcher.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /sendTelegramMessage|TELEGRAM_BOT_TOKEN|api\.telegram\.org|scheduled\s*\(|app\/api|fetch\s*\(/u);
  assert.match(source, /transport\.send/u);
  assert.equal(NOTIFICATION_DISPATCH_LEASE_MS, 300000);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runNotificationDispatcher } from "../lib/notification-dispatcher.ts";
import { TelegramNotificationTransport } from "../lib/telegram-notification-transport.ts";

const AT = "2026-09-20T12:00:00.000Z";
const TOKEN = "123456789:dispatcher_test_token";

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

function seed(db, options = {}) {
  const suffix = options.suffix ?? "a";
  const user = `user-${suffix}`;
  const household = `house-${suffix}`;
  const bill = `bill-${suffix}`;
  const outboxId = `outbox-${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(user, user, `${user}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(`member-${suffix}`, household, user, "owner", options.membershipStatus ?? "active", AT);
  db.prepare(`INSERT INTO user_notification_preferences(
    household_id,user_id,channel,enabled,bill_due_tomorrow,bill_due_today,bill_overdue,
    upcoming_digest,preferred_local_time,timezone,created_at,updated_at
  ) VALUES(?,?,'telegram',?,1,1,1,0,'09:00','America/Sao_Paulo',?,?)`)
    .run(household, user, options.preferenceEnabled ?? 1, AT, AT);
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,is_active,linked_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(`link-${suffix}`, household, user, `telegram-${suffix}`, `chat-${suffix}`, options.linkActive ?? 1, AT, AT);
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,due_date,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,'none',?,?,'web',?,?)")
    .run(bill, household, "Internet", 11990, "2026-09-20", options.billStatus ?? "pending", user, AT, AT);
  db.prepare(`INSERT INTO notification_outbox(
    id,household_id,recipient_user_id,channel,entity_type,entity_id,event_type,
    reference_date,dedupe_key,status,attempts,created_at,updated_at
  ) VALUES(?,?,?,'telegram','bill',?,'bill_due_today','2026-09-20',?,'pending',?,?,?)`)
    .run(outboxId, household, user, bill, `dedupe-${suffix}`, options.attempts ?? 0, AT, AT);
  return { household, user, bill, outboxId };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transport(fetchImpl, timeoutMs) {
  return new TelegramNotificationTransport({ token: TOKEN, fetchImpl, timeoutMs });
}

function run(db, telegramTransport, options = {}) {
  return runNotificationDispatcher({
    d1: new LocalD1(db),
    transport: telegramTransport,
    now: options.now ?? AT,
    maxAttempts: options.maxAttempts,
    maxItems: options.maxItems,
  });
}

function outbox(db, id) {
  return db.prepare("SELECT * FROM notification_outbox WHERE id=?").get(id);
}

test("outbox elegível é claimed usando adapter com fetch fake", async (t) => {
  const db = database(t);
  seed(db);
  const summary = await run(db, transport(async () => jsonResponse({ ok: true })));
  assert.equal(summary.claimed, 1);
});

test("revalidação impede envio quando membership ficou inativa", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  db.prepare("UPDATE household_members SET status='removed' WHERE household_id=? AND user_id=?").run(fixture.household, fixture.user);
  let calls = 0;
  const summary = await run(db, transport(async () => { calls += 1; return jsonResponse({ ok: true }); }));
  assert.equal(summary.cancelled, 1);
  assert.equal(calls, 0);
});

test("fence uncertain é persistido antes da chamada fetch", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  await run(db, transport(async () => {
    const row = outbox(db, fixture.outboxId);
    assert.equal(row.status, "uncertain");
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, "transport_outcome_pending");
    return jsonResponse({ ok: true });
  }));
});

test("sucesso do Telegram conclui como sent", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  const summary = await run(db, transport(async () => jsonResponse({ ok: true })));
  assert.equal(summary.sent, 1);
  assert.equal(outbox(db, fixture.outboxId).status, "sent");
});

test("provider_message_id do adapter é persistido", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  await run(db, transport(async () => jsonResponse({ ok: true, result: { message_id: 321, text: "não persistir" } })));
  const row = outbox(db, fixture.outboxId);
  assert.equal(row.provider_message_id, "321");
  assert.equal(JSON.stringify(row).includes("não persistir"), false);
});

test("429 retorna item para pending com next_attempt_at", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  const summary = await run(db, transport(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 30 } }, 429)));
  const row = outbox(db, fixture.outboxId);
  assert.equal(summary.retried, 1);
  assert.equal(row.status, "pending");
  assert.ok(row.next_attempt_at);
});

test("retry_after do Telegram é respeitado", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  await run(db, transport(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 75 } }, 429)));
  assert.equal(outbox(db, fixture.outboxId).next_attempt_at, "2026-09-20T12:01:15.000Z");
});

test("5xx aplica backoff do dispatcher", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  await run(db, transport(async () => jsonResponse({ ok: false }, 503)));
  const row = outbox(db, fixture.outboxId);
  assert.equal(row.status, "pending");
  assert.equal(row.next_attempt_at, "2026-09-20T12:01:00.000Z");
  assert.equal(row.last_error, "transport_transient:telegram_http_503");
});

test("máximo de tentativas transforma 5xx em failed", async (t) => {
  const db = database(t);
  const fixture = seed(db, { attempts: 3 });
  const summary = await run(db, transport(async () => jsonResponse({ ok: false }, 500)));
  const row = outbox(db, fixture.outboxId);
  assert.equal(summary.failed, 1);
  assert.equal(row.status, "failed");
  assert.equal(row.last_error, "transport_retry_limit_exhausted");
});

test("4xx permanente conclui como failed", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  const summary = await run(db, transport(async () => jsonResponse({ ok: false, description: "blocked" }, 403)));
  const row = outbox(db, fixture.outboxId);
  assert.equal(summary.failed, 1);
  assert.equal(row.status, "failed");
  assert.equal(row.last_error, "transport_permanent:telegram_http_403");
});

test("timeout do adapter permanece uncertain", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  const timed = transport((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }), 5);
  const summary = await run(db, timed);
  const row = outbox(db, fixture.outboxId);
  assert.equal(summary.uncertain, 1);
  assert.equal(row.status, "uncertain");
  assert.equal(row.last_error, "transport_uncertain:telegram_timeout");
});

test("falha ambígua de rede permanece uncertain", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  const summary = await run(db, transport(async () => { throw new TypeError("network"); }));
  assert.equal(summary.uncertain, 1);
  assert.equal(outbox(db, fixture.outboxId).last_error, "transport_uncertain:telegram_network_ambiguous");
});

test("uncertain não é reenviado", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  let calls = 0;
  const ambiguous = transport(async () => { calls += 1; throw new TypeError("network"); });
  assert.equal((await run(db, ambiguous)).uncertain, 1);
  assert.equal((await run(db, ambiguous, { now: "2026-09-21T12:00:00.000Z" })).claimed, 0);
  assert.equal(outbox(db, fixture.outboxId).status, "uncertain");
  assert.equal(calls, 1);
});

test("dois workers geram somente uma chamada externa", async (t) => {
  const db = database(t);
  seed(db);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const telegram = transport(async () => {
    calls += 1;
    await gate;
    return jsonResponse({ ok: true });
  });
  const first = run(db, telegram);
  await new Promise((resolve) => setImmediate(resolve));
  const second = run(db, telegram);
  release();
  const summaries = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(summaries.reduce((sum, item) => sum + item.sent, 0), 1);
});

test("bill paga antes do envio é cancelled sem fetch", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  db.prepare("UPDATE bills SET status='paid', paid_at=? WHERE id=?").run(AT, fixture.bill);
  let calls = 0;
  const summary = await run(db, transport(async () => { calls += 1; return jsonResponse({ ok: true }); }));
  assert.equal(summary.cancelled, 1);
  assert.equal(calls, 0);
});

test("Telegram desvinculado antes do envio é cancelled sem fetch", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  db.prepare("UPDATE telegram_links SET is_active=0 WHERE household_id=? AND user_id=?").run(fixture.household, fixture.user);
  let calls = 0;
  const summary = await run(db, transport(async () => { calls += 1; return jsonResponse({ ok: true }); }));
  assert.equal(summary.cancelled, 1);
  assert.equal(calls, 0);
});

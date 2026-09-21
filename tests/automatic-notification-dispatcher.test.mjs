import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  AUTOMATIC_NOTIFICATION_DISPATCH_MAX_ITEMS,
  runAutomaticNotificationDispatcher,
} from "../lib/automatic-notification-dispatcher.ts";
import {
  NOTIFICATION_DISPATCHER_CRON,
  createWorkerEntrypoint,
} from "../worker/create-worker.ts";

const AT = "2026-09-20T12:00:00.000Z";

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first() { return this.db.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  execute() {
    const result = this.db.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async run() { return this.execute(); }
}

class LocalD1 {
  constructor(db, options = {}) { this.db = db; this.options = options; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const [index, statement] of statements.entries()) {
        results.push(statement.execute());
        if (this.options.failBatchAfter === index + 1) throw new Error("synthetic batch failure");
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
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

function seed(db, suffix, options = {}) {
  const household = `house-${suffix}`;
  const user = `user-${suffix}`;
  const bill = `bill-${suffix}`;
  const outbox = `outbox-${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(user, user, `${user}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(`member-${suffix}`, household, user, "owner", options.membershipStatus ?? "active", AT);
  db.prepare(`INSERT INTO user_notification_preferences(
    household_id,user_id,channel,enabled,bill_due_tomorrow,bill_due_today,bill_overdue,
    upcoming_digest,preferred_local_time,timezone,created_at,updated_at
  ) VALUES(?,?,'telegram',?,1,?,1,0,'09:00','America/Sao_Paulo',?,?)`).run(
    household, user, options.preferenceEnabled ?? 1, options.todayEnabled ?? 1, AT, AT,
  );
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,is_active,linked_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(`link-${suffix}`, household, user, `telegram-${suffix}`, `chat-${suffix}`, options.linkActive ?? 1, AT, AT);
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,due_date,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,'none',?,?,'web',?,?)")
    .run(bill, household, `Sensitive ${suffix}`, 1000, "2026-09-20", options.billStatus ?? "pending", user, AT, AT);
  db.prepare(`INSERT INTO notification_outbox(
    id,household_id,recipient_user_id,channel,entity_type,entity_id,event_type,
    reference_date,dedupe_key,status,attempts,next_attempt_at,lease_until,
    provider_message_id,last_error,created_at,updated_at,sent_at
  ) VALUES(?,?,?,'telegram','bill',?,'bill_due_today',?,?,?, ?,NULL,NULL,NULL,NULL,?,?,?)`).run(
    outbox,
    household,
    user,
    bill,
    options.referenceDate ?? "2026-09-20",
    `dedupe-${suffix}`,
    options.status ?? "pending",
    options.attempts ?? 0,
    AT,
    AT,
    options.status === "sent" ? AT : null,
  );
  return { household, user, bill, outbox };
}

function fakeTransport(result = { kind: "sent", providerMessageId: "provider-fake" }) {
  const calls = [];
  return {
    calls,
    async send(message) {
      calls.push(message);
      return typeof result === "function" ? result(message, calls.length) : result;
    },
  };
}

function run(d1, transport, options = {}) {
  let tokenSequence = 0;
  return runAutomaticNotificationDispatcher({
    d1,
    transport,
    now: options.now ?? AT,
    maxAttempts: options.maxAttempts,
    maxItems: options.maxItems,
    createLeaseToken: options.createLeaseToken ?? (() => `global-lease-${++tokenSequence}`),
  });
}

test("integração local envia uma vez, persiste sent e não reenvia", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db, "success");
  const transport = fakeTransport();
  const first = await run(d1, transport);
  const second = await run(d1, transport);
  assert.equal(first.claimed, 1);
  assert.equal(first.sent, 1);
  assert.equal(second.claimed, 0);
  assert.equal(transport.calls.length, 1);
  assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id=?").get(fixture.outbox).status, "sent");
  assert.equal(db.prepare("SELECT lease_token FROM notification_transport_state WHERE channel='telegram'").get().lease_token, null);
});

test("scheduled dispatcher executa integração local completa com transport fake", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db, "scheduled-integration");
  const transport = fakeTransport();
  const pending = [];
  let tokenSequence = 0;
  const worker = createWorkerEntrypoint({ fetch: () => new Response("ok") }, {
    runDispatcher: ({ d1: receivedD1, now }) => runAutomaticNotificationDispatcher({
      d1: receivedD1,
      now,
      transport,
      createLeaseToken: () => `scheduled-lease-${++tokenSequence}`,
    }),
    logDispatcherSummary() {},
  });
  const ctx = {
    props: {},
    waitUntil(promise) { pending.push(promise); },
    passThroughOnException() {},
  };
  const controller = { scheduledTime: Date.parse(AT), cron: NOTIFICATION_DISPATCHER_CRON, noRetry() {} };
  await worker.scheduled(controller, { DB: d1, NOTIFICATION_DISPATCHER_ENABLED: "true" }, ctx);
  await pending.shift();
  await worker.scheduled(controller, { DB: d1, NOTIFICATION_DISPATCHER_ENABLED: "true" }, ctx);
  await pending.shift();
  assert.equal(transport.calls.length, 1);
  assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id=?").get(fixture.outbox).status, "sent");
});

test("dispatcher automático limita cada ciclo a dez itens", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  for (let index = 0; index < 11; index += 1) seed(db, `limit-${String(index).padStart(2, "0")}`);
  const transport = fakeTransport();
  const summary = await run(d1, transport);
  assert.equal(AUTOMATIC_NOTIFICATION_DISPATCH_MAX_ITEMS, 10);
  assert.equal(summary.claimed, 10);
  assert.equal(summary.sent, 10);
  assert.equal(transport.calls.length, 10);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox WHERE status='pending'").get().total, 1);
});

test("lease global é adquirido antes da outbox e bloqueia dispatcher concorrente", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const firstItem = seed(db, "concurrent-a");
  const secondItem = seed(db, "concurrent-b");
  let releaseTransport;
  const entered = new Promise((resolve) => { releaseTransport = resolve; });
  let transportStarted;
  const started = new Promise((resolve) => { transportStarted = resolve; });
  const transport = fakeTransport(async () => {
    const state = db.prepare("SELECT lease_token FROM notification_transport_state WHERE channel='telegram'").get();
    assert.ok(state.lease_token);
    transportStarted();
    await entered;
    return { kind: "sent" };
  });
  const winner = run(d1, transport, { maxItems: 1, createLeaseToken: () => "winner" });
  await started;
  const loser = await run(d1, transport, { maxItems: 1, createLeaseToken: () => "loser" });
  assert.equal(loser.claimed, 0);
  assert.equal(loser.skipped, 1);
  assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id=?").get(secondItem.outbox).status, "pending");
  releaseTransport();
  const won = await winner;
  assert.equal(won.sent, 1);
  assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id=?").get(firstItem.outbox).status, "sent");
  assert.equal(transport.calls.length, 1);
});

test("sent, failed e uncertain nunca são claimados pelo fluxo automático", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  seed(db, "already-sent", { status: "sent" });
  seed(db, "already-failed", { status: "failed" });
  seed(db, "already-uncertain", { status: "uncertain", attempts: 1 });
  const transport = fakeTransport();
  const summary = await run(d1, transport);
  assert.equal(summary.claimed, 0);
  assert.equal(transport.calls.length, 0);
});

test("revalida preferência, membership, vínculo, flag e evento antes do fake transport", async (t) => {
  const scenarios = [
    ["preference", { preferenceEnabled: 0 }],
    ["membership", { membershipStatus: "inactive" }],
    ["link", { linkActive: 0 }],
    ["flag", { todayEnabled: 0 }],
    ["bill", { billStatus: "paid" }],
    ["reference", { referenceDate: "2026-09-19" }],
  ];
  for (const [name, options] of scenarios) {
    await t.test(name, async (t) => {
      const db = database(t);
      const fixture = seed(db, `revalidate-${name}`, options);
      const transport = fakeTransport();
      const summary = await run(new LocalD1(db), transport);
      assert.equal(summary.claimed, 1);
      assert.equal(summary.cancelled, 1);
      assert.equal(transport.calls.length, 0);
      assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id=?").get(fixture.outbox).status, "cancelled");
    });
  }
});

test("preserva 4xx, 5xx, limite de tentativas e resultado ambíguo", async (t) => {
  const scenarios = [
    ["permanent", { kind: "permanent_failure", errorCode: "bad_request" }, 0, "failed"],
    ["transient", { kind: "transient_failure", errorCode: "server_error" }, 0, "pending"],
    ["exhausted", { kind: "transient_failure", errorCode: "server_error" }, 3, "failed"],
    ["uncertain", { kind: "uncertain", errorCode: "ambiguous" }, 0, "uncertain"],
  ];
  for (const [name, result, attempts, expectedStatus] of scenarios) {
    await t.test(name, async (t) => {
      const db = database(t);
      const fixture = seed(db, `result-${name}`, { attempts });
      const summary = await run(new LocalD1(db), fakeTransport(result));
      const item = db.prepare("SELECT status,next_attempt_at FROM notification_outbox WHERE id=?").get(fixture.outbox);
      assert.equal(item.status, expectedStatus);
      if (name === "transient") assert.equal(item.next_attempt_at, "2026-09-20T12:01:00.000Z");
      if (name === "uncertain") assert.equal(summary.uncertain, 1);
    });
  }
});

test("429 persiste item e pausa, interrompe lote, bloqueia durante pausa e retoma depois", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const firstItem = seed(db, "rate-a");
  const secondItem = seed(db, "rate-b");
  const limited = fakeTransport({ kind: "rate_limited", retryAfterSeconds: 120, errorCode: "too_many_requests" });
  const first = await run(d1, limited, { createLeaseToken: () => "rate-lease" });
  const firstRow = db.prepare("SELECT status,next_attempt_at FROM notification_outbox WHERE id=?").get(firstItem.outbox);
  const secondRow = db.prepare("SELECT status FROM notification_outbox WHERE id=?").get(secondItem.outbox);
  const state = db.prepare("SELECT paused_until,lease_token FROM notification_transport_state WHERE channel='telegram'").get();
  assert.equal(first.claimed, 1);
  assert.equal(first.retried, 1);
  assert.equal(first.rateLimited, 1);
  assert.equal(limited.calls.length, 1);
  assert.deepEqual({ ...firstRow }, { status: "pending", next_attempt_at: "2026-09-20T12:02:00.000Z" });
  assert.equal(secondRow.status, "pending");
  assert.equal(state.paused_until, "2026-09-20T12:02:00.000Z");
  assert.equal(state.lease_token, null);

  const duringPauseTransport = fakeTransport();
  const duringPause = await run(new LocalD1(db), duringPauseTransport, {
    now: "2026-09-20T12:01:59.000Z",
    createLeaseToken: () => "blocked-by-pause",
  });
  assert.equal(duringPause.paused, 1);
  assert.equal(duringPause.claimed, 0);
  assert.equal(duringPauseTransport.calls.length, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox WHERE status='processing'").get().total, 0);

  const resumedTransport = fakeTransport();
  const resumed = await run(new LocalD1(db), resumedTransport, {
    now: "2026-09-20T12:02:00.000Z",
    createLeaseToken: () => "after-pause",
  });
  assert.equal(resumed.sent, 2);
  assert.equal(resumedTransport.calls.length, 2);
});

test("dois dispatchers concorrentes diante de 429 fazem uma chamada e compartilham a pausa", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  seed(db, "concurrent-rate-a");
  const untouched = seed(db, "concurrent-rate-b");
  let releaseTransport;
  const release = new Promise((resolve) => { releaseTransport = resolve; });
  let transportStarted;
  const started = new Promise((resolve) => { transportStarted = resolve; });
  const transport = fakeTransport(async () => {
    transportStarted();
    await release;
    return { kind: "rate_limited", retryAfterSeconds: 90 };
  });
  const winner = run(d1, transport, { createLeaseToken: () => "rate-winner" });
  await started;
  const loser = await run(d1, transport, { createLeaseToken: () => "rate-loser" });
  assert.equal(loser.claimed, 0);
  releaseTransport();
  const result = await winner;
  assert.equal(result.rateLimited, 1);
  assert.equal(transport.calls.length, 1);
  assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id=?").get(untouched.outbox).status, "pending");
  assert.equal(db.prepare("SELECT paused_until FROM notification_transport_state WHERE channel='telegram'").get().paused_until, "2026-09-20T12:01:30.000Z");
});

test("429 no limite de tentativas falha o item mas ainda ativa a pausa global", async (t) => {
  const db = database(t);
  const fixture = seed(db, "rate-exhausted", { attempts: 3 });
  const summary = await run(
    new LocalD1(db),
    fakeTransport({ kind: "rate_limited", retryAfterSeconds: 60 }),
    { createLeaseToken: () => "rate-exhausted-lease" },
  );
  const item = db.prepare("SELECT status,next_attempt_at FROM notification_outbox WHERE id=?").get(fixture.outbox);
  assert.deepEqual({ ...item }, { status: "failed", next_attempt_at: null });
  assert.equal(summary.failed, 1);
  assert.equal(summary.rateLimited, 1);
  assert.equal(db.prepare("SELECT paused_until FROM notification_transport_state WHERE channel='telegram'").get().paused_until, "2026-09-20T12:01:00.000Z");
});

test("falha do batch de 429 não produz item reagendado sem pausa nem pausa sem item", async (t) => {
  const db = database(t);
  const fixture = seed(db, "atomic");
  const d1 = new LocalD1(db, { failBatchAfter: 1 });
  await assert.rejects(
    run(d1, fakeTransport({ kind: "rate_limited", retryAfterSeconds: 60 }), {
      createLeaseToken: () => "atomic-lease",
    }),
    /synthetic batch failure/,
  );
  const item = db.prepare("SELECT status,next_attempt_at FROM notification_outbox WHERE id=?").get(fixture.outbox);
  const state = db.prepare("SELECT paused_until,lease_token FROM notification_transport_state WHERE channel='telegram'").get();
  assert.deepEqual({ ...item }, { status: "uncertain", next_attempt_at: null });
  assert.deepEqual({ ...state }, { paused_until: null, lease_token: null });
});

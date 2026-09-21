import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runBillNotificationPlanner } from "../lib/notification-planner.ts";
import { runNotificationScheduler } from "../lib/notification-scheduler.ts";
import {
  getNotificationScheduleState,
  synchronizeNotificationScheduleState,
} from "../lib/notification-schedule-state.ts";

const AT = "2026-09-21T10:00:00.000Z";
const DUE = "2026-09-21T12:00:00.000Z";

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

function seed(db, suffix, options = {}) {
  const household = `house-${suffix}`;
  const user = options.user ?? `user-${suffix}`;
  if (!db.prepare("SELECT id FROM users WHERE id=?").get(user)) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(user, user, `${user}@example.com`, AT, AT);
  }
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(`member-${suffix}-${user}`, household, user, "owner", "active", AT);
  db.prepare(`INSERT INTO user_notification_preferences(
    household_id,user_id,channel,enabled,bill_due_tomorrow,bill_due_today,bill_overdue,
    upcoming_digest,preferred_local_time,timezone,created_at,updated_at
  ) VALUES(?,?,'telegram',1,1,1,1,0,?,?,?,?)`).run(
    household,
    user,
    options.preferredLocalTime ?? "09:00",
    options.timezone ?? "America/Sao_Paulo",
    AT,
    options.updatedAt ?? AT,
  );
  if (options.link !== false) {
    db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,is_active,linked_at,updated_at) VALUES(?,?,?,?,?,1,?,?)")
      .run(`link-${suffix}`, household, user, `telegram-${suffix}`, `chat-${suffix}`, AT, AT);
  }
  return { household, user };
}

function addMember(db, household, suffix) {
  const user = `user-${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(user, user, `${user}@example.com`, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(`member-${suffix}`, household, user, "member", "active", AT);
  db.prepare(`INSERT INTO user_notification_preferences(
    household_id,user_id,channel,enabled,preferred_local_time,timezone,created_at,updated_at
  ) VALUES(?,?,'telegram',1,'09:00','America/Sao_Paulo',?,?)`).run(household, user, AT, AT);
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,is_active,linked_at,updated_at) VALUES(?,?,?,?,?,1,?,?)")
    .run(`link-${suffix}`, household, user, `telegram-${suffix}`, `chat-${suffix}`, AT, AT);
  return user;
}

function addBill(db, fixture, suffix, dueDate = "2026-09-21") {
  const id = `bill-${suffix}`;
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,due_date,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,'none','pending',?,'web',?,?)")
    .run(id, fixture.household, `Sensitive ${suffix}`, 1000, dueDate, fixture.user, AT, AT);
  return id;
}

function scheduleContext(d1, fixture, now = AT) {
  return { d1, householdId: fixture.household, userId: fixture.user, channel: "telegram", now };
}

async function makeDue(d1, fixture, now = AT) {
  return synchronizeNotificationScheduleState(scheduleContext(d1, fixture, now));
}

function emptyPlannerSummary(values = {}) {
  return {
    recipientsEvaluated: 1,
    billsEvaluated: 0,
    eventsEligible: 0,
    inserted: 0,
    deduplicated: 0,
    skipped: 0,
    ...values,
  };
}

test("scheduler ignora cursor futuro e encontra cursor vencido somente após o instante", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db, "time");
  await makeDue(d1, fixture);
  let calls = 0;
  const runPlanner = async () => { calls += 1; return emptyPlannerSummary(); };

  assert.deepEqual(await runNotificationScheduler({ d1, now: "2026-09-21T11:59:59.000Z", runPlanner }), {
    examined: 0, claimed: 0, planned: 0, missed: 0, skipped: 0, failed: 0, outboxCreated: 0,
  });
  assert.equal(calls, 0);
  const due = await runNotificationScheduler({ d1, now: DUE, runPlanner, createLeaseToken: () => "lease-time" });
  assert.equal(due.examined, 1);
  assert.equal(due.claimed, 1);
  assert.equal(due.planned, 1);
  assert.equal(calls, 1);
});

test("claim antecede o planner e o planner recebe escopo e local_date exatos", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db, "scope");
  await makeDue(d1, fixture);
  const received = [];
  const summary = await runNotificationScheduler({
    d1,
    now: DUE,
    createLeaseToken: () => "lease-scope",
    async runPlanner(context) {
      const state = await getNotificationScheduleState(scheduleContext(d1, fixture, DUE));
      assert.equal(state.leaseToken, "lease-scope");
      received.push(context);
      return emptyPlannerSummary();
    },
  });

  assert.equal(summary.planned, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].householdId, fixture.household);
  assert.equal(received[0].userId, fixture.user);
  assert.equal(received[0].channel, "telegram");
  assert.equal(received[0].referenceDate, "2026-09-21");
});

test("slot perdido avança como missed sem executar planner", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db, "missed");
  const old = await makeDue(d1, fixture, "2026-09-20T10:00:00.000Z");
  let plannerCalls = 0;
  const summary = await runNotificationScheduler({
    d1,
    now: "2026-09-21T10:00:00.000Z",
    createLeaseToken: () => "lease-missed",
    runPlanner: async () => { plannerCalls += 1; return emptyPlannerSummary(); },
  });
  const state = await getNotificationScheduleState(scheduleContext(d1, fixture));

  assert.equal(old.scheduledLocalDate, "2026-09-20");
  assert.equal(plannerCalls, 0);
  assert.equal(summary.missed, 1);
  assert.equal(summary.planned, 0);
  assert.equal(state.lastCompletedLocalDate, "2026-09-20");
  assert.equal(state.lastResult, "missed");
  assert.equal(state.scheduledLocalDate, "2026-09-21");
});

test("sucesso conclui o cursor; falha conserva lease e recuperação não duplica outbox", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db, "recovery");
  addBill(db, fixture, "recovery");
  await makeDue(d1, fixture);
  let plannerCalls = 0;
  const partiallyFailingPlanner = async (context) => {
    plannerCalls += 1;
    const result = await runBillNotificationPlanner(context);
    if (plannerCalls === 1) throw new Error("synthetic planner failure");
    return result;
  };

  const failed = await runNotificationScheduler({
    d1,
    now: DUE,
    createLeaseToken: () => "lease-failed",
    createOutboxId: () => "outbox-once",
    runPlanner: partiallyFailingPlanner,
  });
  const leased = await getNotificationScheduleState(scheduleContext(d1, fixture));
  assert.equal(failed.failed, 1);
  assert.equal(leased.scheduledLocalDate, "2026-09-21");
  assert.equal(leased.lastResult, null);
  assert.equal(leased.leaseToken, "lease-failed");
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 1);

  const beforeExpiry = await runNotificationScheduler({
    d1,
    now: "2026-09-21T12:04:59.000Z",
    runPlanner: partiallyFailingPlanner,
  });
  assert.equal(beforeExpiry.examined, 0);
  const recovered = await runNotificationScheduler({
    d1,
    now: "2026-09-21T12:05:00.000Z",
    createLeaseToken: () => "lease-recovered",
    createOutboxId: () => "outbox-retry",
    runPlanner: partiallyFailingPlanner,
  });
  const completed = await getNotificationScheduleState(scheduleContext(d1, fixture));
  assert.equal(recovered.planned, 1);
  assert.equal(recovered.outboxCreated, 0);
  assert.equal(completed.lastResult, "completed");
  assert.equal(completed.scheduledLocalDate, "2026-09-22");
  assert.equal(completed.leaseToken, null);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 1);
});

test("duas execuções concorrentes processam o slot uma única vez", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db, "concurrent");
  await makeDue(d1, fixture);
  let plannerCalls = 0;
  const runPlanner = async () => { plannerCalls += 1; return emptyPlannerSummary(); };
  let leaseSequence = 0;
  const results = await Promise.all([
    runNotificationScheduler({ d1, now: DUE, runPlanner, createLeaseToken: () => `lease-${++leaseSequence}` }),
    runNotificationScheduler({ d1, now: DUE, runPlanner, createLeaseToken: () => `lease-${++leaseSequence}` }),
  ]);
  assert.equal(plannerCalls, 1);
  assert.equal(results.reduce((sum, item) => sum + item.claimed, 0), 1);
  assert.equal(results.reduce((sum, item) => sum + item.planned, 0), 1);
});

test("mudanças entre listagem e claim invalidam preferência, membership e snapshot", async (t) => {
  for (const scenario of ["disabled", "membership", "snapshot"]) {
    await t.test(scenario, async (t) => {
      const db = database(t);
      const d1 = new LocalD1(db);
      const fixture = seed(db, scenario);
      await makeDue(d1, fixture);
      let plannerCalls = 0;
      const summary = await runNotificationScheduler({
        d1,
        now: DUE,
        async onCandidate() {
          if (scenario === "disabled") {
            db.prepare("UPDATE user_notification_preferences SET enabled=0,updated_at=? WHERE household_id=? AND user_id=? AND channel='telegram'")
              .run("2026-09-21T11:59:00.000Z", fixture.household, fixture.user);
          } else if (scenario === "membership") {
            db.prepare("UPDATE household_members SET status='inactive' WHERE household_id=? AND user_id=?")
              .run(fixture.household, fixture.user);
          } else {
            db.prepare("UPDATE user_notification_preferences SET preferred_local_time='10:00',timezone='America/New_York',updated_at=? WHERE household_id=? AND user_id=? AND channel='telegram'")
              .run("2026-09-21T11:59:00.000Z", fixture.household, fixture.user);
          }
        },
        runPlanner: async () => { plannerCalls += 1; return emptyPlannerSummary(); },
      });
      assert.equal(summary.examined, 1);
      assert.equal(summary.claimed, 0);
      assert.equal(summary.skipped, 1);
      assert.equal(plannerCalls, 0);
    });
  }
});

test("integração local cria outbox só para household/usuário do cursor e é idempotente", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const a = seed(db, "integration-a");
  const otherUser = addMember(db, a.household, "integration-a-2");
  const b = seed(db, "integration-b");
  addBill(db, a, "integration-a");
  addBill(db, b, "integration-b");
  await makeDue(d1, a);
  let idSequence = 0;

  const first = await runNotificationScheduler({
    d1,
    now: DUE,
    createLeaseToken: () => "lease-integration",
    createOutboxId: () => `integration-${++idSequence}`,
  });
  const second = await runNotificationScheduler({ d1, now: DUE });
  const rows = db.prepare("SELECT household_id,recipient_user_id,channel,reference_date,status FROM notification_outbox").all();
  assert.equal(first.outboxCreated, 1);
  assert.equal(second.outboxCreated, 0);
  assert.deepEqual(rows.map((row) => ({ ...row })), [{
    household_id: a.household,
    recipient_user_id: a.user,
    channel: "telegram",
    reference_date: "2026-09-21",
    status: "pending",
  }]);
  assert.notEqual(rows[0].recipient_user_id, otherUser);
  assert.notEqual(rows[0].household_id, b.household);
});

test("limite explícito impede processar mais de 100 slots por ciclo e usa páginas de 50", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  for (let index = 0; index < 101; index += 1) {
    const fixture = seed(db, `limit-${String(index).padStart(3, "0")}`, { link: false });
    await makeDue(d1, fixture);
  }
  let plannerCalls = 0;
  let leaseSequence = 0;
  const summary = await runNotificationScheduler({
    d1,
    now: DUE,
    createLeaseToken: () => `lease-limit-${++leaseSequence}`,
    runPlanner: async () => { plannerCalls += 1; return emptyPlannerSummary(); },
  });
  assert.equal(summary.examined, 100);
  assert.equal(summary.claimed, 100);
  assert.equal(summary.planned, 100);
  assert.equal(plannerCalls, 100);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_schedule_state WHERE next_run_at=?").get(DUE).total, 1);
});

test("planner permanece isolado do dispatcher e entrypoint não usa envio legado", () => {
  const scheduler = readFileSync(new URL("../lib/notification-scheduler.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../worker/create-worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(scheduler, /notification-dispatcher|sendTelegramMessage|telegram-notification-transport|claimNotificationOutbox/u);
  assert.match(worker, /automatic-notification-dispatcher/u);
  assert.doesNotMatch(worker, /sendTelegramMessage/u);
});

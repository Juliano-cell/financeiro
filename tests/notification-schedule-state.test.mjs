import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  calculateNextNotificationSchedule,
  claimNotificationScheduleState,
  completeNotificationScheduleState,
  getNotificationScheduleState,
  listDueNotificationScheduleStates,
  resolveZonedScheduleInstant,
  synchronizeNotificationScheduleState,
} from "../lib/notification-schedule-state.ts";

const AT = "2026-09-21T10:00:00.000Z";

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

function seed(db, suffix = "a", options = {}) {
  const household = `house-${suffix}`;
  const user = `user-${suffix}`;
  const updatedAt = options.updatedAt ?? AT;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(user, user, `${user}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(`member-${suffix}`, household, user, "owner", "active", AT);
  db.prepare(`INSERT INTO user_notification_preferences(
    household_id,user_id,channel,enabled,preferred_local_time,timezone,created_at,updated_at
  ) VALUES(?,?,'telegram',?,?,?, ?,?)`).run(
    household,
    user,
    options.enabled === false ? 0 : 1,
    options.preferredLocalTime ?? "09:00",
    options.timezone ?? "America/Sao_Paulo",
    AT,
    updatedAt,
  );
  return { household, user };
}

function context(d1, fixture, now = AT, token = "lease-a") {
  return {
    d1,
    householdId: fixture.household,
    userId: fixture.user,
    channel: "telegram",
    now,
    createLeaseToken: () => token,
  };
}

function updatePreference(db, fixture, values) {
  const fields = [];
  const bindings = [];
  for (const [column, value] of Object.entries(values)) {
    fields.push(`${column}=?`);
    bindings.push(value);
  }
  db.prepare(`UPDATE user_notification_preferences SET ${fields.join(",")} WHERE household_id=? AND user_id=? AND channel='telegram'`)
    .run(...bindings, fixture.household, fixture.user);
}

test("cria cursor para horário futuro no mesmo dia em America/Sao_Paulo", async (t) => {
  const db = database(t);
  const fixture = seed(db);
  const state = await synchronizeNotificationScheduleState(context(new LocalD1(db), fixture));

  assert.equal(state.scheduledLocalDate, "2026-09-21");
  assert.equal(state.nextRunAt, "2026-09-21T12:00:00.000Z");
  assert.equal(state.leaseUntil, null);
});

test("horário já passado agenda o próximo dia civil", () => {
  assert.deepEqual(calculateNextNotificationSchedule({
    now: "2026-09-21T13:00:00.000Z",
    preferredLocalTime: "09:00",
    timezone: "America/Sao_Paulo",
  }), {
    scheduledLocalDate: "2026-09-22",
    nextRunAt: "2026-09-22T12:00:00.000Z",
  });
});

test("mudanças de horário e timezone recalculam o cursor", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db);
  await synchronizeNotificationScheduleState(context(d1, fixture));

  updatePreference(db, fixture, { preferred_local_time: "08:00", updated_at: "2026-09-21T10:01:00.000Z" });
  const changedTime = await synchronizeNotificationScheduleState(context(d1, fixture));
  assert.equal(changedTime.nextRunAt, "2026-09-21T11:00:00.000Z");

  updatePreference(db, fixture, { preferred_local_time: "09:00", timezone: "America/New_York", updated_at: "2026-09-21T10:02:00.000Z" });
  const changedZone = await synchronizeNotificationScheduleState(context(d1, fixture));
  assert.equal(changedZone.nextRunAt, "2026-09-21T13:00:00.000Z");
});

test("households diferentes mantêm cursores isolados", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const a = seed(db, "a");
  const b = seed(db, "b");
  await synchronizeNotificationScheduleState(context(d1, a));
  await synchronizeNotificationScheduleState(context(d1, b));

  const due = await listDueNotificationScheduleStates({ d1, now: "2026-09-21T12:00:00.000Z" });
  assert.deepEqual(due.map((state) => state.householdId), [a.household, b.household]);
});

test("dois claims concorrentes para o mesmo slot produzem um único vencedor", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db);
  const state = await synchronizeNotificationScheduleState(context(d1, fixture));
  const base = {
    ...context(d1, fixture, state.nextRunAt),
    expectedNextRunAt: state.nextRunAt,
    expectedScheduledLocalDate: state.scheduledLocalDate,
  };

  const claims = await Promise.all([
    claimNotificationScheduleState({ ...base, createLeaseToken: () => "lease-1" }),
    claimNotificationScheduleState({ ...base, createLeaseToken: () => "lease-2" }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean).leaseToken, "lease-1");
});

test("lease válido impede claim e lease expirado permite recuperação", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db);
  const state = await synchronizeNotificationScheduleState(context(d1, fixture));
  const expected = {
    expectedNextRunAt: state.nextRunAt,
    expectedScheduledLocalDate: state.scheduledLocalDate,
  };
  const first = await claimNotificationScheduleState({ ...context(d1, fixture, state.nextRunAt, "first"), ...expected });
  assert.ok(first);
  assert.equal(await claimNotificationScheduleState({ ...context(d1, fixture, "2026-09-21T12:04:59.000Z", "early"), ...expected }), null);
  assert.equal(await completeNotificationScheduleState({
    ...context(d1, fixture, "2026-09-21T12:05:00.000Z"),
    ...expected,
    leaseToken: first.leaseToken,
  }), null);
  const recovered = await claimNotificationScheduleState({ ...context(d1, fixture, "2026-09-21T12:05:00.000Z", "recovered"), ...expected });
  assert.equal(recovered.leaseToken, "recovered");
});

test("conclusão avança um dia e o mesmo local_date não pode ser repetido", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db);
  const state = await synchronizeNotificationScheduleState(context(d1, fixture));
  const expected = {
    expectedNextRunAt: state.nextRunAt,
    expectedScheduledLocalDate: state.scheduledLocalDate,
  };
  const claim = await claimNotificationScheduleState({ ...context(d1, fixture, state.nextRunAt, "claim"), ...expected });
  const completed = await completeNotificationScheduleState({
    ...context(d1, fixture, "2026-09-21T12:00:30.000Z"),
    ...expected,
    leaseToken: claim.leaseToken,
  });

  assert.equal(completed.lastCompletedLocalDate, "2026-09-21");
  assert.equal(completed.lastResult, "completed");
  assert.equal(completed.scheduledLocalDate, "2026-09-22");
  assert.equal(completed.nextRunAt, "2026-09-22T12:00:00.000Z");
  assert.equal(await claimNotificationScheduleState({ ...context(d1, fixture, "2026-09-21T12:01:00.000Z", "duplicate"), ...expected }), null);
});

test("preferência desabilitada deixa de ser elegível e a sincronização limpa o slot", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db);
  const state = await synchronizeNotificationScheduleState(context(d1, fixture));
  updatePreference(db, fixture, { enabled: 0, updated_at: "2026-09-21T10:03:00.000Z" });

  assert.deepEqual(await listDueNotificationScheduleStates({ d1, now: state.nextRunAt }), []);
  assert.equal(await claimNotificationScheduleState({
    ...context(d1, fixture, state.nextRunAt, "disabled"),
    expectedNextRunAt: state.nextRunAt,
    expectedScheduledLocalDate: state.scheduledLocalDate,
  }), null);
  const disabled = await synchronizeNotificationScheduleState(context(d1, fixture));
  assert.equal(disabled.nextRunAt, null);
  assert.equal(disabled.scheduledLocalDate, null);
});

test("slot de dia civil encerrado é marcado como perdido e recupera o dia atual", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const fixture = seed(db);
  const old = await synchronizeNotificationScheduleState(context(d1, fixture, "2026-09-20T10:00:00.000Z"));
  const expected = {
    expectedNextRunAt: old.nextRunAt,
    expectedScheduledLocalDate: old.scheduledLocalDate,
  };
  const claim = await claimNotificationScheduleState({ ...context(d1, fixture, "2026-09-21T10:00:00.000Z", "late"), ...expected });
  const completed = await completeNotificationScheduleState({
    ...context(d1, fixture, "2026-09-21T10:00:00.000Z"),
    ...expected,
    leaseToken: claim.leaseToken,
  });

  assert.equal(completed.lastCompletedLocalDate, "2026-09-20");
  assert.equal(completed.lastResult, "missed");
  assert.equal(completed.scheduledLocalDate, "2026-09-21");
  assert.equal(completed.nextRunAt, "2026-09-21T12:00:00.000Z");
});

test("DST resolve horário inexistente para o primeiro válido posterior", () => {
  assert.equal(
    resolveZonedScheduleInstant("2026-03-08", "02:30", "America/New_York"),
    "2026-03-08T07:00:00.000Z",
  );
});

test("DST resolve horário repetido uma única vez usando a primeira ocorrência", () => {
  assert.equal(
    resolveZonedScheduleInstant("2026-11-01", "01:30", "America/New_York"),
    "2026-11-01T05:30:00.000Z",
  );
});

test("leitura do cursor retorna somente a identidade solicitada", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const a = seed(db, "a");
  const b = seed(db, "b");
  await synchronizeNotificationScheduleState(context(d1, a));
  await synchronizeNotificationScheduleState(context(d1, b));
  const state = await getNotificationScheduleState(context(d1, a));
  assert.equal(state.householdId, a.household);
  assert.equal(state.userId, a.user);
});

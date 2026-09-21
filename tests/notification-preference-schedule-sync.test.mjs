import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { saveUserNotificationPreference } from "../lib/notification-foundation.ts";
import { bootstrapNotificationScheduleStates } from "../lib/notification-schedule-bootstrap.ts";

const AT = "2026-09-21T11:00:00.000Z";
const migrations = readdirSync(new URL("../drizzle", import.meta.url))
  .filter((name) => name.endsWith(".sql")).sort();

class Statement {
  constructor(owner, sql, bindings = []) { this.owner = owner; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.owner, this.sql, bindings); }
  async first(column) { const row = this.owner.db.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] : row; }
  async all() { return { success: true, results: this.owner.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  runSync() {
    const statement = this.owner.db.prepare(this.sql);
    if (statement.columns().length) return { success: true, results: statement.all(...this.bindings), meta: { changes: 0 } };
    const result = statement.run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async run() { return this.runSync(); }
}

class LocalD1 {
  constructor(db) { this.db = db; this.failBatchIndex = null; }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement, index) => {
        if (index === this.failBatchIndex) throw new Error("synthetic_batch_failure");
        return statement.runSync();
      });
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.failBatchIndex = null;
    }
  }
}

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) {
    for (const sql of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8")
      .split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(sql);
  }
  for (const [user, status] of [["active", "active"], ["inactive", "removed"]]) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(user, user, `${user}@example.test`, AT, AT);
    db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(`house-${user}`, user, user, AT, AT);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
      .run(`member-${user}`, `house-${user}`, user, "owner", status, AT);
  }
  const d1 = new LocalD1(db);
  t.after(() => {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
  });
  return { db, d1 };
}

function save(d1, changes = {}, now = AT) {
  return saveUserNotificationPreference({
    d1,
    householdId: "house-active",
    userId: "active",
    now,
  }, {
    channel: "telegram",
    enabled: true,
    preferredLocalTime: "09:00",
    timezone: "America/Sao_Paulo",
    ...changes,
  });
}

test("criar enabled=true sincroniza cursor e enabled=false não cria elegibilidade", async (t) => {
  const { db, d1 } = setup(t);
  await save(d1);
  assert.deepEqual({ ...db.prepare("SELECT next_run_at,scheduled_local_date,preference_updated_at FROM notification_schedule_state").get() }, {
    next_run_at: "2026-09-21T12:00:00.000Z",
    scheduled_local_date: "2026-09-21",
    preference_updated_at: AT,
  });
  db.prepare("DELETE FROM notification_schedule_state").run();
  db.prepare("DELETE FROM user_notification_preferences").run();
  await save(d1, { enabled: false });
  assert.equal(db.prepare("SELECT count(*) total FROM notification_schedule_state").get().total, 0);
});

test("habilitar, desabilitar e alterar horário/timezone recalculam atomicamente", async (t) => {
  const { db, d1 } = setup(t);
  await save(d1, { enabled: false });
  await save(d1, { enabled: true });
  assert.equal(db.prepare("SELECT next_run_at FROM notification_schedule_state").get().next_run_at, "2026-09-21T12:00:00.000Z");
  await save(d1, { enabled: true, preferredLocalTime: "10:30" }, "2026-09-21T11:01:00.000Z");
  assert.equal(db.prepare("SELECT next_run_at FROM notification_schedule_state").get().next_run_at, "2026-09-21T13:30:00.000Z");
  await save(d1, { enabled: true, preferredLocalTime: "10:30", timezone: "America/New_York" }, "2026-09-21T11:02:00.000Z");
  assert.equal(db.prepare("SELECT next_run_at FROM notification_schedule_state").get().next_run_at, "2026-09-21T14:30:00.000Z");
  await save(d1, { enabled: false, preferredLocalTime: "10:30", timezone: "America/New_York" }, "2026-09-21T11:03:00.000Z");
  assert.deepEqual({ ...db.prepare("SELECT next_run_at,scheduled_local_date,lease_until,lease_token FROM notification_schedule_state").get() }, {
    next_run_at: null, scheduled_local_date: null, lease_until: null, lease_token: null,
  });
});

test("reabilitação não repete local_date já concluída", async (t) => {
  const { db, d1 } = setup(t);
  await save(d1);
  db.prepare(`UPDATE notification_schedule_state
    SET last_completed_local_date='2026-09-21',last_result='completed',next_run_at=NULL,scheduled_local_date=NULL`).run();
  await save(d1, { enabled: false }, "2026-09-21T11:01:00.000Z");
  await save(d1, { enabled: true }, "2026-09-21T11:02:00.000Z");
  assert.deepEqual({ ...db.prepare("SELECT next_run_at,scheduled_local_date,last_completed_local_date FROM notification_schedule_state").get() }, {
    next_run_at: "2026-09-22T12:00:00.000Z",
    scheduled_local_date: "2026-09-22",
    last_completed_local_date: "2026-09-21",
  });
});

test("falha na sincronização reverte preferência e cursor no mesmo batch", async (t) => {
  const { db, d1 } = setup(t);
  await save(d1);
  const beforePreference = { ...db.prepare("SELECT * FROM user_notification_preferences").get() };
  const beforeCursor = { ...db.prepare("SELECT * FROM notification_schedule_state").get() };
  d1.failBatchIndex = 1;
  await assert.rejects(save(d1, { preferredLocalTime: "15:00" }, "2026-09-21T11:05:00.000Z"), /synthetic_batch_failure/u);
  assert.deepEqual({ ...db.prepare("SELECT * FROM user_notification_preferences").get() }, beforePreference);
  assert.deepEqual({ ...db.prepare("SELECT * FROM notification_schedule_state").get() }, beforeCursor);
});

test("bootstrap controlado é idempotente e ignora disabled e membership inativa", async (t) => {
  const { db, d1 } = setup(t);
  const insert = db.prepare(`INSERT INTO user_notification_preferences(
    household_id,user_id,channel,enabled,preferred_local_time,timezone,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?)`);
  insert.run("house-active", "active", "telegram", 1, "09:00", "America/Sao_Paulo", AT, AT);
  insert.run("house-active", "active", "push", 0, "09:00", "America/Sao_Paulo", AT, AT);
  insert.run("house-inactive", "inactive", "telegram", 1, "09:00", "America/Sao_Paulo", AT, AT);
  assert.deepEqual(await bootstrapNotificationScheduleStates({ d1, now: AT }), {
    examined: 1, created: 1, skipped: 0, failed: 0,
  });
  assert.deepEqual(await bootstrapNotificationScheduleStates({ d1, now: AT }), {
    examined: 0, created: 0, skipped: 0, failed: 0,
  });
  assert.equal(db.prepare("SELECT count(*) total FROM notification_schedule_state").get().total, 1);
  assert.equal(db.prepare("SELECT channel FROM notification_schedule_state").get().channel, "telegram");
});

test("bootstrap não possui rota, Cron ou importação automática", () => {
  const worker = readFileSync(new URL("../worker/create-worker.ts", import.meta.url), "utf8");
  const routes = [
    readFileSync(new URL("../app/api/notifications/run/route.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../app/api/notifications/preferences/route.ts", import.meta.url), "utf8"),
  ].join("\n");
  assert.doesNotMatch(`${worker}\n${routes}`, /notification-schedule-bootstrap|bootstrapNotificationScheduleStates/u);
});

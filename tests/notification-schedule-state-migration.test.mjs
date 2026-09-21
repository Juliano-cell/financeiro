import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const AT = "2026-09-21T10:00:00.000Z";
const migrations = readdirSync(new URL("../drizzle", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();

function applyMigration(db, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    db.exec(statement);
  }
}

function databaseThrough(t, final = migrations.at(-1)) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of migrations) {
    applyMigration(db, migration);
    if (migration === final) break;
  }
  t.after(() => {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
  });
  return db;
}

function seedPreference(db, suffix = "a") {
  const household = `house-${suffix}`;
  const user = `user-${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(user, user, `${user}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(`member-${suffix}`, household, user, "owner", "active", AT);
  db.prepare(`INSERT INTO user_notification_preferences(
    household_id,user_id,channel,enabled,preferred_local_time,timezone,created_at,updated_at
  ) VALUES(?,?,'telegram',1,'09:00','America/Sao_Paulo',?,?)`).run(household, user, AT, AT);
  return { household, user };
}

function insertState(db, fixture, overrides = {}) {
  db.prepare(`INSERT INTO notification_schedule_state(
    household_id,user_id,channel,preferred_local_time,timezone,preference_updated_at,
    next_run_at,scheduled_local_date,lease_until,lease_token,
    last_completed_local_date,last_result,created_at,updated_at
  ) VALUES(?,?,'telegram',?,?,?,?,?,?,?,?,?,?,?)`).run(
    fixture.household,
    fixture.user,
    overrides.preferredLocalTime ?? "09:00",
    overrides.timezone ?? "America/Sao_Paulo",
    overrides.preferenceUpdatedAt ?? AT,
    overrides.nextRunAt === undefined ? "2026-09-21T12:00:00.000Z" : overrides.nextRunAt,
    overrides.scheduledLocalDate === undefined ? "2026-09-21" : overrides.scheduledLocalDate,
    overrides.leaseUntil ?? null,
    overrides.leaseToken ?? null,
    overrides.lastCompletedLocalDate ?? null,
    overrides.lastResult ?? null,
    AT,
    AT,
  );
}

test("0008 é posterior à 0007, cria o cursor e não faz backfill", (t) => {
  assert.equal(migrations[migrations.indexOf("0007_notification_foundation.sql") + 1], "0008_notification_schedule_state.sql");
  const db = databaseThrough(t, "0007_notification_foundation.sql");
  const fixture = seedPreference(db);
  applyMigration(db, "0008_notification_schedule_state.sql");

  assert.equal(db.prepare("SELECT count(*) total FROM notification_schedule_state").get().total, 0);
  insertState(db, fixture);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_schedule_state").get().total, 1);
});

test("0008 possui identidade única, FK de preferência e índices de due/lease", (t) => {
  const db = databaseThrough(t);
  const fixture = seedPreference(db);
  insertState(db, fixture);

  assert.throws(() => insertState(db, fixture), /UNIQUE/);
  const indexes = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notification_schedule_state'")
      .all()
      .map((row) => row.name),
  );
  assert.ok(indexes.has("idx_notification_schedule_state_due"));
  assert.ok(indexes.has("idx_notification_schedule_state_lease"));
  assert.ok(db.prepare("PRAGMA foreign_key_list(notification_schedule_state)").all()
    .some((key) => key.table === "user_notification_preferences"));

  db.prepare("DELETE FROM user_notification_preferences WHERE household_id=? AND user_id=? AND channel='telegram'")
    .run(fixture.household, fixture.user);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_schedule_state").get().total, 0);
});

test("0008 valida canal, datas, UTC, lease e resultado", (t) => {
  const db = databaseThrough(t);
  const fixture = seedPreference(db);

  assert.throws(() => insertState(db, fixture, { nextRunAt: "2026-09-21 12:00:00", scheduledLocalDate: "2026-09-21" }), /CHECK/);
  assert.throws(() => insertState(db, fixture, { preferenceUpdatedAt: "2026-09-21 10:00:00" }), /CHECK/);
  assert.throws(() => insertState(db, fixture, { scheduledLocalDate: "2026-02-30" }), /CHECK/);
  assert.throws(() => insertState(db, fixture, { leaseUntil: "2026-09-21T12:05:00.000Z" }), /CHECK/);
  assert.throws(() => insertState(db, fixture, { lastResult: "completed" }), /CHECK/);
  assert.throws(() => insertState(db, fixture, { nextRunAt: null, scheduledLocalDate: "2026-09-21" }), /CHECK/);
});

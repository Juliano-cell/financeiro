import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const AT = "2026-09-20T12:00:00.000Z";
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

function applyMigration(db, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
}

function databaseThrough(t, final = migrations.at(-1)) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) {
    applyMigration(db, name);
    if (name === final) break;
  }
  t.after(() => {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
  });
  return db;
}

function seedHousehold(db, suffix, secondUser = false) {
  const household = `house-${suffix}`;
  const user = `user-${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, household, user, "owner", "active", AT);
  if (secondUser) {
    const other = `user-${suffix}-2`;
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(other, other, `${suffix}-2@example.com`, AT, AT);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}-2`, household, other, "member", "active", AT);
  }
  return { household, user, other: secondUser ? `user-${suffix}-2` : null };
}

function insertBill(db, id, household, user, dueDate = "2026-09-20") {
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,due_date,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,'none','pending',?,'web',?,?)")
    .run(id, household, id, 1000, dueDate, user, AT, AT);
}

function insertPreference(db, household, user, channel = "telegram", enabled = 1) {
  db.prepare("INSERT INTO user_notification_preferences(household_id,user_id,channel,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run(household, user, channel, enabled, AT, AT);
}

function insertOutbox(db, values) {
  db.prepare(`INSERT INTO notification_outbox(
    id,household_id,recipient_user_id,channel,entity_type,entity_id,event_type,
    reference_date,dedupe_key,status,attempts,next_attempt_at,lease_until,
    provider_message_id,last_error,created_at,updated_at,sent_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.id,
    values.household,
    values.user,
    values.channel ?? "telegram",
    values.entityType ?? "bill",
    values.entityId,
    values.eventType ?? "bill_due_today",
    values.referenceDate ?? "2026-09-20",
    values.dedupeKey,
    values.status ?? "pending",
    values.attempts ?? 0,
    values.nextAttemptAt ?? AT,
    values.leaseUntil ?? null,
    values.providerMessageId ?? null,
    values.lastError ?? null,
    AT,
    AT,
    values.sentAt ?? null,
  );
}

test("0007 é sequencial, não faz backfill e cria preferências opt-in individuais", (t) => {
  assert.equal(migrations.at(-1), "0007_notification_foundation.sql");
  const db = databaseThrough(t, "0006_card_financial_onboarding.sql");
  const a = seedHousehold(db, "a", true);
  db.prepare("INSERT INTO notification_preferences(household_id,enabled,offsets_json,updated_at) VALUES(?,1,'[1,0,-1]',?)").run(a.household, AT);
  applyMigration(db, "0007_notification_foundation.sql");

  assert.equal(db.prepare("SELECT count(*) total FROM user_notification_preferences").get().total, 0);
  insertPreference(db, a.household, a.user, "telegram", 0);
  insertPreference(db, a.household, a.other, "telegram", 1);
  const rows = db.prepare("SELECT user_id,enabled,timezone,preferred_local_time FROM user_notification_preferences ORDER BY user_id").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { user_id: a.user, enabled: 0, timezone: "America/Sao_Paulo", preferred_local_time: "09:00" },
    { user_id: a.other, enabled: 1, timezone: "America/Sao_Paulo", preferred_local_time: "09:00" },
  ]);
});

test("0007 cria índices, FKs e constraints de household, canal, data e preferência", (t) => {
  const db = databaseThrough(t);
  const a = seedHousehold(db, "a");
  const b = seedHousehold(db, "b");
  insertBill(db, "bill-a", a.household, a.user);
  insertPreference(db, a.household, a.user);

  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
  for (const name of ["notification_outbox_dedupe_key_unique", "notification_outbox_logical_event_unique", "idx_notification_outbox_dispatch", "idx_notification_outbox_household_recipient", "idx_user_notification_preferences_enabled_channel"]) assert.ok(indexes.has(name), name);
  assert.ok(db.prepare("PRAGMA foreign_key_list(notification_outbox)").all().some((key) => key.table === "user_notification_preferences"));
  assert.throws(() => insertPreference(db, b.household, a.user), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO user_notification_preferences(household_id,user_id,channel,created_at,updated_at) VALUES(?,?,'email',?,?)").run(a.household, a.user, AT, AT), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO user_notification_preferences(household_id,user_id,channel,preferred_local_time,created_at,updated_at) VALUES(?,?,'push','29:99',?,?)").run(a.household, a.user, AT, AT), /CHECK/);
  assert.throws(() => insertOutbox(db, { id: "bad-date", household: a.household, user: a.user, entityId: "bill-a", referenceDate: "2026-02-30", dedupeKey: "bad-date" }), /CHECK/);
  assert.throws(() => insertOutbox(db, { id: "cross-bill", household: a.household, user: a.user, entityId: "missing", dedupeKey: "cross-bill" }), /another household|does not exist/);
});

test("0007 bloqueia duplicatas concorrentes e separa usuário, evento e household", (t) => {
  const db = databaseThrough(t);
  const a = seedHousehold(db, "a", true);
  const b = seedHousehold(db, "b");
  insertBill(db, "bill-a", a.household, a.user);
  insertBill(db, "bill-b", b.household, b.user);
  insertPreference(db, a.household, a.user);
  insertPreference(db, a.household, a.other);
  insertPreference(db, b.household, b.user);

  insertOutbox(db, { id: "a-1", household: a.household, user: a.user, entityId: "bill-a", dedupeKey: "a:user-1:today" });
  assert.throws(() => insertOutbox(db, { id: "a-duplicate", household: a.household, user: a.user, entityId: "bill-a", dedupeKey: "another-key" }), /UNIQUE/);
  insertOutbox(db, { id: "a-user-2", household: a.household, user: a.other, entityId: "bill-a", dedupeKey: "a:user-2:today" });
  insertOutbox(db, { id: "a-tomorrow", household: a.household, user: a.user, entityId: "bill-a", eventType: "bill_due_tomorrow", referenceDate: "2026-09-19", dedupeKey: "a:user-1:tomorrow" });
  insertOutbox(db, { id: "b-1", household: b.household, user: b.user, entityId: "bill-b", dedupeKey: "b:user-1:today" });
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 4);
  assert.deepEqual(db.prepare("SELECT household_id,count(*) total FROM notification_outbox GROUP BY household_id ORDER BY household_id").all().map((row) => ({ ...row })), [
    { household_id: a.household, total: 3 },
    { household_id: b.household, total: 1 },
  ]);
});

test("0007 aceita somente estados coerentes e torna a identidade da outbox imutável", (t) => {
  const db = databaseThrough(t);
  const a = seedHousehold(db, "a");
  insertPreference(db, a.household, a.user);
  const statuses = ["pending", "processing", "sent", "failed", "uncertain", "cancelled"];
  statuses.forEach((status, index) => insertOutbox(db, {
    id: `status-${status}`,
    household: a.household,
    user: a.user,
    entityType: "household",
    entityId: a.household,
    eventType: "upcoming_digest",
    referenceDate: `2026-09-${String(10 + index).padStart(2, "0")}`,
    dedupeKey: `status:${status}`,
    status,
    leaseUntil: status === "processing" ? "2026-09-20T12:05:00.000Z" : null,
    sentAt: status === "sent" ? AT : null,
  }));
  assert.deepEqual(db.prepare("SELECT status FROM notification_outbox ORDER BY status").all().map((row) => row.status), [...statuses].sort());
  assert.throws(() => insertOutbox(db, { id: "invalid", household: a.household, user: a.user, entityType: "household", entityId: a.household, eventType: "upcoming_digest", referenceDate: "2026-09-30", dedupeKey: "invalid", status: "retrying" }), /CHECK/);
  assert.throws(() => db.prepare("UPDATE notification_outbox SET reference_date='2026-10-01' WHERE id='status-pending'").run(), /immutable/);
});

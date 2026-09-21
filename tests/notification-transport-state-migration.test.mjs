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

function insertState(db, overrides = {}) {
  db.prepare(`INSERT INTO notification_transport_state(
    channel,paused_until,lease_until,lease_token,created_at,updated_at
  ) VALUES(?,?,?,?,?,?)`).run(
    overrides.channel ?? "telegram",
    overrides.pausedUntil ?? null,
    overrides.leaseUntil ?? null,
    overrides.leaseToken ?? null,
    overrides.createdAt ?? AT,
    overrides.updatedAt ?? AT,
  );
}

test("0009 sucede 0008, cria estado operacional sem backfill e preserva migrations anteriores", (t) => {
  assert.equal(migrations[migrations.indexOf("0008_notification_schedule_state.sql") + 1], "0009_notification_transport_state.sql");
  const db = databaseThrough(t, "0008_notification_schedule_state.sql");
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_schedule_state'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_outbox'").get());

  applyMigration(db, "0009_notification_transport_state.sql");
  assert.equal(db.prepare("SELECT count(*) total FROM notification_transport_state").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_schedule_state").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 0);
});

test("0009 usa channel como PK, aceita canais oficiais e não cria índice secundário", (t) => {
  const db = databaseThrough(t);
  insertState(db, { channel: "telegram" });
  insertState(db, { channel: "push" });
  assert.throws(() => insertState(db, { channel: "telegram" }), /UNIQUE/);
  assert.throws(() => insertState(db, { channel: "email" }), /CHECK/);
  const indexes = db.prepare("SELECT name,origin FROM pragma_index_list('notification_transport_state')").all();
  assert.equal(indexes.length, 1);
  assert.equal(indexes[0].origin, "pk");
});

test("0009 exige UTC canônico e coerência entre lease_until e lease_token", (t) => {
  const invalid = [
    { pausedUntil: "2026-09-21 10:00:00" },
    { pausedUntil: "2026-09-21T10:00:00.000-03:00" },
    { leaseUntil: "2026-09-21 10:05:00", leaseToken: "lease" },
    { leaseUntil: "2026-09-21T10:05:00.000Z" },
    { leaseToken: "lease" },
    { leaseUntil: "2026-09-21T10:05:00.000Z", leaseToken: "   " },
    { createdAt: "2026-09-21 10:00:00" },
    { updatedAt: "invalid" },
  ];
  for (const [index, values] of invalid.entries()) {
    const db = databaseThrough(t);
    assert.throws(() => insertState(db, { channel: index % 2 ? "push" : "telegram", ...values }), /CHECK/);
  }
});

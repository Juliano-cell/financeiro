import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  acquireNotificationTransportLease,
  getNotificationTransportState,
  isNotificationTransportPaused,
  pauseNotificationTransport,
  releaseNotificationTransportLease,
} from "../lib/notification-transport-state.ts";

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
    db.close();
  });
  return db;
}

function acquire(d1, now, token) {
  return acquireNotificationTransportLease({
    d1,
    channel: "telegram",
    now,
    createLeaseToken: () => token,
  });
}

test("estado nasce lazy e somente um lease concorrente vence", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  assert.equal(await getNotificationTransportState({ d1, channel: "telegram" }), null);
  const results = await Promise.all([acquire(d1, AT, "lease-a"), acquire(d1, AT, "lease-b")]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean).leaseToken, "lease-a");
  assert.equal(db.prepare("SELECT count(*) total FROM notification_transport_state").get().total, 1);
});

test("lease válido bloqueia e lease expirado permite recuperação com fencing", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  const first = await acquire(d1, AT, "old-token");
  assert.ok(first);
  assert.equal(await acquire(d1, "2026-09-21T10:04:59.000Z", "early"), null);
  const recovered = await acquire(d1, "2026-09-21T10:05:00.000Z", "new-token");
  assert.equal(recovered.leaseToken, "new-token");
  assert.equal(await pauseNotificationTransport({
    d1,
    channel: "telegram",
    now: "2026-09-21T10:05:01.000Z",
    leaseToken: "old-token",
    pausedUntil: "2026-09-21T10:20:00.000Z",
  }), null);
  assert.equal(await releaseNotificationTransportLease({
    d1, channel: "telegram", now: "2026-09-21T10:05:01.000Z", leaseToken: "old-token",
  }), false);
  assert.equal((await getNotificationTransportState({ d1, channel: "telegram" })).leaseToken, "new-token");
  assert.equal(await releaseNotificationTransportLease({
    d1, channel: "telegram", now: "2026-09-21T10:05:01.000Z", leaseToken: "new-token",
  }), true);
});

test("pausa persiste entre instâncias, bloqueia aquisição e expira", async (t) => {
  const db = database(t);
  const firstD1 = new LocalD1(db);
  await acquire(firstD1, AT, "lease-pause");
  const paused = await pauseNotificationTransport({
    d1: firstD1,
    channel: "telegram",
    now: AT,
    leaseToken: "lease-pause",
    pausedUntil: "2026-09-21T10:10:00.000Z",
  });
  assert.equal(paused.pausedUntil, "2026-09-21T10:10:00.000Z");
  await releaseNotificationTransportLease({ d1: firstD1, channel: "telegram", now: AT, leaseToken: "lease-pause" });

  const secondD1 = new LocalD1(db);
  const persisted = await getNotificationTransportState({ d1: secondD1, channel: "telegram" });
  assert.equal(isNotificationTransportPaused(persisted, "2026-09-21T10:09:59.000Z"), true);
  assert.equal(await acquire(secondD1, "2026-09-21T10:09:59.000Z", "blocked"), null);
  const resumed = await acquire(secondD1, "2026-09-21T10:10:00.000Z", "resumed");
  assert.equal(resumed.leaseToken, "resumed");
  assert.equal(resumed.pausedUntil, null);
});

test("pausa maior nunca é encurtada e token antigo não consegue alterá-la", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  await acquire(d1, AT, "lease-longest");
  await pauseNotificationTransport({
    d1, channel: "telegram", now: AT, leaseToken: "lease-longest", pausedUntil: "2026-09-21T10:20:00.000Z",
  });
  const shorter = await pauseNotificationTransport({
    d1, channel: "telegram", now: AT, leaseToken: "lease-longest", pausedUntil: "2026-09-21T10:10:00.000Z",
  });
  assert.equal(shorter.pausedUntil, "2026-09-21T10:20:00.000Z");
  assert.equal(await pauseNotificationTransport({
    d1, channel: "telegram", now: AT, leaseToken: "stale", pausedUntil: "2026-09-21T10:30:00.000Z",
  }), null);
  assert.equal((await getNotificationTransportState({ d1, channel: "telegram" })).pausedUntil, "2026-09-21T10:20:00.000Z");
});

test("atualizações concorrentes preservam o maior paused_until", async (t) => {
  const db = database(t);
  const d1 = new LocalD1(db);
  await acquire(d1, AT, "lease-concurrent");
  await Promise.all([
    pauseNotificationTransport({ d1, channel: "telegram", now: AT, leaseToken: "lease-concurrent", pausedUntil: "2026-09-21T10:07:00.000Z" }),
    pauseNotificationTransport({ d1, channel: "telegram", now: AT, leaseToken: "lease-concurrent", pausedUntil: "2026-09-21T10:15:00.000Z" }),
  ]);
  assert.equal((await getNotificationTransportState({ d1, channel: "telegram" })).pausedUntil, "2026-09-21T10:15:00.000Z");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  NOTIFICATION_OUTBOX_STATUSES,
  NotificationFoundationError,
  billNotificationEvent,
  buildNotificationDedupeKey,
  classifyBillNotification,
  createNotificationOutboxItem,
  getUserNotificationPreference,
  isNotificationOutboxStatus,
  notificationLocalDate,
  sanitizeNotificationError,
  saveUserNotificationPreference,
  upcomingDigestEvent,
  validateNotificationPreference,
} from "../lib/notification-foundation.ts";

const AT = "2026-09-20T12:00:00.000Z";

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
  async first() { return this.db.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  runSync() { const result = this.db.prepare(this.sql).run(...this.bindings); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
  async run() { return this.runSync(); }
}

class LocalD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
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

function seedHousehold(db, suffix, secondUser = false) {
  const household = `house-${suffix}`;
  const user = `user-${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, household, user, "owner", "active", AT);
  let other = null;
  if (secondUser) {
    other = `user-${suffix}-2`;
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(other, other, `${suffix}-2@example.com`, AT, AT);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}-2`, household, other, "member", "active", AT);
  }
  const bill = `bill-${suffix}`;
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,due_date,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,'none','pending',?,'web',?,?)")
    .run(bill, household, bill, 1000, "2026-09-20", user, AT, AT);
  return { household, user, other, bill };
}

function context(d1, householdId, userId, suffix) {
  let sequence = 0;
  return { d1, householdId, userId, now: AT, createId: () => `${suffix}-${++sequence}` };
}

function setup(t) {
  const db = database(t);
  const d1 = new LocalD1(db);
  const a = seedHousehold(db, "a", true);
  const b = seedHousehold(db, "b");
  return { db, d1, a, b };
}

test("preferências são individuais para dois usuários da mesma família", async (t) => {
  const f = setup(t);
  const first = context(f.d1, f.a.household, f.a.user, "a1");
  const second = context(f.d1, f.a.household, f.a.other, "a2");
  assert.equal(await getUserNotificationPreference(first, "telegram"), null);
  const enabled = await saveUserNotificationPreference(first, { channel: "telegram", enabled: true, upcomingDigest: true, preferredLocalTime: "08:30" });
  const disabled = await saveUserNotificationPreference(second, { channel: "telegram", enabled: false, billDueToday: false });
  assert.deepEqual([enabled.enabled, enabled.upcomingDigest, enabled.preferredLocalTime], [true, true, "08:30"]);
  assert.deepEqual([disabled.enabled, disabled.billDueToday], [false, false]);
  assert.equal((await getUserNotificationPreference(first, "telegram")).userId, f.a.user);
  assert.equal((await getUserNotificationPreference(second, "telegram")).userId, f.a.other);
});

test("dois households ficam isolados e membership ativa é obrigatória", async (t) => {
  const f = setup(t);
  const a = context(f.d1, f.a.household, f.a.user, "a");
  const b = context(f.d1, f.b.household, f.b.user, "b");
  await saveUserNotificationPreference(a, { channel: "telegram", enabled: true });
  await saveUserNotificationPreference(b, { channel: "telegram", enabled: true, billOverdue: false });
  assert.equal((await getUserNotificationPreference(a, "telegram")).billOverdue, true);
  assert.equal((await getUserNotificationPreference(b, "telegram")).billOverdue, false);
  await assert.rejects(() => saveUserNotificationPreference(context(f.d1, f.b.household, f.a.user, "cross"), { channel: "telegram", enabled: true }), (error) => error instanceof NotificationFoundationError && error.code === "NOTIFICATION_INACTIVE_MEMBERSHIP");
  f.db.prepare("UPDATE household_members SET status='inactive' WHERE household_id=? AND user_id=?").run(f.a.household, f.a.user);
  assert.equal(await getUserNotificationPreference(a, "telegram"), null);
  await assert.rejects(() => saveUserNotificationPreference(a, { channel: "telegram", enabled: true }), /membership ativa/iu);
});

test("validação aceita Telegram e rejeita canal, horário e timezone inválidos", () => {
  assert.deepEqual(validateNotificationPreference({ channel: "telegram" }), {
    channel: "telegram", enabled: false, billDueTomorrow: true, billDueToday: true,
    billOverdue: true, upcomingDigest: false, preferredLocalTime: "09:00", timezone: "America/Sao_Paulo",
  });
  assert.throws(() => validateNotificationPreference({ channel: "email" }), /Canal inválido/);
  assert.throws(() => validateNotificationPreference({ channel: "telegram", preferredLocalTime: "25:00" }), /Horário local inválido/);
  assert.throws(() => validateNotificationPreference({ channel: "telegram", timezone: "Invalid\/Timezone" }), /Timezone inválido/);
});

test("dia civil usa America/Sao_Paulo na virada UTC", () => {
  assert.equal(notificationLocalDate("2026-09-21T01:30:00.000Z", "America/Sao_Paulo"), "2026-09-20");
  assert.equal(notificationLocalDate("2026-09-21T03:30:00.000Z", "America/Sao_Paulo"), "2026-09-21");
});

test("amanhã, hoje e atraso têm eventos determinísticos sem atraso diário", () => {
  const now = "2026-09-20T12:00:00.000Z";
  assert.equal(classifyBillNotification("2026-09-21", now), "bill_due_tomorrow");
  assert.equal(classifyBillNotification("2026-09-20", now), "bill_due_today");
  assert.equal(classifyBillNotification("2026-09-19", now), "bill_overdue");
  assert.equal(classifyBillNotification("2026-09-22", now), null);
  assert.deepEqual(billNotificationEvent("bill-1", "2026-09-21", now), { entityType: "bill", entityId: "bill-1", eventType: "bill_due_tomorrow", referenceDate: "2026-09-20" });
  assert.deepEqual(billNotificationEvent("bill-1", "2026-09-20", now), { entityType: "bill", entityId: "bill-1", eventType: "bill_due_today", referenceDate: "2026-09-20" });
  assert.equal(billNotificationEvent("bill-1", "2026-09-17", now).referenceDate, "2026-09-18");
  assert.equal(billNotificationEvent("bill-1", "2026-09-17", "2026-09-25T12:00:00.000Z").referenceDate, "2026-09-18");
});

test("dedupe_key é determinística e inclui household, destinatário, canal e evento", () => {
  const input = { householdId: "house:a", recipientUserId: "user:a", channel: "telegram", entityType: "bill", entityId: "bill:1", eventType: "bill_due_today", referenceDate: "2026-09-20" };
  const first = buildNotificationDedupeKey(input);
  assert.equal(first, buildNotificationDedupeKey({ ...input }));
  assert.match(first, /^house%3Aa:user%3Aa:telegram:bill:bill%3A1:bill_due_today:2026-09-20$/u);
  assert.notEqual(first, buildNotificationDedupeKey({ ...input, recipientUserId: "user:b" }));
  assert.notEqual(first, buildNotificationDedupeKey({ ...input, householdId: "house:b" }));
});

test("mesmo evento concorrente cria somente um item na outbox", async (t) => {
  const f = setup(t);
  const ctx = context(f.d1, f.a.household, f.a.user, "concurrent");
  await saveUserNotificationPreference(ctx, { channel: "telegram", enabled: true });
  const event = { entityType: "bill", entityId: f.a.bill, eventType: "bill_due_today", referenceDate: "2026-09-20" };
  const results = await Promise.all([
    createNotificationOutboxItem(ctx, "telegram", event),
    createNotificationOutboxItem(ctx, "telegram", event),
  ]);
  assert.deepEqual(results.map((result) => [result.created, result.duplicate]).sort(), [[false, true], [true, false]]);
  assert.equal(f.db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 1);
});

test("preferência desativada ou evento desativado não cria outbox", async (t) => {
  const f = setup(t);
  const ctx = context(f.d1, f.a.household, f.a.user, "disabled");
  await saveUserNotificationPreference(ctx, { channel: "telegram", enabled: false });
  const event = { entityType: "bill", entityId: f.a.bill, eventType: "bill_due_today", referenceDate: "2026-09-20" };
  assert.deepEqual(await createNotificationOutboxItem(ctx, "telegram", event), { created: false, duplicate: false, item: null });
  await saveUserNotificationPreference(ctx, { channel: "telegram", enabled: true, billDueToday: false });
  assert.equal((await createNotificationOutboxItem(ctx, "telegram", event)).created, false);
  assert.equal(f.db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 0);
});

test("eventos diferentes para a mesma bill e usuários diferentes não colidem", async (t) => {
  const f = setup(t);
  const first = context(f.d1, f.a.household, f.a.user, "first");
  const second = context(f.d1, f.a.household, f.a.other, "second");
  await saveUserNotificationPreference(first, { channel: "telegram", enabled: true });
  await saveUserNotificationPreference(second, { channel: "telegram", enabled: true });
  const today = { entityType: "bill", entityId: f.a.bill, eventType: "bill_due_today", referenceDate: "2026-09-20" };
  const overdue = { ...today, eventType: "bill_overdue", referenceDate: "2026-09-21" };
  assert.equal((await createNotificationOutboxItem(first, "telegram", today)).created, true);
  assert.equal((await createNotificationOutboxItem(first, "telegram", overdue)).created, true);
  assert.equal((await createNotificationOutboxItem(second, "telegram", today)).created, true);
  assert.equal(f.db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 3);
});

test("mesma data em households diferentes e upcoming_digest permanecem isolados", async (t) => {
  const f = setup(t);
  const a = context(f.d1, f.a.household, f.a.user, "ha");
  const b = context(f.d1, f.b.household, f.b.user, "hb");
  await saveUserNotificationPreference(a, { channel: "telegram", enabled: true, upcomingDigest: true });
  await saveUserNotificationPreference(b, { channel: "telegram", enabled: true, upcomingDigest: true });
  assert.equal((await createNotificationOutboxItem(a, "telegram", { entityType: "bill", entityId: f.a.bill, eventType: "bill_due_today", referenceDate: "2026-09-20" })).created, true);
  assert.equal((await createNotificationOutboxItem(b, "telegram", { entityType: "bill", entityId: f.b.bill, eventType: "bill_due_today", referenceDate: "2026-09-20" })).created, true);
  assert.equal((await createNotificationOutboxItem(a, "telegram", upcomingDigestEvent(f.a.household, AT))).created, true);
  assert.equal((await createNotificationOutboxItem(b, "telegram", upcomingDigestEvent(f.b.household, AT))).created, true);
  assert.deepEqual(f.db.prepare("SELECT household_id,count(*) total FROM notification_outbox GROUP BY household_id ORDER BY household_id").all().map((row) => ({ ...row })), [
    { household_id: f.a.household, total: 2 },
    { household_id: f.b.household, total: 2 },
  ]);
});

test("status são fechados e erros sanitizados não preservam secrets nem chat_id", () => {
  assert.deepEqual(NOTIFICATION_OUTBOX_STATUSES.filter(isNotificationOutboxStatus), NOTIFICATION_OUTBOX_STATUSES);
  assert.equal(isNotificationOutboxStatus("retrying"), false);
  const sanitized = sanitizeNotificationError(new Error("Bearer super-secret TELEGRAM_BOT_TOKEN=123456:ABCDEFGHIJK chat_id=998877 password=hunter2"));
  for (const secret of ["super-secret", "123456:ABCDEFGHIJK", "998877", "hunter2"]) assert.doesNotMatch(sanitized, new RegExp(secret, "u"));
  assert.match(sanitized, /REDACTED/u);
  assert.ok(sanitized.length <= 500);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildNotificationDedupeKey } from "../lib/notification-foundation.ts";
import { runBillNotificationPlanner } from "../lib/notification-planner.ts";

const AT = "2026-09-20T12:00:00.000Z";

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

function seedHousehold(db, suffix, options = {}) {
  const household = `house-${suffix}`;
  const user = options.user ?? `user-${suffix}`;
  if (!db.prepare("SELECT id FROM users WHERE id=?").get(user)) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, `${user}@example.com`, AT, AT);
  }
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(household, household, user, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}-${user}`, household, user, "owner", options.status ?? "active", AT);
  return { household, user };
}

function addMember(db, household, suffix) {
  const user = `user-${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, user, `${user}@example.com`, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member-${suffix}`, household, user, "member", "active", AT);
  return user;
}

function addPreference(db, household, user, values = {}) {
  db.prepare(`INSERT INTO user_notification_preferences(
    household_id,user_id,channel,enabled,bill_due_tomorrow,bill_due_today,bill_overdue,
    upcoming_digest,preferred_local_time,timezone,created_at,updated_at
  ) VALUES(?,?,'telegram',?,?,?,?,0,'09:00',?,?,?)`).run(
    household, user, values.enabled ?? 1, values.tomorrow ?? 1, values.today ?? 1,
    values.overdue ?? 1, values.timezone ?? "America/Sao_Paulo", AT, AT,
  );
}

function addLink(db, household, user, suffix) {
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,is_active,linked_at,updated_at) VALUES(?,?,?,?,?,1,?,?)")
    .run(`link-${suffix}`, household, user, `telegram-${suffix}`, `chat-${suffix}`, AT, AT);
}

function addBill(db, household, user, suffix, dueDate, status = "pending", amountCents = 1000) {
  const id = `bill-${suffix}`;
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,due_date,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,'none',?,?,'web',?,?)")
    .run(id, household, `Sensitive ${suffix}`, amountCents, dueDate, status, user, AT, AT);
  return id;
}

function optIn(db, household, user, suffix, values) {
  addPreference(db, household, user, values);
  addLink(db, household, user, suffix);
}

function runner(db, values = {}) {
  let sequence = 0;
  return () => runBillNotificationPlanner({
    d1: new LocalD1(db),
    now: values.now ?? AT,
    householdId: values.householdId,
    userId: values.userId,
    channel: values.channel,
    referenceDate: values.referenceDate,
    createId: () => `${values.prefix ?? "planner"}-${++sequence}`,
  });
}

function emptySummary() {
  return { recipientsEvaluated: 0, billsEvaluated: 0, eventsEligible: 0, inserted: 0, deduplicated: 0, skipped: 0 };
}

test("sem preferência e com opt-in desativado não planeja", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "a");
  addLink(db, a.household, a.user, "a");
  addBill(db, a.household, a.user, "today", "2026-09-20");
  assert.deepEqual(await runner(db)(), emptySummary());
  addPreference(db, a.household, a.user, { enabled: 0 });
  assert.deepEqual(await runner(db)(), emptySummary());
});

test("evento desativado é ignorado sem gerar outbox", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "a");
  optIn(db, a.household, a.user, "a", { today: 0 });
  addBill(db, a.household, a.user, "today", "2026-09-20");
  assert.deepEqual(await runner(db)(), { recipientsEvaluated: 1, billsEvaluated: 1, eventsEligible: 0, inserted: 0, deduplicated: 0, skipped: 1 });
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 0);
});

test("membership inativo e Telegram ausente não são elegíveis", async (t) => {
  const db = database(t);
  const inactive = seedHousehold(db, "inactive");
  optIn(db, inactive.household, inactive.user, "inactive", {});
  addBill(db, inactive.household, inactive.user, "inactive", "2026-09-20");
  db.prepare("UPDATE household_members SET status='inactive' WHERE household_id=? AND user_id=?").run(inactive.household, inactive.user);

  const noLink = seedHousehold(db, "no-link");
  addPreference(db, noLink.household, noLink.user);
  addBill(db, noLink.household, noLink.user, "no-link", "2026-09-20");
  assert.deepEqual(await runner(db)(), emptySummary());
});

test("vínculo Telegram de outro household não habilita o destinatário", async (t) => {
  const db = database(t);
  const sharedUser = "user-shared";
  const a = seedHousehold(db, "a", { user: sharedUser });
  const b = seedHousehold(db, "b", { user: sharedUser });
  addPreference(db, a.household, sharedUser);
  addLink(db, b.household, sharedUser, "only-b");
  addBill(db, a.household, sharedUser, "a", "2026-09-20");
  assert.deepEqual(await runner(db, { householdId: a.household })(), emptySummary());
});

test("amanhã, hoje e primeiro dia de atraso criam referências e dedupe corretas", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "a");
  optIn(db, a.household, a.user, "a", {});
  const overdue = addBill(db, a.household, a.user, "overdue", "2026-09-19");
  const today = addBill(db, a.household, a.user, "today", "2026-09-20");
  const tomorrow = addBill(db, a.household, a.user, "tomorrow", "2026-09-21");
  assert.deepEqual(await runner(db)(), { recipientsEvaluated: 1, billsEvaluated: 3, eventsEligible: 3, inserted: 3, deduplicated: 0, skipped: 0 });
  const rows = db.prepare("SELECT entity_id,event_type,reference_date,dedupe_key FROM notification_outbox ORDER BY event_type").all().map((row) => ({ ...row }));
  assert.deepEqual(rows.map(({ entity_id, event_type, reference_date }) => ({ entity_id, event_type, reference_date })), [
    { entity_id: today, event_type: "bill_due_today", reference_date: "2026-09-20" },
    { entity_id: tomorrow, event_type: "bill_due_tomorrow", reference_date: "2026-09-20" },
    { entity_id: overdue, event_type: "bill_overdue", reference_date: "2026-09-20" },
  ]);
  for (const row of rows) assert.equal(row.dedupe_key, buildNotificationDedupeKey({ householdId: a.household, recipientUserId: a.user, channel: "telegram", entityType: "bill", entityId: row.entity_id, eventType: row.event_type, referenceDate: row.reference_date }));
});

test("atraso antigo, conta paga e conta cancelada não geram evento", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "a");
  optIn(db, a.household, a.user, "a", {});
  addBill(db, a.household, a.user, "old", "2026-09-18");
  addBill(db, a.household, a.user, "paid", "2026-09-20", "paid");
  addBill(db, a.household, a.user, "cancelled", "2026-09-20", "cancelled");
  assert.deepEqual(await runner(db)(), { recipientsEvaluated: 1, billsEvaluated: 0, eventsEligible: 0, inserted: 0, deduplicated: 0, skipped: 0 });
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 0);
});

test("execução repetida e concorrente converge pela UNIQUE da outbox", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "a");
  optIn(db, a.household, a.user, "a", {});
  addBill(db, a.household, a.user, "today", "2026-09-20");
  const repeat = runner(db, { prefix: "repeat" });
  assert.equal((await repeat()).inserted, 1);
  assert.equal((await repeat()).deduplicated, 1);
  db.prepare("DELETE FROM notification_outbox").run();
  let sequence = 0;
  const execute = () => runBillNotificationPlanner({ d1: new LocalD1(db), now: AT, createId: () => `concurrent-${++sequence}` });
  const results = await Promise.all([execute(), execute()]);
  assert.equal(results.reduce((total, item) => total + item.inserted, 0), 1);
  assert.equal(results.reduce((total, item) => total + item.deduplicated, 0), 1);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox").get().total, 1);
});

test("amanhã e hoje são identidades diferentes para a mesma conta", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "a");
  optIn(db, a.household, a.user, "a", {});
  addBill(db, a.household, a.user, "due", "2026-09-20");
  assert.equal((await runner(db, { now: "2026-09-19T12:00:00.000Z", prefix: "tomorrow" })()).inserted, 1);
  assert.equal((await runner(db, { now: AT, prefix: "today" })()).inserted, 1);
  assert.deepEqual(db.prepare("SELECT event_type,reference_date FROM notification_outbox ORDER BY event_type").all().map((row) => ({ ...row })), [
    { event_type: "bill_due_today", reference_date: "2026-09-20" },
    { event_type: "bill_due_tomorrow", reference_date: "2026-09-19" },
  ]);
});

test("dois usuários da mesma família recebem eventos independentes", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "a");
  const other = addMember(db, a.household, "a-2");
  optIn(db, a.household, a.user, "a-1", {});
  optIn(db, a.household, other, "a-2", {});
  addBill(db, a.household, a.user, "today", "2026-09-20");
  const summary = await runner(db)();
  assert.deepEqual(summary, { recipientsEvaluated: 2, billsEvaluated: 2, eventsEligible: 2, inserted: 2, deduplicated: 0, skipped: 0 });
  assert.deepEqual(db.prepare("SELECT recipient_user_id FROM notification_outbox ORDER BY recipient_user_id").all().map((row) => row.recipient_user_id), [a.user, other].sort());
});

test("dois households permanecem isolados e podem ser executados com escopo", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "a");
  const b = seedHousehold(db, "b");
  optIn(db, a.household, a.user, "a", {});
  optIn(db, b.household, b.user, "b", {});
  addBill(db, a.household, a.user, "a", "2026-09-20");
  addBill(db, b.household, b.user, "b", "2026-09-20");
  assert.equal((await runner(db, { householdId: a.household, prefix: "a" })()).inserted, 1);
  assert.deepEqual(db.prepare("SELECT household_id FROM notification_outbox").all().map((row) => row.household_id), [a.household]);
  assert.equal((await runner(db, { householdId: b.household, prefix: "b" })()).inserted, 1);
  assert.deepEqual(db.prepare("SELECT household_id,count(*) total FROM notification_outbox GROUP BY household_id ORDER BY household_id").all().map((row) => ({ ...row })), [
    { household_id: a.household, total: 1 },
    { household_id: b.household, total: 1 },
  ]);
});

test("escopo exato restringe household, usuário, canal e usa referenceDate civil explícita", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "exact-a");
  const otherUser = addMember(db, a.household, "exact-a-2");
  const b = seedHousehold(db, "exact-b");
  optIn(db, a.household, a.user, "exact-a", {});
  optIn(db, a.household, otherUser, "exact-a-2", {});
  optIn(db, b.household, b.user, "exact-b", {});
  addBill(db, a.household, a.user, "exact-a", "2026-09-21");
  addBill(db, b.household, b.user, "exact-b", "2026-09-21");
  db.prepare(`INSERT INTO user_notification_preferences(
    household_id,user_id,channel,enabled,preferred_local_time,timezone,created_at,updated_at
  ) VALUES(?,?,'push',1,'09:00','America/Sao_Paulo',?,?)`).run(a.household, a.user, AT, AT);

  const summary = await runner(db, {
    householdId: a.household,
    userId: a.user,
    channel: "telegram",
    referenceDate: "2026-09-21",
    now: "2026-09-20T12:00:00.000Z",
    prefix: "exact",
  })();

  assert.deepEqual(summary, { recipientsEvaluated: 1, billsEvaluated: 1, eventsEligible: 1, inserted: 1, deduplicated: 0, skipped: 0 });
  assert.deepEqual({ ...db.prepare(`SELECT household_id,recipient_user_id,channel,event_type,reference_date
    FROM notification_outbox`).get() }, {
    household_id: a.household,
    recipient_user_id: a.user,
    channel: "telegram",
    event_type: "bill_due_today",
    reference_date: "2026-09-21",
  });
});

test("userId sem householdId falha fechado em vez de fazer scan global", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "incomplete");
  optIn(db, a.household, a.user, "incomplete", {});
  await assert.rejects(
    runner(db, { userId: a.user })(),
    (error) => error?.code === "NOTIFICATION_PLANNER_INCOMPLETE_SCOPE",
  );
});

test("timezone de São Paulo governa a virada UTC", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "a");
  optIn(db, a.household, a.user, "a", { timezone: "America/Sao_Paulo" });
  addBill(db, a.household, a.user, "utc", "2026-09-21");
  const summary = await runner(db, { now: "2026-09-21T01:30:00.000Z" })();
  assert.equal(summary.inserted, 1);
  assert.deepEqual({ ...db.prepare("SELECT event_type,reference_date FROM notification_outbox").get() }, { event_type: "bill_due_tomorrow", reference_date: "2026-09-20" });
});

test("não gera digest ou fatura e retorna somente contadores técnicos", async (t) => {
  const db = database(t);
  const a = seedHousehold(db, "a");
  optIn(db, a.household, a.user, "a", {});
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("card-a", a.household, "Card", "Bank", "Holder", 100000, 10, 20, AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)")
    .run("invoice-a", a.household, "card-a", "2026-09", "2026-09-20", AT, AT);
  const summary = await runner(db)();
  assert.deepEqual(summary, { recipientsEvaluated: 1, billsEvaluated: 0, eventsEligible: 0, inserted: 0, deduplicated: 0, skipped: 0 });
  assert.ok(Object.values(summary).every((value) => typeof value === "number"));
  assert.equal(db.prepare("SELECT count(*) total FROM notification_outbox WHERE event_type='upcoming_digest'").get().total, 0);
  const source = readFileSync(new URL("../lib/notification-planner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /sendTelegramMessage|chat_id|chatId|card_invoices|upcomingDigestEvent|scheduled\s*\(/u);
});

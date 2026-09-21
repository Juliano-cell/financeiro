import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const routeSource = readFileSync(new URL("../app/api/notifications/run/route.ts", import.meta.url), "utf8");

test("rota legada é uma resposta inerte sem dependências do motor antigo", () => {
  assert.match(routeSource, /LEGACY_NOTIFICATION_ENGINE_DISABLED/u);
  assert.match(routeSource, /status:\s*410/u);
  assert.doesNotMatch(routeSource, /cloudflare:workers|NOTIFICATION_CRON_SECRET|getDb|notificationPreferences|notificationLog|notification_outbox|bills|cardInvoices|sendTelegramMessage|runBillNotificationPlanner|runNotificationDispatcher/u);
});

test("tabelas legadas permanecem e opt-in legado não é migrado", (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    for (const sql of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8")
      .split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(sql);
  }
  t.after(() => db.close());
  const at = "2026-09-21T12:00:00.000Z";
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES('u','U','u@example.test',?,?)").run(at, at);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES('h','H','u',?,?)").run(at, at);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES('m','h','u','owner','active',?)").run(at);
  db.prepare("INSERT INTO notification_preferences(household_id,enabled,offsets_json,updated_at) VALUES('h',1,'[1,0,-1]',?)").run(at);
  db.prepare("INSERT INTO notification_log(id,household_id,entity_type,entity_id,event_key,channel,recipient_key,sent_at) VALUES('l','h','bill','b','e','telegram','r',?)").run(at);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_preferences").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_log").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM user_notification_preferences").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM notification_schedule_state").get().total, 0);
});

for (const configName of ["wrangler.production.jsonc", "wrangler.production.jsonc.example"]) {
  test(`${configName} declara crons vazios e flags desligadas`, () => {
    const config = JSON.parse(readFileSync(new URL(`../${configName}`, import.meta.url), "utf8"));
    assert.deepEqual(config.triggers, { crons: [] });
    assert.equal(config.vars.NOTIFICATION_PLANNER_ENABLED, "false");
    assert.equal(config.vars.NOTIFICATION_DISPATCHER_ENABLED, "false");
    assert.ok(config.d1_databases?.length);
    assert.ok(config.assets);
    assert.equal(config.observability.enabled, true);
  });
}

test("não existe migration 0010", () => {
  const names = readdirSync(new URL("../drizzle", import.meta.url));
  assert.equal(names.some((name) => name.startsWith("0010")), false);
});

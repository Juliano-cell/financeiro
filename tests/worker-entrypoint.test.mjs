import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NOTIFICATION_DISPATCHER_CRON,
  NOTIFICATION_PLANNER_CRON,
  createWorkerEntrypoint,
} from "../worker/create-worker.ts";

function executionContext() {
  return {
    props: {},
    waitUntil() {},
    passThroughOnException() {},
  };
}

test("entrypoint fonte conecta o handler oficial do Vinext ao Worker", () => {
  const source = readFileSync(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  const workerFactory = readFileSync(
    new URL("../worker/create-worker.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /from ["']vinext\/server\/fetch-handler["']/u);
  assert.match(source, /createWorkerEntrypoint<Cloudflare\.Env>\(vinextHandler\)/u);
  assert.match(workerFactory, /notification-scheduler/u);
  assert.match(workerFactory, /automatic-notification-dispatcher/u);
  assert.match(workerFactory, /telegram-notification-transport/u);
  assert.doesNotMatch(`${source}\n${workerFactory}`, /sendTelegramMessage/u);
});

test("fetch delega ao Vinext preservando argumentos e resposta", async () => {
  const request = new Request("https://example.test/configuracoes");
  const env = { marker: "local" };
  const ctx = executionContext();
  const response = new Response("vinext-response", { status: 207 });
  const calls = [];
  const worker = createWorkerEntrypoint({
    fetch(receivedRequest, receivedEnv, receivedCtx) {
      calls.push([receivedRequest, receivedEnv, receivedCtx]);
      return response;
    },
  });

  const result = await worker.fetch(request, env, ctx);

  assert.equal(result, response);
  assert.deepEqual(calls, [[request, env, ctx]]);
});

test("scheduled ignora cron desconhecido sem acessar D1, scheduler ou Telegram", async () => {
  let fetchCalls = 0;
  const forbiddenAccess = () => {
    assert.fail("scheduled tentou acessar uma dependência inativa");
  };
  const worker = createWorkerEntrypoint({
    fetch() {
      fetchCalls += 1;
      return new Response("ok");
    },
  }, { runScheduler: forbiddenAccess, runDispatcher: forbiddenAccess });
  const env = new Proxy(
    {},
    {
      get: forbiddenAccess,
      has: forbiddenAccess,
      ownKeys: forbiddenAccess,
    },
  );
  const controller = Object.freeze({
    scheduledTime: Date.now(),
    cron: "0 0 * * *",
    noRetry: forbiddenAccess,
  });
  const ctx = new Proxy({}, { get: forbiddenAccess });

  assert.equal(typeof worker.scheduled, "function");
  assert.equal(await worker.scheduled(controller, env, ctx), undefined);
  assert.equal(fetchCalls, 0);
});

test("scheduled reconhece o cron do planner e usa waitUntil", async () => {
  const calls = [];
  const pending = [];
  const summaries = [];
  const db = { marker: "d1-local" };
  const scheduledTime = Date.parse("2026-09-21T12:00:00.000Z");
  const worker = createWorkerEntrypoint({ fetch: () => new Response("ok") }, {
    async runScheduler(context) {
      calls.push(context);
      return { examined: 1, claimed: 1, planned: 1, missed: 0, skipped: 0, failed: 0, outboxCreated: 1 };
    },
    logSchedulerSummary(summary) { summaries.push(summary); },
  });
  const ctx = {
    props: {},
    waitUntil(promise) { pending.push(promise); },
    passThroughOnException() {},
  };

  assert.equal(await worker.scheduled(
    { scheduledTime, cron: NOTIFICATION_PLANNER_CRON, noRetry() {} },
    { DB: db, NOTIFICATION_PLANNER_ENABLED: "true" },
    ctx,
  ), undefined);
  assert.equal(pending.length, 1);
  await pending[0];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].d1, db);
  assert.equal(calls[0].now.toISOString(), "2026-09-21T12:00:00.000Z");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].cron, NOTIFICATION_PLANNER_CRON);
  assert.equal(summaries[0].outboxCreated, 1);
});

test("scheduled reconhece o cron do dispatcher e usa waitUntil sem transporte real", async () => {
  const calls = [];
  const pending = [];
  const summaries = [];
  const db = { marker: "d1-dispatcher-local" };
  const scheduledTime = Date.parse("2026-09-21T12:00:00.000Z");
  const worker = createWorkerEntrypoint({ fetch: () => new Response("ok") }, {
    async runDispatcher(context) {
      calls.push(context);
      return {
        claimed: 1, sent: 1, failed: 0, retried: 0, uncertain: 0,
        cancelled: 0, skipped: 0, rateLimited: 0, paused: 0,
      };
    },
    logDispatcherSummary(summary) { summaries.push(summary); },
  });
  const ctx = {
    props: {},
    waitUntil(promise) { pending.push(promise); },
    passThroughOnException() {},
  };

  assert.equal(await worker.scheduled(
    { scheduledTime, cron: NOTIFICATION_DISPATCHER_CRON, noRetry() {} },
    { DB: db, NOTIFICATION_DISPATCHER_ENABLED: "true" },
    ctx,
  ), undefined);
  assert.equal(pending.length, 1);
  await pending[0];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].d1, db);
  assert.equal(calls[0].now.toISOString(), "2026-09-21T12:00:00.000Z");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].cron, NOTIFICATION_DISPATCHER_CRON);
  assert.equal(summaries[0].sent, 1);
});

test("scheduled não interfere em chamadas fetch anteriores ou posteriores", async () => {
  const calls = [];
  const worker = createWorkerEntrypoint({
    fetch(request) {
      calls.push(request.url);
      return new Response(request.url);
    },
  });
  const ctx = executionContext();
  const first = new Request("https://example.test/antes");
  const second = new Request("https://example.test/depois");

  assert.equal(await (await worker.fetch(first, {}, ctx)).text(), first.url);
  await worker.scheduled(
    { scheduledTime: 0, cron: "", noRetry() {} },
    {},
    ctx,
  );
  assert.equal(await (await worker.fetch(second, {}, ctx)).text(), second.url);
  assert.deepEqual(calls, [first.url, second.url]);
});

for (const [label, cron, flag] of [
  ["planner", NOTIFICATION_PLANNER_CRON, "NOTIFICATION_PLANNER_ENABLED"],
  ["dispatcher", NOTIFICATION_DISPATCHER_CRON, "NOTIFICATION_DISPATCHER_ENABLED"],
]) {
  for (const value of [undefined, "false"]) {
    test(`scheduled ${label} faz NO-OP com flag ${value === undefined ? "ausente" : "false"}`, async () => {
      let executions = 0;
      let waitUntilCalls = 0;
      const worker = createWorkerEntrypoint({ fetch: () => new Response("ok") }, {
        async runScheduler() { executions += 1; throw new Error("não deveria executar"); },
        async runDispatcher() { executions += 1; throw new Error("não deveria executar"); },
      });
      const env = value === undefined ? {} : { [flag]: value };
      await worker.scheduled(
        { scheduledTime: Date.now(), cron, noRetry() {} },
        env,
        { ...executionContext(), waitUntil() { waitUntilCalls += 1; } },
      );
      assert.equal(executions, 0);
      assert.equal(waitUntilCalls, 0);
    });
  }
}

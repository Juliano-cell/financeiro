import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TELEGRAM_NOTIFICATION_MAX_RETRY_AFTER_SECONDS,
  TELEGRAM_NOTIFICATION_TIMEOUT_MS,
  TelegramNotificationTransport,
} from "../lib/telegram-notification-transport.ts";

const TOKEN = "123456789:test_token_value";
const CHAT_ID = "-100123456789";
const TEXT = "Aviso financeiro privado R$ 119,90";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transport(fetchImpl, options = {}) {
  return new TelegramNotificationTransport({
    token: TOKEN,
    fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

function send(instance) {
  return instance.send({ chatId: CHAT_ID, text: TEXT });
}

test("sucesso HTTP com ok=true retorna sent", async () => {
  const result = await send(transport(async () => jsonResponse({ ok: true, result: {} })));
  assert.deepEqual(result, { kind: "sent" });
});

test("sucesso captura somente provider_message_id", async () => {
  const result = await send(transport(async () => jsonResponse({
    ok: true,
    result: { message_id: 987, chat: { id: CHAT_ID }, text: TEXT },
  })));
  assert.deepEqual(result, { kind: "sent", providerMessageId: "987" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CHAT_ID, "u"));
  assert.doesNotMatch(JSON.stringify(result), /Aviso financeiro/u);
});

test("HTTP 429 é rate_limited", async () => {
  const result = await send(transport(async () => jsonResponse({ ok: false, error_code: 429 }, 429)));
  assert.deepEqual(result, { kind: "rate_limited", retryAfterSeconds: 0, errorCode: "telegram_rate_limited" });
});

test("Bot API 429 em HTTP 200 é rate_limited", async () => {
  const result = await send(transport(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 30 } })));
  assert.equal(result.kind, "rate_limited");
  assert.equal(result.retryAfterSeconds, 30);
});

test("retry_after válido é arredondado e limitado", async () => {
  const rounded = await send(transport(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 2.1 } }, 429)));
  const capped = await send(transport(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 999_999 } }, 429)));
  assert.equal(rounded.retryAfterSeconds, 3);
  assert.equal(capped.retryAfterSeconds, TELEGRAM_NOTIFICATION_MAX_RETRY_AFTER_SECONDS);
});

test("retry_after ausente ou inválido usa zero para backoff do dispatcher", async () => {
  for (const parameters of [undefined, {}, { retry_after: "60" }, { retry_after: -1 }]) {
    const result = await send(transport(async () => jsonResponse({ ok: false, error_code: 429, parameters }, 429)));
    assert.equal(result.retryAfterSeconds, 0);
  }
});

test("HTTP 400 é falha permanente", async () => {
  assert.deepEqual(
    await send(transport(async () => jsonResponse({ ok: false, description: TEXT }, 400))),
    { kind: "permanent_failure", errorCode: "telegram_http_400" },
  );
});

test("HTTP 403 bot bloqueado é falha permanente", async () => {
  assert.deepEqual(
    await send(transport(async () => jsonResponse({ ok: false, description: "bot was blocked" }, 403))),
    { kind: "permanent_failure", errorCode: "telegram_http_403" },
  );
});

test("HTTP 404 é falha permanente", async () => {
  assert.deepEqual(
    await send(transport(async () => jsonResponse({ ok: false }, 404))),
    { kind: "permanent_failure", errorCode: "telegram_http_404" },
  );
});

test("HTTP 500 é transitório", async () => {
  assert.deepEqual(
    await send(transport(async () => jsonResponse({ ok: false }, 500))),
    { kind: "transient_failure", errorCode: "telegram_http_500" },
  );
});

test("HTTP 502 e 503 são transitórios", async () => {
  for (const status of [502, 503]) {
    assert.deepEqual(
      await send(transport(async () => jsonResponse({ ok: false }, status))),
      { kind: "transient_failure", errorCode: `telegram_http_${status}` },
    );
  }
});

test("timeout explícito é resultado uncertain", async () => {
  const instance = transport((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }), { timeoutMs: 5 });
  assert.deepEqual(await send(instance), { kind: "uncertain", errorCode: "telegram_timeout" });
});

test("timeout também cobre leitura pendente do payload", async () => {
  const instance = transport(async (_url, init) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  }), { timeoutMs: 5 });
  assert.deepEqual(await send(instance), { kind: "uncertain", errorCode: "telegram_timeout" });
});

test("falha de rede sem confirmação é ambiguous/uncertain", async () => {
  const result = await send(transport(async () => { throw new TypeError("network details must not escape"); }));
  assert.deepEqual(result, { kind: "uncertain", errorCode: "telegram_network_ambiguous" });
});

test("JSON inválido após HTTP 200 é uncertain", async () => {
  const result = await send(transport(async () => new Response("not-json", { status: 200 })));
  assert.deepEqual(result, { kind: "uncertain", errorCode: "telegram_response_invalid" });
});

test("ok=false é classificado também quando HTTP foi aceito", async () => {
  assert.deepEqual(
    await send(transport(async () => jsonResponse({ ok: false, description: "rejected" }))),
    { kind: "permanent_failure", errorCode: "telegram_api_rejected" },
  );
  assert.deepEqual(
    await send(transport(async () => jsonResponse({ ok: false, error_code: 503 }))),
    { kind: "transient_failure", errorCode: "telegram_api_503" },
  );
});

test("resposta inesperada não é assumida como sucesso", async () => {
  const missingOk = await send(transport(async () => jsonResponse({ result: { message_id: 1 } })));
  const arrayPayload = await send(transport(async () => jsonResponse([])));
  assert.deepEqual(missingOk, { kind: "uncertain", errorCode: "telegram_response_unexpected" });
  assert.deepEqual(arrayPayload, { kind: "uncertain", errorCode: "telegram_response_invalid" });
});

test("descrição externa e erro de rede não aparecem no resultado", async () => {
  const description = `${TOKEN} ${CHAT_ID} ${TEXT}`;
  const rejected = await send(transport(async () => jsonResponse({ ok: false, error_code: 400, description }, 400)));
  const network = await send(transport(async () => { throw new Error(description); }));
  for (const result of [rejected, network]) {
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(TOKEN, "u"));
    assert.doesNotMatch(serialized, new RegExp(CHAT_ID, "u"));
    assert.doesNotMatch(serialized, /Aviso financeiro|119,90/u);
  }
});

test("token nunca aparece em resultados ou erro de configuração", async () => {
  const result = await send(transport(async () => jsonResponse({ ok: false, description: TOKEN }, 403)));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN, "u"));
  assert.throws(
    () => new TelegramNotificationTransport({ token: `invalid/${TOKEN}`, fetchImpl: async () => jsonResponse({ ok: true }) }),
    (error) => error instanceof Error && !error.message.includes(TOKEN),
  );
});

test("chat_id não aparece em resultado permanente", async () => {
  const result = await transport(async () => assert.fail("fetch não deveria ser chamado"))
    .send({ chatId: "", text: TEXT });
  assert.deepEqual(result, { kind: "permanent_failure", errorCode: "telegram_destination_invalid" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CHAT_ID, "u"));
});

test("texto integral não aparece em erro ou resumo", async () => {
  const result = await transport(async () => { throw new Error(TEXT); }).send({ chatId: CHAT_ID, text: TEXT });
  assert.doesNotMatch(JSON.stringify(result), /Aviso financeiro|119,90/u);
});

test("requisição contém somente sendMessage, chat e texto limitado", async () => {
  let request;
  const longText = "x".repeat(5_000);
  const result = await transport(async (url, init) => {
    request = { url, init };
    return jsonResponse({ ok: true, result: { message_id: 5 } });
  }).send({ chatId: CHAT_ID, text: longText });
  assert.equal(result.kind, "sent");
  assert.match(request.url, /^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/u);
  const body = JSON.parse(request.init.body);
  assert.deepEqual(Object.keys(body).sort(), ["chat_id", "text"]);
  assert.equal(body.chat_id, CHAT_ID);
  assert.equal(body.text.length, 4_096);
});

test("testes exigem fetch injetado e bloqueiam fallback externo", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("chamada externa não mockada");
  t.after(() => { globalThis.fetch = original; });
  let injectedCalls = 0;
  const result = await send(transport(async () => {
    injectedCalls += 1;
    return jsonResponse({ ok: true });
  }));
  assert.equal(result.kind, "sent");
  assert.equal(injectedCalls, 1);
});

test("factory de runtime permanece inativa e sem rota ou agendamento", () => {
  const source = readFileSync(new URL("../lib/telegram-notification-runtime.ts", import.meta.url), "utf8");
  assert.match(source, /env\.TELEGRAM_BOT_TOKEN/u);
  assert.match(source, /createTelegramNotificationDispatcherContext/u);
  assert.doesNotMatch(source, /runNotificationDispatcher\s*\(|scheduled\s*\(|app\/api|console\.|TELEGRAM_BOT_TOKEN[^\n]*log/u);
});

test("timeout padrão é explícito e limitado", () => {
  assert.equal(TELEGRAM_NOTIFICATION_TIMEOUT_MS, 10_000);
  assert.throws(() => new TelegramNotificationTransport({ token: TOKEN, fetchImpl: async () => jsonResponse({ ok: true }), timeoutMs: 60_001 }), /Timeout/u);
});

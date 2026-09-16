import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { hasTelegramDeliveryFailure } from "../lib/telegram-delivery.mjs";
import { classifyTelegramUpdate } from "../lib/telegram-update.mjs";
import { buildInstallmentPlan } from "../lib/finance-rules.mjs";
import { CURRENT_ACCOUNT_BALANCES_SQL, FINANCIAL_EVENTS_CTE } from "../lib/finance-analytics.mjs";

const handlerTestEnv = globalThis.__telegramHandlerTestEnv ?? {};
globalThis.__telegramHandlerTestEnv = handlerTestEnv;
const loaderSource = `
  import { existsSync, statSync } from "node:fs";
  import { dirname, extname, resolve as resolvePath } from "node:path";
  import { fileURLToPath, pathToFileURL } from "node:url";
  const root = ${JSON.stringify(process.cwd())};
  function resolveFile(path) {
    const candidates = extname(path) ? [path] : [path, path + ".ts", path + ".mjs", path + ".tsx", resolvePath(path, "index.ts")];
    return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  }
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: "data:text/javascript,export const env=globalThis.__telegramHandlerTestEnv" };
    }
    if (specifier.startsWith("@/")) {
      const path = resolveFile(resolvePath(root, specifier.slice(2)));
      if (!path) throw new Error("Módulo de teste não encontrado: " + specifier);
      return { shortCircuit: true, url: pathToFileURL(path).href };
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:") && !extname(specifier)) {
      const path = resolveFile(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier));
      if (path) return { shortCircuit: true, url: pathToFileURL(path).href };
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);
const { handleTelegramUpdate } = await import("../lib/telegram-handler.ts?telegram-integration");
const { FinanceValidationError } = await import("../lib/finance-service.ts");

class LocalStatement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new LocalStatement(this.db, this.sql, bindings);
  }

  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.bindings) ?? null;
    return column && row ? row[column] : row;
  }

  async all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } };
  }

  async raw() {
    const statement = this.db.prepare(this.sql);
    const columns = statement.columns().map((column) => column.name);
    return statement.all(...this.bindings).map((row) => columns.map((column) => row[column]));
  }

  runSync() {
    const result = this.db.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: result.changes } };
  }

  async run() {
    return this.runSync();
  }
}

class LocalD1 {
  constructor(db) {
    this.db = db;
    this.financialBatchBarrier = null;
  }

  prepare(sql) {
    return new LocalStatement(this.db, sql);
  }

  async batch(statements) {
    if (this.financialBatchBarrier && statements.some((statement) => statement.bindings.some((value) => String(value).startsWith("financial:")))) {
      await this.financialBatchBarrier.wait();
    }
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

function requestBarrier(expected) {
  let arrivals = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return {
    async wait() {
      arrivals += 1;
      if (arrivals === expected) release();
      await ready;
    },
  };
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

function seed(db) {
  const at = "2026-09-11T12:00:00.000Z";
  for (const suffix of ["a", "b"]) {
    db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `User ${suffix}`, `${suffix}@example.com`, at, at);
    db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `House ${suffix}`, `u${suffix}`, at, at);
    db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,joined_at,created_at) VALUES(?,?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", at, at);
    db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`a${suffix}`, `h${suffix}`, `Account ${suffix}`, "bank", at, at);
  }
  return at;
}

function seedTelegramContext(db) {
  const at = seed(db);
  db.prepare("UPDATE accounts SET name='Nubank' WHERE id='aa'").run();
  db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("category-market", "ha", "Mercado", "expense", at, at);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("card-nubank", "ha", "Nubank", "Nubank", "User a", 100_000, 5, 12, at, at);
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("link-handler", "ha", "ua", "42", "42", at, at);
  handlerTestEnv.DB = new LocalD1(db);
  return at;
}

function messageUpdate(updateId, text, telegramId = 42) {
  return { update_id: updateId, message: { text, chat: { id: telegramId, type: "private" }, from: { id: telegramId } } };
}

function callbackUpdate(updateId, data, telegramId = 42) {
  return { update_id: updateId, callback_query: { id: `callback-${updateId}`, data, from: { id: telegramId }, message: { chat: { id: telegramId, type: "private" } } } };
}

function storedFinancialState(db, telegramId = 42) {
  const row = db.prepare("SELECT payload_json FROM telegram_conversation_states WHERE telegram_user_id=? AND household_id='ha'").get(String(telegramId));
  return row ? JSON.parse(row.payload_json) : null;
}

async function beginFinancialConversation(db, updateId, text = "Gastei 85 no mercado no pix", telegramId = 42) {
  const response = await handleTelegramUpdate(messageUpdate(updateId, text, telegramId));
  const state = storedFinancialState(db, telegramId);
  assert.ok(state?.sessionId);
  assert.equal(state.phase, "confirming");
  return { response, state };
}

function callbackByText(response, text) {
  const button = response.buttons?.flat().find((item) => item.text.includes(text));
  assert.ok(button, `Botão ${text} não encontrado.`);
  return button.callback_data;
}

function addCard(db, id = "card-second", householdId = "ha", name = "Segundo") {
  const at = "2026-09-11T12:00:00.000Z";
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, householdId, name, name, "Test holder", 100_000, 5, 12, at, at);
}

function addCardSubcategory(db) {
  const at = "2026-09-11T12:00:00.000Z";
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("subcategory-fair", "ha", "category-market", "Feira", at, at);
}

function assertNoCardCreation(db) {
  for (const table of ["card_purchases", "card_installments", "transactions", "bills"]) {
    assert.equal(db.prepare(`SELECT count(*) total FROM ${table}`).get().total, 0, table);
  }
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_type='card_purchase'").get().total, 0);
}

async function completeCardClassification(db, response, updateId) {
  if (storedFinancialState(db).phase === "selecting_category") response = await handleTelegramUpdate(callbackUpdate(updateId++, callbackByText(response, "Mercado")));
  if (storedFinancialState(db).phase === "selecting_subcategory") response = await handleTelegramUpdate(callbackUpdate(updateId++, callbackByText(response, "Feira")));
  const state = storedFinancialState(db);
  assert.equal(state.phase, "confirming");
  assert.deepEqual(state.financialIntent.missing, []);
  assert.equal(state.financialIntent.accountId, null);
  assert.equal(state.financialIntent.dueDate, null);
  return { response, state, nextUpdateId: updateId };
}

function atomic(db, operation) {
  db.exec("BEGIN");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

test("vínculo Telegram não aceita usuário de outro household", () => {
  const db = database(); const at = seed(db);
  assert.throws(() => db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("link", "ha", "ub", "42", "42", at, at), /FOREIGN KEY/);
});

test("usuário Telegram não vinculado não resolve família nem conta", () => {
  const db = database(); seed(db);
  const link = db.prepare("SELECT household_id,user_id FROM telegram_links WHERE telegram_user_id=? AND chat_id=? AND is_active=1").get("999", "999");
  assert.equal(link, undefined);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE origin='telegram'").get().total, 0);
});

test("código expirado ou consumido não satisfaz o consumo condicional", () => {
  const db = database(); const at = seed(db);
  db.prepare("INSERT INTO telegram_link_codes(id,household_id,user_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)").run("expired", "ha", "ua", "hash-1", "2026-09-11T11:00:00.000Z", at);
  db.prepare("INSERT INTO telegram_link_codes(id,household_id,user_id,code_hash,expires_at,used_at,created_at) VALUES(?,?,?,?,?,?,?)").run("used", "ha", "ua", "hash-2", "2026-09-11T13:00:00.000Z", at, at);
  const consume = db.prepare("UPDATE telegram_link_codes SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?");
  assert.equal(consume.run(at, "expired", at).changes, 0);
  assert.equal(consume.run(at, "used", at).changes, 0);
});

test("handler impede duas confirmações da mesma sessão com update_id diferentes", async () => {
  const db = database(); seedTelegramContext(db);
  const { response, state } = await beginFinancialConversation(db, 1001);
  const confirm = callbackByText(response, "Confirmar");
  handlerTestEnv.DB.financialBatchBarrier = requestBarrier(2);

  const attempts = await Promise.allSettled([
    handleTelegramUpdate(callbackUpdate(1002, confirm)),
    handleTelegramUpdate(callbackUpdate(1003, confirm)),
  ]);

  assert.deepEqual(attempts.map((result) => result.status), ["fulfilled", "fulfilled"]);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE origin='telegram'").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id=?").get(`financial:${state.sessionId}`).total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_type='transaction'").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states").get().total, 0);
});

test("handler responde de forma amigável à confirmação depois do consumo da sessão", async () => {
  const db = database(); seedTelegramContext(db);
  const { response } = await beginFinancialConversation(db, 1101);
  const confirm = callbackByText(response, "Confirmar");
  await handleTelegramUpdate(callbackUpdate(1102, confirm));
  const repeated = await handleTelegramUpdate(callbackUpdate(1103, confirm));

  assert.match(repeated.text ?? "", /outra operação|expirou|finalizada/iu);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE origin='telegram'").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states").get().total, 0);
});

test("cancelamento real consome a sessão atomicamente e impede confirmação posterior", async () => {
  const db = database(); seedTelegramContext(db);
  const { response, state } = await beginFinancialConversation(db, 1201);
  const cancel = callbackByText(response, "Cancelar");
  const confirm = callbackByText(response, "Confirmar");
  const cancelled = await handleTelegramUpdate(callbackUpdate(1202, cancel));

  assert.match(cancelled.text ?? "", /cancelada/iu);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id=?").get(`financial:${state.sessionId}`).total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM bills").get().total, 0);

  await handleTelegramUpdate(callbackUpdate(1203, confirm));
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM bills").get().total, 0);
});

test("cancelamento antigo depois da confirmação não desfaz movimentação nem altera nova sessão", async () => {
  const db = database(); seedTelegramContext(db);
  const first = await beginFinancialConversation(db, 1301);
  const oldConfirm = callbackByText(first.response, "Confirmar");
  const oldCancel = callbackByText(first.response, "Cancelar");
  await handleTelegramUpdate(callbackUpdate(1302, oldConfirm));
  const second = await beginFinancialConversation(db, 1303, "Gastei 40 no mercado no pix");
  const stateBefore = db.prepare("SELECT payload_json, updated_at FROM telegram_conversation_states WHERE telegram_user_id='42'").get();

  const rejected = await handleTelegramUpdate(callbackUpdate(1304, oldCancel));
  const stateAfter = db.prepare("SELECT payload_json, updated_at FROM telegram_conversation_states WHERE telegram_user_id='42'").get();

  assert.match(rejected.text ?? "", /outra operação|expirou/iu);
  assert.notEqual(first.state.sessionId, second.state.sessionId);
  assert.deepEqual(stateAfter, stateBefore);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE origin='telegram'").get().total, 1);
});

test("callback de sessão anterior não altera o state da conversa nova", async () => {
  const db = database(); seedTelegramContext(db);
  const first = await beginFinancialConversation(db, 1401);
  const oldAlter = callbackByText(first.response, "Alterar");
  await handleTelegramUpdate(callbackUpdate(1402, callbackByText(first.response, "Cancelar")));
  const second = await beginFinancialConversation(db, 1403, "Gastei 25 no mercado no pix");
  const stateBefore = db.prepare("SELECT payload_json, updated_at FROM telegram_conversation_states WHERE telegram_user_id='42'").get();

  await handleTelegramUpdate(callbackUpdate(1404, oldAlter));

  const stateAfter = db.prepare("SELECT payload_json, updated_at FROM telegram_conversation_states WHERE telegram_user_id='42'").get();
  assert.notEqual(first.state.sessionId, second.state.sessionId);
  assert.deepEqual(stateAfter, stateBefore);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
});

test("callback com sessionId adulterado passa pelo handler sem alterar state ou finanças", async () => {
  const db = database(); seedTelegramContext(db);
  const current = await beginFinancialConversation(db, 1501);
  const confirm = callbackByText(current.response, "Confirmar");
  const replacement = confirm[0] === "A" ? "B" : "A";
  const adulterated = `${replacement}${confirm.slice(1)}`;
  const stateBefore = db.prepare("SELECT payload_json, updated_at FROM telegram_conversation_states WHERE telegram_user_id='42'").get();

  await handleTelegramUpdate(callbackUpdate(1502, adulterated));

  const stateAfter = db.prepare("SELECT payload_json, updated_at FROM telegram_conversation_states WHERE telegram_user_id='42'").get();
  assert.deepEqual(stateAfter, stateBefore);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 0);
});

test("cartão legado homônimo persiste pelo handler uma única compra parcelada", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 1601, "Comprei 50 no Nubank em 2x no mercado");
  assert.equal(started.state.financialIntent.paymentFlow, "credit_card");
  assert.equal(started.state.financialIntent.cardId, "card-nubank");
  assert.equal(started.state.financialIntent.installmentCount, 2);
  assert.equal(started.state.financialIntent.legacyCardCompatible, true);
  const confirm = callbackByText(started.response, "Confirmar");

  await handleTelegramUpdate(callbackUpdate(1602, confirm));
  await handleTelegramUpdate(callbackUpdate(1603, confirm));

  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases WHERE origin='telegram'").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM card_installments").get().total, 2);
  assert.equal(db.prepare("SELECT sum(amount_cents) total FROM card_installments").get().total, 5_000);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id=?").get(`financial:${started.state.sessionId}`).total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states").get().total, 0);
});

test("cartão legado persiste subcategoria canônica e autoria Telegram", async () => {
  const db = database(); const at = seedTelegramContext(db);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("subcategory-fair", "ha", "category-market", "Feira", at, at);
  const started = await beginFinancialConversation(db, 1651, "Comprei tênis 50 na feira no Nubank em 2x");
  assert.equal(started.state.financialIntent.subcategoryId, "subcategory-fair");
  await handleTelegramUpdate(callbackUpdate(1652, callbackByText(started.response, "Confirmar")));
  const purchase = db.prepare("SELECT subcategory_id,origin,created_by_user_id FROM card_purchases").get();
  assert.deepEqual({ ...purchase }, { subcategory_id: "subcategory-fair", origin: "telegram", created_by_user_id: "ua" });
  assert.equal(db.prepare("SELECT count(*) total FROM card_installments").get().total, 2);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM bills").get().total, 0);
});

test("future_bill confirmado cria um único vencimento pending sem transaction", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 1701, "Comprei uma camiseta de 50 no mercado e pago em 20/10/2026");
  assert.equal(started.state.financialIntent.paymentFlow, "future_bill");
  assert.equal(started.state.financialIntent.dueDate, "2026-10-20");
  assert.equal(started.state.financialIntent.accountId, null);
  assert.match(started.response.text ?? "", /Pagamento: Pendente/);
  assert.match(started.response.text ?? "", /Compra:/);
  assert.match(started.response.text ?? "", /Vencimento: 2026-10-20/);
  const confirm = callbackByText(started.response, "Confirmar");

  const result = await handleTelegramUpdate(callbackUpdate(1702, confirm));
  await handleTelegramUpdate(callbackUpdate(1703, confirm));

  assert.match(result.text ?? "", /Vencimento.*criado/iu);
  const bill = db.prepare("SELECT status,amount_cents,due_date,account_id,recurrence,created_by_user_id,origin FROM bills WHERE household_id='ha'").get();
  assert.deepEqual({ ...bill }, { status: "pending", amount_cents: 5000, due_date: "2026-10-20", account_id: null, recurrence: "none", created_by_user_id: "ua", origin: "telegram" });
  assert.equal(db.prepare("SELECT count(*) total FROM bills WHERE household_id='ha'").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE household_id='ha'").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_type='bill'").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id=?").get(`financial:${started.state.sessionId}`).total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states WHERE telegram_user_id='42'").get().total, 0);
});

test("future_bill deriva created_by de cada vínculo ativo no mesmo household", async () => {
  const db = database(); const at = seedTelegramContext(db);
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("ua2", "User a2", "a2@example.com", at, at);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,joined_at,created_at) VALUES(?,?,?,?,?,?,?)").run("ma2", "ha", "ua2", "member", "active", at, at);
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("link-handler-2", "ha", "ua2", "43", "43", at, at);

  const first = await beginFinancialConversation(db, 1801, "Comprei uma camiseta de 10 no mercado e pago dia 20");
  await handleTelegramUpdate(callbackUpdate(1802, callbackByText(first.response, "Confirmar")));
  const second = await beginFinancialConversation(db, 1803, "Comprei um tênis de 20 no mercado e pago dia 21", 43);
  await handleTelegramUpdate(callbackUpdate(1804, callbackByText(second.response, "Confirmar"), 43));

  assert.deepEqual(db.prepare("SELECT created_by_user_id FROM bills WHERE household_id='ha' ORDER BY amount_cents").all().map((row) => row.created_by_user_id), ["ua", "ua2"]);
});

test("mês-alvo incompleto é preservado até o usuário informar o dia", async () => {
  const db = database(); seedTelegramContext(db);
  const initial = await handleTelegramUpdate(messageUpdate(1901, "Comprei uma camiseta de 30 no mercado e pago mês que vem"));
  let state = storedFinancialState(db);
  assert.equal(state.phase, "collecting");
  assert.equal(state.field, "vencimento");
  assert.equal(state.financialIntent.dueMonth, "2026-10");
  assert.match(initial.text ?? "", /vencimento/iu);

  const completed = await handleTelegramUpdate(messageUpdate(1902, "dia 10"));
  state = storedFinancialState(db);
  assert.equal(state.phase, "confirming");
  assert.equal(state.financialIntent.dueDate, "2026-10-10");
  assert.equal(state.financialIntent.dueMonth, null);
  assert.match(completed.text ?? "", /Vencimento: 2026-10-10/);
});

test("direct_installments continua sem persistência", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 2001, "Comprei uma bicicleta de 300 no mercado em 3 parcelas direto na loja, primeiro vencimento dia 20");
  assert.equal(started.state.financialIntent.paymentFlow, "direct_installments");
  const response = await handleTelegramUpdate(callbackUpdate(2002, callbackByText(started.response, "Confirmar")));
  assert.match(response.text ?? "", /ainda não está disponível/iu);
  assert.equal(db.prepare("SELECT count(*) total FROM bills").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
});

test("falha na auditoria reverte update e transação", () => {
  const db = database(); const at = seed(db);
  const broken = () => atomic(db, () => {
    db.prepare("INSERT INTO telegram_processed_updates(update_id,received_at) VALUES(?,?)").run("200", at);
    db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,transaction_date,responsible_user_id,account_id,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("t-broken", "ha", "expense", 100, "Teste", "2026-09-11", "ua", "aa", "confirmed", "telegram", at, at);
    db.prepare("INSERT INTO audit_logs(id,household_id,user_id,action,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?)").run("audit-broken", "missing-household", "ua", "create", "transaction", "t-broken", at);
  });
  assert.throws(() => broken(), /FOREIGN KEY/);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id='200'").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions WHERE id='t-broken'").get().total, 0);
});

test("cancelamento remove estado sem criar movimentação", () => {
  const db = database(); const at = seed(db);
  db.prepare("INSERT INTO telegram_conversation_states(telegram_user_id,household_id,payload_json,expires_at,updated_at) VALUES(?,?,?,?,?)").run("42", "ha", "{}", "2026-09-11T13:00:00.000Z", at);
  atomic(db, () => {
    db.prepare("INSERT INTO telegram_processed_updates(update_id,received_at) VALUES(?,?)").run("cancel-1", at);
    db.prepare("DELETE FROM telegram_conversation_states WHERE telegram_user_id=? AND household_id=?").run("42", "ha");
  });
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_conversation_states").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
});

test("handler exige confirmação, auditoria, household e payload limitado", () => {
  const handler = readFileSync(new URL("../lib/telegram-handler.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../lib/finance-service.ts", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
  assert.match(handler, /phase: "confirming"/); assert.match(handler, /clearTelegramStateFor/); assert.match(handler, /eq\(householdMembers\.status, "active"\)/);
  assert.match(service, /INSERT INTO audit_logs/); assert.match(service, /INSERT INTO telegram_processed_updates/); assert.match(service, /env\.DB\.batch|d1\.batch/);
  assert.match(webhook, /16_384/); assert.match(webhook, /safeSecretEqual/); assert.doesNotMatch(webhook, /TELEGRAM_BOT_TOKEN/);
});

test("mensagens e callbacks suportados continuam processáveis", () => {
  const message = (updateId, text) => ({
    update_id: updateId,
    message: {
      text,
      chat: { id: 42, type: "private" },
      from: { id: 42 },
    },
  });

  for (const update of [message(301, "/start"), message(302, "/conectar 123456"), message(303, "Gastei 85 no mercado")]) {
    assert.equal(classifyTelegramUpdate(update).kind, "processable");
  }

  assert.equal(classifyTelegramUpdate({
    update_id: 304,
    callback_query: {
      id: "callback-304",
      data: "ok",
      from: { id: 42 },
      message: { chat: { id: 42, type: "private" } },
    },
  }).kind, "processable");
});

test("updates Telegram legítimos mas não suportados são ignorados", () => {
  const chat = { id: 42, type: "private" };
  const from = { id: 42 };
  const unsupported = [
    { update_id: 401, my_chat_member: { chat, from, new_chat_member: {} } },
    { update_id: 402, chat_member: { chat, from, new_chat_member: {} } },
    { update_id: 403, edited_message: { text: "/start", chat, from } },
    { update_id: 404, channel_post: { text: "publicação", chat: { id: -10042, type: "channel" } } },
    { update_id: 405, message: { photo: [{ file_id: "photo" }], chat, from } },
    { update_id: 406, message: { sticker: { file_id: "sticker" }, chat, from } },
    { update_id: 407, message: { new_chat_members: [from], chat, from } },
    { update_id: 408, callback_query: { id: "callback-408", data: "ok", from, inline_message_id: "inline" } },
  ];

  for (const update of unsupported) assert.equal(classifyTelegramUpdate(update).kind, "unsupported");
});

test("somente envelopes realmente inválidos são classificados como inválidos", () => {
  for (const update of [null, [], {}, { update_id: -1 }, { update_id: "409" }, { update_id: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(classifyTelegramUpdate(update).kind, "invalid");
  }
});

test("webhook encerra update não suportado antes de handler, banco ou entrega", () => {
  const webhook = readFileSync(new URL("../app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
  const classifier = readFileSync(new URL("../lib/telegram-update.mjs", import.meta.url), "utf8");
  const ignoredBranch = webhook.indexOf('classification.kind === "unsupported"');
  const handlerCall = webhook.indexOf("await handleTelegramUpdate(candidate)");

  assert.ok(ignoredBranch >= 0 && handlerCall > ignoredBranch);
  assert.match(webhook.slice(ignoredBranch, handlerCall), /ok: true, ignored: true/);
  assert.doesNotMatch(classifier, /getDb|env\.DB|transactions|telegramLinks|connectTelegramWithCode/);
  assert.match(webhook, /JSON inválido[\s\S]+status: 400/);
  assert.match(webhook, /Webhook não autorizado[\s\S]+status: 401/);
});

test("webhook retorna 5xx antes do commit e mantém 2xx quando apenas a entrega ao Telegram falha", async () => {
  const webhook = readFileSync(new URL("../app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
  const processing = webhook.indexOf("await handleTelegramUpdate(candidate)");
  const delivery = webhook.indexOf("await hasTelegramDeliveryFailure(deliveries)");
  assert.ok(processing >= 0 && delivery > processing);
  assert.match(webhook, /telegram_webhook_processing_failed/);
  assert.match(webhook, /status: 503/);
  assert.match(webhook, /telegram_webhook_response_failed/);
  assert.match(webhook, /responseDeliveryFailed: true/);
  assert.equal(await hasTelegramDeliveryFailure([Promise.resolve()]), false);
  assert.equal(await hasTelegramDeliveryFailure([Promise.reject(new Error("Telegram indisponível"))]), true);
});

test("callback query é reconhecida sem transformar falha de confirmação visual em retry", () => {
  const webhook = readFileSync(new URL("../app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
  const telegram = readFileSync(new URL("../lib/telegram.ts", import.meta.url), "utf8");
  assert.match(webhook, /answerTelegramCallback\(callbackQueryId\)/);
  assert.match(webhook, /hasTelegramDeliveryFailure\(deliveries\)/);
  assert.match(telegram, /answerCallbackQuery/);
  assert.match(telegram, /callback_query_id: callbackQueryId/);
});

test("handler não deixa operação falível relevante depois de confirmação isolada do update", () => {
  const handler = readFileSync(new URL("../lib/telegram-handler.ts", import.meta.url), "utf8");
  const balanceRead = handler.indexOf("const reply = await balanceText(link.householdId)");
  const balanceCommit = handler.indexOf("await commitUpdate(updateId)", balanceRead);
  assert.ok(balanceRead >= 0 && balanceCommit > balanceRead);
  assert.match(handler, /catch \{ console\.error\("telegram_rate_limit_cleanup_failed"\); \}/);
});

test("C2 T4 guiado resolve cartão e classificação antes de persistir sem gate legado", async () => {
  const db = database(); seedTelegramContext(db); addCard(db); addCardSubcategory(db);
  let response = await handleTelegramUpdate(messageUpdate(5001, "Comprei camiseta de 1,12"));
  assert.equal(storedFinancialState(db).phase, "selecting_payment_flow");
  assertNoCardCreation(db);
  response = await handleTelegramUpdate(callbackUpdate(5002, callbackByText(response, "Cartão de crédito")));
  assert.equal(storedFinancialState(db).phase, "selecting_card");
  response = await handleTelegramUpdate(callbackUpdate(5003, callbackByText(response, "Nubank")));
  assert.equal(storedFinancialState(db).phase, "selecting_category");
  assertNoCardCreation(db);
  response = await handleTelegramUpdate(callbackUpdate(5004, callbackByText(response, "Mercado")));
  assert.equal(storedFinancialState(db).phase, "selecting_subcategory");
  assert.ok(!response.buttons.flat().some((button) => button.text.includes("Sem subcategoria")));
  assertNoCardCreation(db);
  const complete = await completeCardClassification(db, response, 5005);
  assert.equal(complete.state.financialIntent.legacyCardCompatible, false);
  assert.equal(complete.state.financialIntent.installmentCount, 1);
  const result = await handleTelegramUpdate(callbackUpdate(5006, callbackByText(complete.response, "Confirmar")));
  assert.match(result.text, /registrada no cartão/);
  const purchase = db.prepare("SELECT card_id,total_cents,installment_count,category_id,subcategory_id,origin,created_by_user_id FROM card_purchases").get();
  assert.deepEqual({ ...purchase }, { card_id: "card-nubank", total_cents: 112, installment_count: 1, category_id: "category-market", subcategory_id: "subcategory-fair", origin: "telegram", created_by_user_id: "ua" });
  assert.equal(db.prepare("SELECT count(*) total FROM card_installments").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM bills").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id=?").get(`financial:${complete.state.sessionId}`).total, 1);
  assert.equal(storedFinancialState(db), null);
});

test("C2 T5 cartão exato em 3x passa pelo serviço canônico e remove conector residual", async () => {
  const db = database(); seedTelegramContext(db); addCardSubcategory(db);
  db.prepare("UPDATE credit_cards SET name='Cartão teste' WHERE id='card-nubank'").run();
  const response = await handleTelegramUpdate(messageUpdate(5101, "Comprei teste parcelado por R$ 3,00 no cartão Cartão teste em 3x"));
  const complete = await completeCardClassification(db, response, 5102);
  assert.equal(complete.state.financialIntent.description, "Teste parcelado");
  assert.equal(complete.state.financialIntent.installmentCount, 3);
  const result = await handleTelegramUpdate(callbackUpdate(5104, callbackByText(complete.response, "Confirmar")));
  assert.match(result.text, /registrada no cartão/);
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 1);
  assert.deepEqual(db.prepare("SELECT amount_cents FROM card_installments ORDER BY installment_number").all().map((row) => row.amount_cents), [100, 100, 100]);
});

for (const status of ["paid", "closed"]) {
  test(`C2 T5 fatura ${status} responde amigavelmente sem reabrir nem persistir parcialmente`, async () => {
    const db = database(); const at = seedTelegramContext(db);
    const started = await beginFinancialConversation(db, 5201, "Comprei 3 no cartão Nubank em 3x no mercado");
    const [first] = buildInstallmentPlan({ totalCents: 300, count: 3, purchaseDate: started.state.financialIntent.purchaseDate, closingDay: 5, dueDay: 12 });
    db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("blocked", "ha", "card-nubank", first.referenceMonth, first.dueDate, status, at, at);
    const stateBefore = storedFinancialState(db);
    const result = await handleTelegramUpdate(callbackUpdate(5202, callbackByText(started.response, "Confirmar")));
    assert.match(result.text, /Não foi possível registrar.*fatura.*não está aberta/iu);
    assertNoCardCreation(db);
    assert.deepEqual(storedFinancialState(db), stateBefore);
    assert.equal(db.prepare("SELECT count(*) total FROM card_invoices").get().total, 1);
    assert.equal(db.prepare("SELECT status FROM card_invoices WHERE id='blocked'").get().status, status);
    assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id='5202'").get().total, 1);
    assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id=?").get(`financial:${started.state.sessionId}`).total, 0);
    assert.equal((await handleTelegramUpdate(callbackUpdate(5202, callbackByText(started.response, "Confirmar")))).duplicate, true);
  });
}

for (const phrase of ["Comprei 150 no cartão Nubank no mercado", "Comprei 150 no crédito do Nubank no mercado", "Comprei 150 no cartão no mercado"]) {
  test(`C2 1x implícito e único cartão: ${phrase}`, async () => {
    const db = database(); seedTelegramContext(db);
    const started = await beginFinancialConversation(db, 5301, phrase);
    assert.equal(started.state.financialIntent.installmentInputStatus, "valid");
    assert.equal(started.state.financialIntent.installmentCount, 1);
    assert.equal(started.state.financialIntent.cardId, "card-nubank");
    await handleTelegramUpdate(callbackUpdate(5302, callbackByText(started.response, "Confirmar")));
    assert.equal(db.prepare("SELECT installment_count FROM card_purchases").get().installment_count, 1);
  });
}

test("C2 dois cartões perguntam e seleção posterior persiste mesmo com marcador legado false", async () => {
  const db = database(); seedTelegramContext(db); addCard(db);
  let response = await handleTelegramUpdate(messageUpdate(5401, "Comprei 300 no cartão em 2x no mercado"));
  assert.equal(storedFinancialState(db).phase, "selecting_card");
  assertNoCardCreation(db);
  response = await handleTelegramUpdate(callbackUpdate(5402, callbackByText(response, "Segundo")));
  const state = storedFinancialState(db);
  assert.equal(state.phase, "confirming");
  assert.equal(state.financialIntent.legacyCardCompatible, false);
  await handleTelegramUpdate(callbackUpdate(5403, callbackByText(response, "Confirmar")));
  assert.equal(db.prepare("SELECT card_id,installment_count FROM card_purchases").get().card_id, "card-second");
  assert.equal(db.prepare("SELECT count(*) total FROM card_installments").get().total, 2);
});

test("C2 homônimo sem sinal forte permanece ambíguo e não mostra confirmação", async () => {
  const db = database(); seedTelegramContext(db);
  const response = await handleTelegramUpdate(messageUpdate(5501, "Comprei 150 no Nubank no mercado"));
  const state = storedFinancialState(db);
  assert.equal(state.phase, "selecting_payment_flow");
  assert.equal(state.financialIntent.cardId, null);
  assert.equal(state.financialIntent.accountId, null);
  assert.ok(!response.buttons.flat().some((button) => button.text.includes("Confirmar")));
  assertNoCardCreation(db);
});

for (const input of ["0x", "-2x", "121x", "122x", "999x", "1000x", "2,5x"]) {
  test(`C2 parcelas inválidas ${input} não viram 1x nem chegam à confirmação`, async () => {
    const db = database(); seedTelegramContext(db); addCard(db);
    let response = await handleTelegramUpdate(messageUpdate(5601, `Comprei 150 no cartão em ${input} no mercado`));
    assert.equal(storedFinancialState(db).phase, "selecting_card");
    response = await handleTelegramUpdate(callbackUpdate(5602, callbackByText(response, "Nubank")));
    const invalid = storedFinancialState(db);
    assert.equal(invalid.phase, "collecting");
    assert.equal(invalid.field, "parcelas");
    assert.equal(invalid.financialIntent.installmentInputStatus, "invalid");
    assert.equal(invalid.financialIntent.installmentCount, null);
    assertNoCardCreation(db);
    response = await handleTelegramUpdate(callbackUpdate(5603, `${invalid.sessionId}o`));
    assertNoCardCreation(db);
    response = await handleTelegramUpdate(messageUpdate(5604, "3x"));
    assert.equal(storedFinancialState(db).phase, "confirming");
    assert.equal(storedFinancialState(db).financialIntent.installmentInputStatus, "valid");
    await handleTelegramUpdate(callbackUpdate(5605, callbackByText(response, "Confirmar")));
    assert.equal(db.prepare("SELECT installment_count FROM card_purchases").get().installment_count, 3);
  });
}

test("C2 bloqueador 2: parcelas maiores que centavos são invalid + null sem default ou confirmação", async () => {
  const db = database(); seedTelegramContext(db);
  const response = await handleTelegramUpdate(messageUpdate(5701, "Comprei 0,02 no cartão Nubank em 3x no mercado"));
  const state = storedFinancialState(db);
  assert.equal(state.phase, "collecting");
  assert.equal(state.field, "parcelas");
  assert.equal(state.financialIntent.installmentInputStatus, "invalid");
  assert.equal(state.financialIntent.installmentCount, null);
  assert.ok(!response.buttons.flat().some((button) => button.text.includes("Confirmar")));
  await handleTelegramUpdate(callbackUpdate(5702, `${state.sessionId}o`));
  assert.equal(storedFinancialState(db).financialIntent.installmentInputStatus, "invalid");
  assert.equal(storedFinancialState(db).financialIntent.installmentCount, null);
  assertNoCardCreation(db);
});

test("C2 bloqueador 1: capa para cartão confirmada cria somente Bill pelo handler real", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 9701, "Comprei 100 uma capa para cartão de crédito e pago dia 20 no mercado");
  assert.equal(started.state.financialIntent.paymentFlow, "future_bill");
  assert.equal(started.state.financialIntent.cardId, null);
  assert.equal(started.state.financialIntent.installmentInputStatus, "absent");
  assertNoCardCreation(db);
  const result = await handleTelegramUpdate(callbackUpdate(9702, callbackByText(started.response, "Confirmar")));
  assert.match(result.text, /Vencimento.*criado/iu);
  assert.equal(db.prepare("SELECT count(*) total FROM bills").get().total, 1);
  const bill = db.prepare("SELECT status,amount_cents,due_date FROM bills").get();
  assert.equal(bill.status, "pending");
  assert.equal(bill.amount_cents, 10000);
  assert.equal(bill.due_date, started.state.financialIntent.dueDate);
  for (const table of ["card_purchases", "card_invoices", "card_installments", "transactions"]) assert.equal(db.prepare(`SELECT count(*) total FROM ${table}`).get().total, 0, table);
  assert.equal(storedFinancialState(db), null);
});

test("C2 bloqueador 2: três centavos em 3x permanecem valid no state real", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 9711, "Comprei 0,03 no cartão Nubank em 3x no mercado");
  assert.equal(started.state.financialIntent.installmentInputStatus, "valid");
  assert.equal(started.state.financialIntent.installmentCount, 3);
  await handleTelegramUpdate(callbackUpdate(9712, callbackByText(started.response, "Confirmar")));
  assert.deepEqual(db.prepare("SELECT amount_cents FROM card_installments ORDER BY installment_number").all().map((row) => row.amount_cents), [1, 1, 1]);
});

test("C2 bloqueador 2: reduzir valor invalida parcelas e aumentar valor não ressuscita quantidade", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 9721, "Comprei 10 no cartão Nubank em 3x no mercado");
  let response = await handleTelegramUpdate(callbackUpdate(9722, callbackByText(started.response, "Alterar")));
  response = await handleTelegramUpdate(callbackUpdate(9723, callbackByText(response, "Valor")));
  response = await handleTelegramUpdate(messageUpdate(9724, "0,02"));
  const invalid = storedFinancialState(db);
  assert.equal(invalid.phase, "collecting");
  assert.equal(invalid.financialIntent.installmentInputStatus, "invalid");
  assert.equal(invalid.financialIntent.installmentCount, null);
  assert.ok(!response.buttons.flat().some((button) => button.text.includes("Confirmar")));
  // Checkpoint em memória para exercitar o handler de alteração de valor com o intent real invalidado.
  db.prepare("UPDATE telegram_conversation_states SET payload_json=? WHERE telegram_user_id='42'").run(JSON.stringify({ ...invalid, phase: "editing_value" }));
  response = await handleTelegramUpdate(messageUpdate(9725, "10,00"));
  assert.equal(storedFinancialState(db).financialIntent.amountCents, 1000);
  assert.equal(storedFinancialState(db).financialIntent.installmentInputStatus, "invalid");
  assert.equal(storedFinancialState(db).financialIntent.installmentCount, null);
  assert.equal(storedFinancialState(db).phase, "collecting");
  assertNoCardCreation(db);
  response = await handleTelegramUpdate(messageUpdate(9726, "3x"));
  const corrected = storedFinancialState(db);
  assert.equal(corrected.sessionId, started.state.sessionId);
  assert.equal(corrected.phase, "confirming");
  assert.equal(corrected.financialIntent.installmentInputStatus, "valid");
  assert.equal(corrected.financialIntent.installmentCount, 3);
  await handleTelegramUpdate(callbackUpdate(9727, callbackByText(response, "Confirmar")));
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 1);
});

test("C2 bloqueador 2: cancelar e iniciar nova conversa não herda invalid", async () => {
  const db = database(); seedTelegramContext(db);
  const response = await handleTelegramUpdate(messageUpdate(9731, "Comprei 0,02 no cartão Nubank em 3x no mercado"));
  const invalid = storedFinancialState(db);
  assert.equal(invalid.financialIntent.installmentInputStatus, "invalid");
  await handleTelegramUpdate(callbackUpdate(9732, callbackByText(response, "Cancelar")));
  assert.equal(storedFinancialState(db), null);
  const started = await beginFinancialConversation(db, 9733, "Comprei 10 no cartão Nubank no mercado");
  assert.notEqual(started.state.sessionId, invalid.sessionId);
  assert.equal(started.state.financialIntent.installmentInputStatus, "valid");
  assert.equal(started.state.financialIntent.installmentCount, 1);
  assertNoCardCreation(db);
});

test("C2 trocar forma de pagamento não transforma parcelas inválidas em 1x", async () => {
  const db = database(); seedTelegramContext(db);
  const initial = await beginFinancialConversation(db, 5751, "Comprei 150 no pix em 0x no mercado");
  let response = await handleTelegramUpdate(callbackUpdate(5752, callbackByText(initial.response, "Alterar")));
  response = await handleTelegramUpdate(callbackUpdate(5753, callbackByText(response, "Forma de pagamento")));
  await handleTelegramUpdate(callbackUpdate(5754, callbackByText(response, "Cartão de crédito")));
  assert.equal(storedFinancialState(db).phase, "collecting");
  assert.equal(storedFinancialState(db).field, "parcelas");
  assert.equal(storedFinancialState(db).financialIntent.installmentInputStatus, "invalid");
  assert.equal(storedFinancialState(db).financialIntent.installmentCount, null);
  assertNoCardCreation(db);
});

test("C2 alteração das parcelas preserva sessão e classificação antes de confirmar", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 5801, "Comprei 3 no cartão Nubank no mercado");
  let response = await handleTelegramUpdate(callbackUpdate(5802, callbackByText(started.response, "Alterar")));
  response = await handleTelegramUpdate(callbackUpdate(5803, callbackByText(response, "Parcelas")));
  response = await handleTelegramUpdate(messageUpdate(5804, "3x"));
  assert.equal(storedFinancialState(db).sessionId, started.state.sessionId);
  assert.equal(storedFinancialState(db).financialIntent.installmentCount, 3);
  assertNoCardCreation(db);
  await handleTelegramUpdate(callbackUpdate(5805, callbackByText(response, "Confirmar")));
  assert.equal(db.prepare("SELECT count(*) total FROM card_installments").get().total, 3);
});

test("C2 cartão com data da fatura permanece cartão e usa calendário canônico", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 5901, "Comprei 100 no cartão Nubank no mercado e a fatura vence dia 20");
  assert.equal(started.state.financialIntent.paymentFlow, "credit_card");
  assert.equal(started.state.financialIntent.dueDate, null);
  await handleTelegramUpdate(callbackUpdate(5902, callbackByText(started.response, "Confirmar")));
  assert.equal(db.prepare("SELECT due_date FROM card_invoices").get().due_date.slice(-2), "12");
  assert.equal(db.prepare("SELECT count(*) total FROM bills").get().total, 0);
});

test("C2 carnê continua sem persistir e 3x sem meio não presume cartão", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 6001, "Comprei bicicleta 600 em 3x no carnê no mercado, primeiro vencimento dia 20");
  assert.equal(started.state.financialIntent.paymentFlow, "direct_installments");
  const result = await handleTelegramUpdate(callbackUpdate(6002, callbackByText(started.response, "Confirmar")));
  assert.match(result.text, /ainda não está disponível/);
  assertNoCardCreation(db);
  await handleTelegramUpdate(callbackUpdate(6003, callbackByText(started.response, "Cancelar")));
  await handleTelegramUpdate(messageUpdate(6004, "Comprei bicicleta 600 em 3x no mercado"));
  assert.equal(storedFinancialState(db).phase, "selecting_payment_flow");
  assertNoCardCreation(db);
});

test("C2 duas confirmações concorrentes e update repetido produzem uma única compra", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 6101, "Comprei 3 no cartão Nubank no mercado");
  const confirm = callbackByText(started.response, "Confirmar");
  handlerTestEnv.DB.financialBatchBarrier = requestBarrier(2);
  const attempts = await Promise.allSettled([handleTelegramUpdate(callbackUpdate(6102, confirm)), handleTelegramUpdate(callbackUpdate(6103, confirm))]);
  assert.ok(attempts.every((attempt) => attempt.status === "fulfilled"));
  assert.equal((await handleTelegramUpdate(callbackUpdate(6102, confirm))).duplicate, true);
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM card_installments").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM audit_logs WHERE entity_type='card_purchase'").get().total, 1);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id=?").get(`financial:${started.state.sessionId}`).total, 1);
  assert.equal(storedFinancialState(db), null);
});

test("C2 cancelar e callbacks antigos ou adulterados não criam compra nem alteram nova sessão", async () => {
  const db = database(); seedTelegramContext(db);
  const first = await beginFinancialConversation(db, 6201, "Comprei 3 no cartão Nubank no mercado");
  const oldConfirm = callbackByText(first.response, "Confirmar");
  await handleTelegramUpdate(callbackUpdate(6202, callbackByText(first.response, "Cancelar")));
  await handleTelegramUpdate(callbackUpdate(6203, oldConfirm));
  assertNoCardCreation(db);
  const second = await beginFinancialConversation(db, 6204, "Comprei 5 no cartão Nubank no mercado");
  await handleTelegramUpdate(callbackUpdate(6205, oldConfirm));
  await handleTelegramUpdate(callbackUpdate(6206, `AAAAAAAAAAo`));
  assert.deepEqual(storedFinancialState(db), second.state);
  assertNoCardCreation(db);
});

test("C2 falha transitória continua propagando e permite retry sem persistência parcial", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 6301, "Comprei 3 no cartão Nubank no mercado");
  const confirm = callbackByText(started.response, "Confirmar");
  handlerTestEnv.DB.financialBatchBarrier = { async wait() { throw new Error("D1 temporarily unavailable"); } };
  await assert.rejects(handleTelegramUpdate(callbackUpdate(6302, confirm)), /temporarily unavailable/);
  assertNoCardCreation(db);
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_processed_updates WHERE update_id='6302'").get().total, 0);
  assert.deepEqual(storedFinancialState(db), started.state);
  handlerTestEnv.DB.financialBatchBarrier = null;
  await handleTelegramUpdate(callbackUpdate(6302, confirm));
  assert.equal(db.prepare("SELECT count(*) total FROM card_purchases").get().total, 1);
});

test("C2 erro de domínio concorrente não ressuscita sessão cancelada", async () => {
  const db = database(); seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 6401, "Comprei 3 no cartão Nubank no mercado");
  handlerTestEnv.DB.financialBatchBarrier = { async wait() {
    handlerTestEnv.DB.financialBatchBarrier = null;
    await handleTelegramUpdate(callbackUpdate(6403, callbackByText(started.response, "Cancelar")));
    throw new FinanceValidationError("Fatura não está aberta.");
  } };
  const result = await handleTelegramUpdate(callbackUpdate(6402, callbackByText(started.response, "Confirmar")));
  assert.match(result.text, /Fatura não está aberta/);
  assert.equal(storedFinancialState(db), null);
  assertNoCardCreation(db);
});

test("C2 analytics contabiliza parcelas e pagamento de fatura só reduz saldo", async () => {
  const db = database(); const at = seedTelegramContext(db);
  const started = await beginFinancialConversation(db, 6501, "Comprei 3 no cartão Nubank em 3x no mercado");
  await handleTelegramUpdate(callbackUpdate(6502, callbackByText(started.response, "Confirmar")));
  const eventsBefore = db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT entity_type,amount_cents,category_id FROM financial_events ORDER BY event_date`).all("ha", "ha");
  assert.equal(eventsBefore.length, 3);
  assert.ok(eventsBefore.every((row) => row.entity_type === "card_installment" && row.category_id === "category-market"));
  assert.equal(eventsBefore.reduce((sum, row) => sum + row.amount_cents, 0), 300);
  const balanceBefore = db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all("ha", "2099-12-31", "ha", "2099-12-31", "ha")[0].current_balance_cents;
  assert.equal(balanceBefore, 0);
  const invoice = db.prepare("SELECT id FROM card_invoices ORDER BY due_date LIMIT 1").get();
  // Fixture of a later completed invoice settlement, not a second financial expense.
  db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run("payment", "ha", invoice.id, "aa", 100, at, "ua", at);
  db.prepare("UPDATE card_invoices SET status='paid' WHERE id=?").run(invoice.id);
  const eventsAfter = db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT entity_type,amount_cents,category_id FROM financial_events ORDER BY event_date`).all("ha", "ha");
  assert.deepEqual(eventsAfter, eventsBefore);
  const balanceAfter = db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all("ha", "2099-12-31", "ha", "2099-12-31", "ha")[0].current_balance_cents;
  assert.equal(balanceAfter, -100);
  assert.equal(db.prepare("SELECT count(*) total FROM transactions").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) total FROM bills").get().total, 0);
});

test("C2 seleção de cartão de outro household é rejeitada pelo handler", async () => {
  const db = database(); seedTelegramContext(db); addCard(db); addCard(db, "card-other", "hb", "Outro");
  let response = await handleTelegramUpdate(messageUpdate(6601, "Comprei 3 no cartão no mercado"));
  const state = storedFinancialState(db);
  response = await handleTelegramUpdate(callbackUpdate(6602, `${state.sessionId}srcard-other`));
  assert.match(response.text, /inválida|família/);
  assert.equal(storedFinancialState(db).financialIntent.cardId, null);
  assert.equal(storedFinancialState(db).phase, "selecting_card");
  assert.ok(!response.buttons.flat().some((button) => button.callback_data.includes("card-other")));
  assertNoCardCreation(db);
});

test("C2 dois membros da família mantêm autoria e outra família usa somente seus próprios dados", async () => {
  const db = database(); const at = seedTelegramContext(db);
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("ua2", "User a2", "a2@example.com", at, at);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,joined_at,created_at) VALUES(?,?,?,?,?,?,?)").run("ma2", "ha", "ua2", "member", "active", at, at);
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("link-a2", "ha", "ua2", "43", "43", at, at);
  addCard(db, "card-other", "hb", "Outro");
  db.prepare("INSERT INTO categories(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("category-other", "hb", "Saúde", "expense", at, at);
  db.prepare("INSERT INTO telegram_links(id,household_id,user_id,telegram_user_id,chat_id,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("link-b", "hb", "ub", "44", "44", at, at);
  const first = await beginFinancialConversation(db, 6701, "Comprei 3 no cartão Nubank no mercado");
  const second = await beginFinancialConversation(db, 6702, "Comprei 5 no cartão Nubank no mercado", 43);
  await handleTelegramUpdate(callbackUpdate(6703, callbackByText(first.response, "Confirmar")));
  await handleTelegramUpdate(callbackUpdate(6704, callbackByText(second.response, "Confirmar"), 43));
  const other = await handleTelegramUpdate(messageUpdate(6705, "Comprei 7 no cartão Outro em saúde", 44));
  await handleTelegramUpdate(callbackUpdate(6706, callbackByText(other, "Confirmar"), 44));
  const purchases = db.prepare("SELECT household_id,card_id,category_id,created_by_user_id,total_cents FROM card_purchases ORDER BY total_cents").all();
  assert.deepEqual(purchases.map((row) => ({ ...row })), [
    { household_id: "ha", card_id: "card-nubank", category_id: "category-market", created_by_user_id: "ua", total_cents: 300 },
    { household_id: "ha", card_id: "card-nubank", category_id: "category-market", created_by_user_id: "ua2", total_cents: 500 },
    { household_id: "hb", card_id: "card-other", category_id: "category-other", created_by_user_id: "ub", total_cents: 700 },
  ]);
  assert.equal(db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT sum(amount_cents) total FROM financial_events`).get("ha", "ha").total, 800);
  assert.equal(db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT sum(amount_cents) total FROM financial_events`).get("hb", "hb").total, 700);
});

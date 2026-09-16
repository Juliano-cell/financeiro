import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { cardInvoices, invoicePayments, invoicePaymentOperations } from "../db/schema.ts";

const MIGRATION = "0005_invoice_payment_lifecycle.sql";
const AT = "2026-09-16T12:00:00.000Z";
const migrations = readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();

function applyMigration(db, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
}

function database(t, { migrate = true } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations.filter((name) => name < MIGRATION)) applyMigration(db, name);
  if (migrate) applyMigration(db, MIGRATION);
  for (const suffix of ["a", "b"]) seedHousehold(db, suffix);
  return db;
}

function seedHousehold(db, suffix) {
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(`u${suffix}`, `Fixture ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(`h${suffix}`, `Fixture ${suffix}`, `u${suffix}`, AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`m${suffix}`, `h${suffix}`, `u${suffix}`, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`a${suffix}`, `h${suffix}`, `Fixture ${suffix}`, "bank", AT, AT);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`card${suffix}`, `h${suffix}`, `Fixture ${suffix}`, "Fixture", "Fixture", 100000, 17, 25, AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`i${suffix}`, `h${suffix}`, `card${suffix}`, "2026-09", "2026-09-25", AT, AT);
}

function operation(db, changes = {}, { replace = false } = {}) {
  const row = { id: "op", householdId: "ha", key: "key", kind: "payment", invoiceId: "ia", accountId: "aa", userId: "ua", amount: 500, date: "2026-09-16", reversedPaymentId: null, fingerprint: "fixture-fingerprint", ...changes };
  db.prepare(`INSERT ${replace ? "OR REPLACE " : ""}INTO invoice_payment_operations(id,household_id,idempotency_key,kind,invoice_id,account_id,created_by_user_id,amount_cents,occurred_on,reversed_payment_id,request_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.householdId, row.key, row.kind, row.invoiceId, row.accountId, row.userId, row.amount, row.date, row.reversedPaymentId, row.fingerprint, AT);
}

function payment(db, changes = {}, { replace = false } = {}) {
  const row = { id: "p", householdId: "ha", invoiceId: "ia", accountId: "aa", amount: 500, date: "2026-09-16", userId: "ua", operationId: null, ...changes };
  db.prepare(`INSERT ${replace ? "OR REPLACE " : ""}INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at,operation_id) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.householdId, row.invoiceId, row.accountId, row.amount, row.date, row.userId, AT, row.operationId);
}

function reversal(db, changes = {}) {
  operation(db, { id: "rev", key: "rev-key", kind: "reversal", reversedPaymentId: "p", ...changes });
}

function sameHouseholdAlternatives(db) {
  db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("aa2", "ha", "Other fixture", "bank", AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("ia2", "ha", "carda", "2026-10", "2026-10-25", AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,status,created_at) VALUES(?,?,?,?,?)").run("shared-member", "ha", "ub", "active", AT);
}

function financialRows(db) {
  return {
    payments: db.prepare("SELECT * FROM invoice_payments ORDER BY id").all(),
    operations: db.prepare("SELECT * FROM invoice_payment_operations ORDER BY id").all(),
  };
}

function healthy(db) {
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
}

// Match the actual expression, not just a CHECK name or a partial-index flag.
function normalizeSql(expression, tableName) {
  return expression.replaceAll(/[`"]/gu, "").replaceAll(`${tableName}.`, "").replaceAll(/\s+/gu, "").toLowerCase();
}

function checkExpression(ddl, name) {
  const match = new RegExp(`CONSTRAINT [\u0060\"]?${name}[\u0060\"]? CHECK\\s*\\(`, "iu").exec(ddl);
  assert.ok(match, name);
  const start = match.index + match[0].length;
  let depth = 1;
  let quoted = false;
  for (let position = start; position < ddl.length; position++) {
    const character = ddl[position];
    if (character === "'") {
      if (quoted && ddl[position + 1] === "'") { position++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (character === "(") depth++;
      if (character === ")" && --depth === 0) return ddl.slice(start, position);
    }
  }
  assert.fail(`Unclosed CHECK ${name}`);
}

function historicalSnapshot(db) {
  const snapshot = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'invoice_payment_operations' ORDER BY name").all()) {
    // Only SQLite's own identifiers are interpolated; fixture values use bindings.
    const columns = db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all().map(({ name }) => name).filter((name) => !["closes_on", "operation_id"].includes(name));
    const identifiers = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(",");
    snapshot[name] = db.prepare(`SELECT ${identifiers} FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all();
  }
  return snapshot;
}

test("0005 aplica sobre 0000–0004 e preserva todos os fatos históricos sem backfill", (t) => {
  const db = database(t, { migrate: false });
  db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run("legacy", "ha", "ia", "aa", 500, "2026-09-15", "ua", AT);
  db.exec("UPDATE card_invoices SET status='paid', paid_at='2026-09-15' WHERE id='ia'");
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("purchase", "ha", "carda", "Fixture", 500, "2026-09-15", "ua", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("part", "ha", "purchase", "ia", 1, 1, 500, "paid", AT, AT);
  const before = historicalSnapshot(db);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);

  applyMigration(db, MIGRATION);

  assert.deepEqual(historicalSnapshot(db), before);
  assert.equal(db.prepare("SELECT closes_on FROM card_invoices WHERE id='ia'").get().closes_on, null);
  assert.equal(db.prepare("SELECT operation_id FROM invoice_payments WHERE id='legacy'").get().operation_id, null);
  assert.equal(db.prepare("SELECT count(*) n FROM invoice_payment_operations").get().n, 0);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("0005 permite múltiplos pagamentos identificados na mesma invoice junto ao legado NULL", (t) => {
  const db = database(t);
  payment(db);
  operation(db);
  payment(db, { id: "p2", operationId: "op" });
  operation(db, { id: "op2", key: "key2", amount: 100 });
  payment(db, { id: "p3", operationId: "op2", amount: 100 });
  assert.equal(db.prepare("SELECT count(*) n FROM invoice_payments WHERE invoice_id='ia'").get().n, 3);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("0005 mantém a proteção antiga contra segundo pagamento sem operation_id", (t) => {
  const db = database(t);
  payment(db);
  assert.throws(() => payment(db, { id: "duplicate-legacy" }), /UNIQUE/);
  assert.equal(db.prepare("SELECT count(*) n FROM invoice_payments").get().n, 1);
});

test("0005 idempotency_key é única por household, não global", (t) => {
  const db = database(t);
  operation(db);
  assert.throws(() => operation(db, { id: "other" }), /UNIQUE/);
  operation(db, { id: "other-house", householdId: "hb", invoiceId: "ib", accountId: "ab", userId: "ub" });
  assert.equal(db.prepare("SELECT count(*) n FROM invoice_payment_operations").get().n, 2);
});

const blankValues = ["", " ", "\t", "\r", "\n", "\r\n", " \t\r\n ", "\0", "\x01\x1f\x7f\x85", "\u00a0\u1680\u2003\u2028\u2029\u202f\u205f\u3000", "\u200b\u200e\u2060\ufeff", "\t\0\r\n"];

test("0005 rejeita cada whitespace/controle/format Unicode isolado, incluindo controles astrais", (t) => {
  const db = database(t);
  const values = Array.from({ length: 0x110000 }, (_, value) => String.fromCodePoint(value)).filter((value) => /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(value));
  for (const value of values) {
    assert.throws(() => operation(db, { id: value }), /CHECK/, `ID U+${value.codePointAt(0).toString(16)}`);
    assert.throws(() => operation(db, { key: value }), /CHECK/);
    assert.throws(() => operation(db, { fingerprint: value }), /CHECK/);
  }
  healthy(db);
});

test("0005 rejeita ID da operação vazio, whitespace e controles em INSERT e UPDATE", (t) => {
  const db = database(t);
  for (const id of blankValues) assert.throws(() => operation(db, { id }), /CHECK/);
  operation(db);
  for (const id of blankValues) assert.throws(() => db.prepare("UPDATE invoice_payment_operations SET id=? WHERE id='op'").run(id), /CHECK/);
  for (const column of ["household_id", "invoice_id", "account_id", "created_by_user_id"]) {
    for (const value of blankValues) assert.throws(() => db.prepare(`UPDATE invoice_payment_operations SET ${column}=? WHERE id='op'`).run(value), /CHECK|FOREIGN KEY/);
  }
  healthy(db);
});

test("0005 rejeita key/fingerprint semanticamente vazios sem restringir conteúdo legítimo", (t) => {
  const db = database(t);
  for (const value of blankValues) {
    assert.throws(() => operation(db, { key: value }), /CHECK/);
    assert.throws(() => operation(db, { fingerprint: value }), /CHECK/);
  }
  const key = " \toperation / ação : 1\n";
  const fingerprint = " registro : conteúdo legítimo / 1\t";
  operation(db, { key, fingerprint });
  for (const value of blankValues) {
    assert.throws(() => db.prepare("UPDATE invoice_payment_operations SET idempotency_key=? WHERE id='op'").run(value), /CHECK/);
    assert.throws(() => db.prepare("UPDATE invoice_payment_operations SET request_fingerprint=? WHERE id='op'").run(value), /CHECK/);
  }
  assert.equal(db.prepare("SELECT idempotency_key FROM invoice_payment_operations").get().idempotency_key, key);
  assert.equal(db.prepare("SELECT request_fingerprint FROM invoice_payment_operations").get().request_fingerprint, fingerprint);
});

test("0005 operation_id mantém NULL histórico mas rejeita referências semanticamente vazias", (t) => {
  const db = database(t);
  for (const operationId of blankValues) assert.throws(() => payment(db, { operationId }), /CHECK|does not match/);
  payment(db);
  for (const operationId of blankValues) assert.throws(() => db.prepare("UPDATE invoice_payments SET operation_id=? WHERE id='p'").run(operationId), /CHECK|does not match/);
  assert.equal(db.prepare("SELECT operation_id FROM invoice_payments").get().operation_id, null);
  for (const reversedPaymentId of blankValues) assert.throws(() => reversal(db, { reversedPaymentId }), /CHECK|does not match/);
  reversal(db);
  healthy(db);
});

test("0005 REPLACE da operação referenciada não contorna guard relacional", (t) => {
  for (const recursive of [0, 1]) {
    const db = database(t);
    db.exec(`PRAGMA recursive_triggers=${recursive}`);
    sameHouseholdAlternatives(db);
    operation(db);
    payment(db, { operationId: "op" });
    const before = financialRows(db);
    for (const changes of [
      { householdId: "hb", invoiceId: "ib", accountId: "ab", userId: "ub" },
      { invoiceId: "ia2" }, { accountId: "aa2" }, { amount: 501 },
      { userId: "ub" }, { date: "2026-09-15" }, { kind: "no_payment", amount: 0 },
    ]) {
      assert.throws(() => operation(db, changes, { replace: true }), /does not match original payment or linked payment/);
      assert.deepEqual(financialRows(db), before);
    }
    // An identical substitution is not prohibited by an append-only policy in stage 1.
    operation(db, {}, { replace: true });
    assert.deepEqual(financialRows(db), before);
    healthy(db);
  }
});

test("0005 REPLACE do pagamento revertido preserva identidade e reversão legada NULL", (t) => {
  for (const recursive of [0, 1]) {
    const db = database(t);
    db.exec(`PRAGMA recursive_triggers=${recursive}`);
    sameHouseholdAlternatives(db);
    payment(db);
    reversal(db);
    const before = financialRows(db);
    for (const changes of [
      { householdId: "hb", invoiceId: "ib", accountId: "ab", userId: "ub" },
      { invoiceId: "ia2" }, { accountId: "aa2" }, { amount: 501 },
    ]) {
      assert.throws(() => payment(db, changes, { replace: true }), /does not match operation or reversal/);
      assert.deepEqual(financialRows(db), before);
    }
    payment(db, {}, { replace: true });
    assert.deepEqual(financialRows(db), before);
    healthy(db);
  }
});

test("0005 REPLACE não desassocia pagamento identificado nem reutiliza sua operação", (t) => {
  const db = database(t);
  operation(db);
  payment(db, { operationId: "op" });
  operation(db, { id: "op2", key: "key2" });
  const before = financialRows(db);
  for (const changes of [{ operationId: null }, { operationId: "op2" }, { id: "p2", operationId: "op" }]) {
    assert.throws(() => payment(db, changes, { replace: true }), /does not match operation or reversal/);
    assert.deepEqual(financialRows(db), before);
  }
  healthy(db);
});

test("0005 UPDATE OR REPLACE não substitui operação de outro pagamento por colisão de ID", (t) => {
  const db = database(t);
  operation(db, { id: "loose", key: "loose-key" });
  operation(db, { id: "op2", key: "key2", amount: 501 });
  payment(db, { id: "p2", operationId: "op2", amount: 501 });
  const before = financialRows(db);
  assert.throws(() => db.exec("UPDATE OR REPLACE invoice_payment_operations SET id='op2' WHERE id='loose'"), /does not match linked payment/);
  assert.deepEqual(financialRows(db), before);
  healthy(db);
});

test("0005 UPDATE OR REPLACE não substitui pagamento identificado/revertido por colisão de ID", (t) => {
  const db = database(t);
  payment(db, { id: "loose" });
  operation(db, { id: "op2", key: "key2", amount: 501 });
  payment(db, { id: "p2", operationId: "op2", amount: 501 });
  reversal(db, { reversedPaymentId: "p2", amount: 501 });
  const before = financialRows(db);
  assert.throws(() => db.exec("UPDATE OR REPLACE invoice_payments SET id='p2' WHERE id='loose'"), /does not match operation or reversal/);
  assert.deepEqual(financialRows(db), before);
  healthy(db);
});

test("0005 não permite reutilizar operation_id em dois pagamentos", (t) => {
  const db = database(t);
  operation(db);
  payment(db, { operationId: "op" });
  assert.throws(() => payment(db, { id: "duplicate", operationId: "op" }), /does not match operation/);
});

test("0005 valida invoice, account e member da operação no household", (t) => {
  const db = database(t);
  for (const changes of [{ invoiceId: "ib" }, { accountId: "ab" }, { userId: "ub" }, { householdId: "missing" }]) {
    assert.throws(() => operation(db, changes), /FOREIGN KEY/);
  }
  operation(db);
  for (const [column, value] of [["invoice_id", "ib"], ["account_id", "ab"], ["created_by_user_id", "ub"]]) {
    assert.throws(() => db.prepare(`UPDATE invoice_payment_operations SET ${column}=? WHERE id=?`).run(value, "op"), /FOREIGN KEY/);
  }
});

test("0005 pagamento só aceita operação payment com identidade financeira correspondente", (t) => {
  const db = database(t);
  operation(db);
  operation(db, { id: "no-op", key: "no-op-key", kind: "no_payment", amount: 0 });
  for (const changes of [{ operationId: "missing" }, { operationId: "no-op" }, { amount: 501 }, { date: "2026-09-15" }, { invoiceId: "ib" }, { accountId: "ab" }, { userId: "ub" }, { householdId: "hb", invoiceId: "ib", accountId: "ab", userId: "ub" }]) {
    assert.throws(() => payment(db, { operationId: "op", ...changes }), /does not match operation/);
  }
  payment(db, { operationId: "op" });
});

test("0005 preserva FKs scoped para pagamentos legados NULL", (t) => {
  const db = database(t);
  for (const changes of [{ invoiceId: "ib" }, { accountId: "ab" }, { userId: "ub" }]) {
    assert.throws(() => payment(db, changes), /FOREIGN KEY/);
  }
  payment(db);
});

test("0005 reversal integral exige mesmo household, invoice, conta e valor", (t) => {
  const db = database(t);
  payment(db);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("aa2", "ha", "Other fixture", "bank", AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("ia2", "ha", "carda", "2026-10", "2026-10-25", AT, AT);
  for (const changes of [{ reversedPaymentId: "missing" }, { householdId: "hb", invoiceId: "ib", accountId: "ab", userId: "ub" }, { invoiceId: "ia2" }, { accountId: "aa2" }, { amount: 499 }]) {
    assert.throws(() => reversal(db, changes), /does not match original payment/);
  }
  reversal(db);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("0005 rejeita reversal duplicada mesmo com nova idempotency_key", (t) => {
  const db = database(t);
  payment(db);
  reversal(db);
  assert.throws(() => reversal(db, { id: "rev2", key: "rev2-key" }), /UNIQUE/);
  assert.throws(() => payment(db, { id: "not-a-payment", operationId: "rev" }), /does not match operation/);
});

test("0005 permite reversal por outro membro válido da família", (t) => {
  const db = database(t);
  payment(db);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,status,created_at) VALUES(?,?,?,?,?)").run("second-member", "ha", "ub", "active", AT);
  reversal(db, { userId: "ub" });
  assert.equal(db.prepare("SELECT created_by_user_id FROM invoice_payment_operations WHERE id='rev'").get().created_by_user_id, "ub");
});

test("0005 rejeita kind inválido, valores não inteiros/positivos e referências indevidas", (t) => {
  const db = database(t);
  payment(db);
  for (const kind of ["payment", "reversal"]) {
    for (const amount of [-1, 0, 0.5, 9007199254740992]) {
      assert.throws(() => operation(db, { kind, amount, reversedPaymentId: kind === "reversal" ? "p" : null }), /CHECK|does not match original payment/);
    }
  }
  for (const amount of [-1, 1, 0.5]) assert.throws(() => operation(db, { kind: "no_payment", amount }), /CHECK/);
  for (const changes of [{ kind: "invalid" }, { kind: "reversal" }, { reversedPaymentId: "p" }, { kind: "no_payment", amount: 0, reversedPaymentId: "p" }, { key: " " }, { fingerprint: " " }]) {
    assert.throws(() => operation(db, changes), /CHECK|does not match original payment/);
  }
  operation(db, { kind: "no_payment", amount: 0 });
});

test("0005 valida datas civis sem inferir fechamento histórico", (t) => {
  const db = database(t);
  for (const date of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-09-00", "2026-09-16T00:00:00Z", "not-a-date", "0000-01-01"]) {
    assert.throws(() => db.prepare("UPDATE card_invoices SET closes_on=? WHERE id='ia'").run(date), /CHECK/);
    assert.throws(() => operation(db, { date }), /CHECK/);
  }
  for (const date of ["2026-02-28", "2024-02-29"]) {
    db.prepare("UPDATE card_invoices SET closes_on=? WHERE id='ia'").run(date);
    operation(db, { id: date, key: date, date });
  }
  db.exec("UPDATE card_invoices SET closes_on=NULL WHERE id='ia'");
  operation(db, { date: "2028-02-29" });
});

test("0005 guards de update impedem quebrar vínculos pelo lado do pagamento ou operação", (t) => {
  const db = database(t);
  operation(db);
  payment(db, { operationId: "op" });
  reversal(db);
  for (const [column, value] of [["operation_id", null], ["amount_cents", 501], ["paid_at", "2026-09-15"], ["invoice_id", "ib"], ["account_id", "ab"]]) {
    assert.throws(() => db.prepare(`UPDATE invoice_payments SET ${column}=? WHERE id=?`).run(value, "p"), /does not match/);
  }
  for (const [column, value] of [["amount_cents", 501], ["kind", "no_payment"], ["invoice_id", "ib"], ["account_id", "ab"], ["occurred_on", "2026-09-15"]]) {
    assert.throws(() => db.prepare(`UPDATE invoice_payment_operations SET ${column}=? WHERE id=?`).run(value, "op"), /does not match linked payment/);
  }
  assert.throws(() => db.prepare("UPDATE invoice_payment_operations SET amount_cents=? WHERE id=?").run(501, "rev"), /does not match linked payment/);
  assert.throws(() => db.prepare("DELETE FROM invoice_payments WHERE id=?").run("p"), /FOREIGN KEY/);
});

test("0005 guard de reversal protege também pagamento histórico com operation_id NULL", (t) => {
  const db = database(t);
  payment(db);
  reversal(db);
  assert.throws(() => db.exec("UPDATE invoice_payments SET amount_cents=501 WHERE id='p'"), /does not match operation or reversal/);
});

test("0005 UPDATE de reversed_payment_id e kind não cria combinação estrutural inválida", (t) => {
  const db = database(t);
  operation(db);
  payment(db, { operationId: "op" });
  reversal(db);
  operation(db, { id: "op2", key: "key2", amount: 501 });
  payment(db, { id: "p2", operationId: "op2", amount: 501 });
  payment(db, { id: "pb", householdId: "hb", invoiceId: "ib", accountId: "ab", userId: "ub" });
  const before = financialRows(db);
  for (const reversedPaymentId of ["missing", "pb", "p2", null, ""]) {
    assert.throws(() => db.prepare("UPDATE invoice_payment_operations SET reversed_payment_id=? WHERE id='rev'").run(reversedPaymentId), /CHECK|does not match linked payment/);
    assert.deepEqual(financialRows(db), before);
  }
  assert.throws(() => db.exec("UPDATE invoice_payment_operations SET kind='payment' WHERE id='rev'"), /CHECK/);
  assert.throws(() => db.exec("UPDATE invoice_payment_operations SET kind='reversal', reversed_payment_id='p' WHERE id='op'"), /does not match linked payment/);
  assert.throws(() => db.exec("UPDATE invoice_payment_operations SET kind='no_payment', amount_cents=0 WHERE id='op'"), /does not match linked payment/);
  assert.throws(() => db.exec("UPDATE invoice_payment_operations SET reversed_payment_id='p' WHERE id='op2'"), /CHECK/);
  healthy(db);
});

test("0005 mutação compatível de operação não referenciada preserva invariantes sem append-only", (t) => {
  const db = database(t);
  payment(db);
  reversal(db);
  operation(db);
  payment(db, { id: "p2", operationId: "op" });
  db.prepare("UPDATE invoice_payment_operations SET reversed_payment_id=? WHERE id='rev'").run("p2");
  assert.equal(db.prepare("SELECT reversed_payment_id FROM invoice_payment_operations WHERE id='rev'").get().reversed_payment_id, "p2");
  // This is structurally valid, but the future service must prohibit rewriting history.
  operation(db, { id: "unlinked", key: "unlinked-key" });
  db.exec("UPDATE invoice_payment_operations SET kind='no_payment', amount_cents=0 WHERE id='unlinked'");
  healthy(db);
});

test("0005 membership inativa preserva histórico e remoção física referenciada é bloqueada", (t) => {
  const db = database(t);
  operation(db);
  payment(db, { operationId: "op" });
  db.exec("UPDATE household_members SET status='inactive' WHERE id='ma'");
  reversal(db);
  operation(db, { id: "historical-inactive", key: "historical-inactive-key" });
  assert.throws(() => db.exec("DELETE FROM household_members WHERE id='ma'"), /FOREIGN KEY/);
  assert.throws(() => operation(db, { id: "cross-member", key: "cross-key", userId: "ub" }), /FOREIGN KEY/);
  assert.equal(db.prepare("SELECT status FROM household_members WHERE id='ma'").get().status, "inactive");
  healthy(db);
});

test("0005 falha tardia desfaz colunas, tabela, índices e triggers na unidade transacional", (t) => {
  const db = database(t, { migrate: false });
  const before = historicalSnapshot(db);
  // A name collision at the final statement forces failure after DROP/CREATE indexes.
  // This proves SQLite transactional DDL in a single transaction, not a live D1 run.
  db.exec("CREATE TRIGGER invoice_payment_operations_relations_update BEFORE UPDATE ON users BEGIN SELECT 1; END");
  const schemaBefore = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  db.exec("BEGIN");
  assert.throws(() => applyMigration(db, MIGRATION), /already exists/);
  assert.ok(db.prepare("PRAGMA table_info(invoice_payments)").all().some((column) => column.name === "operation_id"));
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='invoice_payments_invoice_unique'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='invoice_payments_legacy_invoice_unique'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='invoice_payments_operation_insert'").get().n, 1);
  db.exec("ROLLBACK");
  assert.deepEqual(historicalSnapshot(db), before);
  assert.deepEqual(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(), schemaBefore);
  assert.equal(db.prepare("PRAGMA table_info(card_invoices)").all().some((column) => column.name === "closes_on"), false);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='invoice_payments_invoice_unique'").get().n, 1);
});

test("0005 mantém compatibilidade com o batch financeiro legado congelado", (t) => {
  const db = database(t);
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("purchase", "ha", "carda", "Fixture", 500, "2026-09-15", "ua", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("part", "ha", "purchase", "ia", 1, 1, 500, "pending", AT, AT);
  // Frozen pre-lifecycle SQL: migration compatibility, not the current API contract.
  const statements = [
    "INSERT INTO invoice_payments (id, household_id, invoice_id, account_id, amount_cents, paid_at, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "UPDATE card_invoices SET status='paid', paid_at=?, updated_at=? WHERE id=? AND household_id=?",
    "UPDATE card_installments SET status='paid', updated_at=? WHERE invoice_id=? AND household_id=? AND status='pending'",
  ];
  db.exec("BEGIN");
  db.prepare(statements[0]).run("legacy-payment", "ha", "ia", "aa", 500, "2026-09-16", "ua", AT);
  db.prepare(statements[1]).run("2026-09-16", AT, "ia", "ha");
  assert.equal(db.prepare(statements[2]).run(AT, "ia", "ha").changes, 1);
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT status FROM card_invoices WHERE id='ia'").get().status, "paid");
  assert.equal(db.prepare("SELECT operation_id FROM invoice_payments").get().operation_id, null);
  assert.equal(db.prepare("SELECT status FROM card_installments WHERE id='part'").get().status, "paid");
  assert.throws(() => db.prepare(statements[0]).run("duplicate-legacy", "ha", "ia", "aa", 500, "2026-09-16", "ua", AT), /UNIQUE/);
  assert.equal(db.prepare("SELECT count(*) n FROM invoice_payment_operations").get().n, 0);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("0005 schema Drizzle alinha colunas, índices, FKs e CHECKs com SQLite real", (t) => {
  const db = database(t);
  const dialect = new SQLiteSyncDialect();
  for (const table of [cardInvoices, invoicePayments, invoicePaymentOperations]) {
    const config = getTableConfig(table);
    const actualColumns = db.prepare(`PRAGMA table_info(${config.name})`).all();
    assert.deepEqual(config.columns.map((column) => column.name).sort(), actualColumns.map((column) => column.name).sort());
    for (const column of config.columns) assert.equal(actualColumns.find((item) => item.name === column.name).notnull, Number(column.notNull || column.primary));
    const actualIndexes = db.prepare(`PRAGMA index_list(${config.name})`).all();
    for (const { config: index } of config.indexes) {
      const actual = actualIndexes.find((item) => item.name === index.name);
      assert.ok(actual, index.name);
      assert.equal(actual.unique, Number(index.unique));
      assert.equal(actual.partial, Number(Boolean(index.where)));
      assert.deepEqual(db.prepare(`PRAGMA index_info(${index.name})`).all().map((item) => item.name), index.columns.map((column) => column.name));
      if (index.where) {
        const actualSql = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(index.name).sql;
        assert.equal(normalizeSql(actualSql.split(/\bWHERE\b/iu)[1], config.name), normalizeSql(dialect.sqlToQuery(index.where).sql, config.name));
      }
    }
    const actualFks = db.prepare(`PRAGMA foreign_key_list(${config.name})`).all();
    for (const fk of config.foreignKeys) {
      const reference = fk.reference();
      const target = getTableConfig(reference.foreignTable).name;
      const first = actualFks.find((key) => key.seq === 0 && key.table === target && key.from === reference.columns[0].name && key.to === reference.foreignColumns[0].name);
      assert.ok(first, `${config.name} -> ${target}`);
      const keys = actualFks.filter((key) => key.id === first.id).sort((a, b) => a.seq - b.seq);
      assert.deepEqual(keys.map((key) => key.from), reference.columns.map((column) => column.name));
      assert.deepEqual(keys.map((key) => key.to), reference.foreignColumns.map((column) => column.name));
    }
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(config.name).sql;
    const newChecks = config.checks.filter((constraint) => config.name === "invoice_payment_operations" || ["card_invoices_closes_on_check", "invoice_payments_operation_id_check"].includes(constraint.name));
    for (const constraint of newChecks) {
      assert.equal(normalizeSql(checkExpression(ddl, constraint.name), config.name), normalizeSql(dialect.sqlToQuery(constraint.value).sql, config.name), constraint.name);
    }
  }
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='invoice_payment_operations'").get().sql;
  for (const constraint of getTableConfig(invoicePaymentOperations).checks) assert.ok(sql.includes(constraint.name), constraint.name);
  for (const name of ["closes_on", "operation_id"]) {
    const table = name === "closes_on" ? "card_invoices" : "invoice_payments";
    assert.equal(db.prepare(`PRAGMA table_info(${table})`).all().find((column) => column.name === name).notnull, 0);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='invoice_payments_invoice_unique'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('invoice_payments_operation_insert','invoice_payments_operation_update','invoice_payment_operations_reversal_insert','invoice_payment_operations_relations_update')").get().n, 4);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  ACCOUNT_BANK_EVENTS_CTE,
  ACCOUNT_MOVEMENTS_CTE,
  CURRENT_ACCOUNT_BALANCES_SQL,
  FINANCIAL_EVENTS_CTE,
} from "../lib/finance-analytics.mjs";

const AT = "2026-09-12T12:00:00.000Z";

const LEGACY_CURRENT_ACCOUNT_BALANCES_SQL = `
WITH transaction_totals AS (
  SELECT
    account_id,
    SUM(CASE WHEN type = 'income' THEN amount_cents ELSE -amount_cents END) AS net_cents
  FROM transactions
  WHERE household_id = ? AND status = 'confirmed' AND transaction_date <= ?
  GROUP BY account_id
), payment_totals AS (
  SELECT account_id, SUM(signed_cents) AS net_cents
  FROM (
    SELECT household_id, account_id, substr(paid_at, 1, 10) AS event_date, -amount_cents AS signed_cents
    FROM invoice_payments
    UNION ALL
    SELECT household_id, account_id, occurred_on, amount_cents
    FROM invoice_payment_operations WHERE kind = 'reversal'
  )
  WHERE household_id = ? AND event_date <= ?
  GROUP BY account_id
)
SELECT
  a.id AS account_id,
  a.is_active,
  a.initial_balance_cents
    + COALESCE(t.net_cents, 0)
    + COALESCE(p.net_cents, 0) AS current_balance_cents
FROM accounts a
LEFT JOIN transaction_totals t ON t.account_id = a.id
LEFT JOIN payment_totals p ON p.account_id = a.id
WHERE a.household_id = ?
ORDER BY a.id
`;

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => file.endsWith(".sql")).sort()) {
    const migration = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

function seedHousehold(db, suffix) {
  const user = `user_${suffix}`;
  const household = `house_${suffix}`;
  const account = `account_${suffix}`;
  const category = `category_${suffix}`;
  const subcategory = `subcategory_${suffix}`;
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run(user, `User ${suffix}`, `${suffix}@example.com`, AT, AT);
  db.prepare("INSERT INTO households(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)").run(household, `House ${suffix}`, user, "2026-01-01T00:00:00.000Z", AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run(`member_${suffix}`, household, user, "owner", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(account, household, `Account ${suffix}`, "bank", 100_000, 1, AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(category, household, `Category ${suffix}`, "expense", "#397f72", AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(subcategory, household, category, `Subcategory ${suffix}`, AT, AT);
  return { user, household, account, category, subcategory };
}

function insertTransaction(db, values) {
  db.prepare("INSERT INTO transactions(id,household_id,type,amount_cents,description,category_id,subcategory_id,transaction_date,responsible_user_id,account_id,payment_method,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(values.id, values.householdId, values.type, values.amountCents, values.description, values.categoryId ?? null, values.subcategoryId ?? null, values.date, values.userId, values.accountId, values.paymentMethod ?? null, values.status ?? "confirmed", "dashboard", AT, AT);
}

function seedAnalyticsScenario() {
  const db = database();
  const a = seedHousehold(db, "a");
  const b = seedHousehold(db, "b");
  db.prepare("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)").run("user_a2", "Second A", "a2@example.com", AT, AT);
  db.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)").run("member_a2", a.household, "user_a2", "member", "active", AT);
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("account_a_inactive", a.household, "Inactive A", "bank", 50_000, 0, AT, AT);
  db.prepare("INSERT INTO categories(id,household_id,name,type,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("category_fuel", a.household, "Transporte", "expense", "#e28a38", AT, AT);
  db.prepare("INSERT INTO subcategories(id,household_id,category_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("subcategory_fuel", a.household, "category_fuel", "Combustível", AT, AT);

  insertTransaction(db, { id: "income", householdId: a.household, type: "income", amountCents: 200_000, description: "Salário", date: "2026-09-01", userId: a.user, accountId: a.account });
  insertTransaction(db, { id: "market", householdId: a.household, type: "expense", amountCents: 10_000, description: "Mercado", categoryId: a.category, subcategoryId: a.subcategory, date: "2026-09-02", userId: a.user, accountId: a.account });
  insertTransaction(db, { id: "fuel", householdId: a.household, type: "expense", amountCents: 5_000, description: "Gasolina", categoryId: "category_fuel", subcategoryId: "subcategory_fuel", date: "2026-09-03", userId: "user_a2", accountId: a.account });
  insertTransaction(db, { id: "inactive-account-expense", householdId: a.household, type: "expense", amountCents: 1_000, description: "Histórico inativo", date: "2026-09-03", userId: a.user, accountId: "account_a_inactive" });
  insertTransaction(db, { id: "paid-bill-transaction", householdId: a.household, type: "expense", amountCents: 20_000, description: "Energia", categoryId: a.category, date: "2026-09-04", userId: a.user, accountId: a.account, paymentMethod: "conta_a_pagar" });
  insertTransaction(db, { id: "future", householdId: a.household, type: "expense", amountCents: 90_000, description: "Futuro", date: "2026-10-01", userId: a.user, accountId: a.account });
  insertTransaction(db, { id: "other-house", householdId: b.household, type: "expense", amountCents: 999_999, description: "Privado B", categoryId: b.category, subcategoryId: b.subcategory, date: "2026-09-02", userId: b.user, accountId: b.account });

  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,status,paid_at,payment_transaction_id,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("bill_paid", a.household, "Energia", 20_000, a.category, "2026-09-04", a.account, "none", "paid", AT, "paid-bill-transaction", a.user, "web", AT, AT);
  db.prepare("INSERT INTO bills(id,household_id,description,amount_cents,category_id,due_date,account_id,recurrence,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("bill_pending", a.household, "Água futura", 30_000, a.category, "2026-09-10", a.account, "none", "pending", a.user, "web", AT, AT);

  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("card_a", a.household, "Nubank", "Nubank", "A", 500_000, 5, 10, AT, AT);
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,subcategory_id,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("purchase_active", a.household, "card_a", "Compra parcelada", 30_000, "2026-08-01", 3, a.category, a.subcategory, "active", a.user, "web", AT, AT);
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("purchase_cancelled", a.household, "card_a", "Compra cancelada", 40_000, "2026-08-01", 1, a.category, "cancelled", a.user, "web", AT, AT);
  for (const [month, due, number, status] of [["2026-09", "2026-09-10", 1, "paid"], ["2026-10", "2026-10-10", 2, "pending"], ["2026-11", "2026-11-10", 3, "pending"]]) {
    db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,paid_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`invoice_${month}`, a.household, "card_a", month, due, status === "paid" ? "paid" : "open", status === "paid" ? "2026-09-10" : null, AT, AT);
    db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`installment_${number}`, a.household, "purchase_active", `invoice_${month}`, number, 3, 10_000, status, AT, AT);
  }
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("invoice_cancelled", a.household, "card_a", "2026-12", "2026-12-10", "open", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("installment_cancelled", a.household, "purchase_cancelled", "invoice_cancelled", 1, 1, 40_000, "pending", AT, AT);
  db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run("invoice_payment", a.household, "invoice_2026-09", a.account, 10_000, "2026-09-10", a.user, AT);
  return { db, a, b };
}

function events(db, householdId, suffix = "", ...bindings) {
  return db.prepare(`${FINANCIAL_EVENTS_CTE} SELECT * FROM financial_events e ${suffix}`).all(householdId, householdId, ...bindings);
}

test("eventos financeiros unificam dinheiro e cartão sem duplicar pagamentos", () => {
  const { db, a } = seedAnalyticsScenario();
  const rows = events(db, a.household, "WHERE e.event_date BETWEEN ? AND ? ORDER BY e.id", "2026-09-01", "2026-09-30");
  const income = rows.filter((row) => row.type === "income").reduce((sum, row) => sum + row.amount_cents, 0);
  const expense = rows.filter((row) => row.type === "expense").reduce((sum, row) => sum + row.amount_cents, 0);
  assert.equal(income, 200_000);
  assert.equal(expense, 46_000);
  assert.equal(rows.filter((row) => row.entity_type === "card_installment").length, 1);
  assert.equal(rows.find((row) => row.entity_type === "card_installment")?.subcategory_id, a.subcategory);
  assert.ok(!rows.some((row) => row.id === "bill_pending" || row.id === "invoice_payment" || row.description === "Compra cancelada"));
  assert.ok(!events(db, a.household).some((row) => row.description === "Compra cancelada"));
  assert.equal(rows.filter((row) => row.description === "Energia").length, 1);
});

test("households, filtros de IDs e responsáveis permanecem isolados", () => {
  const { db, a, b } = seedAnalyticsScenario();
  const own = events(db, a.household, "WHERE e.event_date BETWEEN ? AND ?", "2026-09-01", "2026-09-30");
  assert.ok(!own.some((row) => row.description === "Privado B"));
  assert.equal(events(db, a.household, "WHERE e.category_id = ?", b.category).length, 0);
  assert.equal(events(db, a.household, "WHERE e.account_id = ?", b.account).length, 0);
  assert.equal(own.filter((row) => row.responsible_user_id === "user_a2").reduce((sum, row) => sum + row.amount_cents, 0), 5_000);
});

test("categoria, subcategoria e ausência de subcategoria são agregadas sem inferência", () => {
  const { db, a } = seedAnalyticsScenario();
  const rows = db.prepare(`${FINANCIAL_EVENTS_CTE}
    SELECT category_id, subcategory_id, SUM(amount_cents) AS total
    FROM financial_events e
    WHERE e.household_id = ? AND e.type = 'expense' AND e.event_date BETWEEN ? AND ?
    GROUP BY category_id, subcategory_id
  `).all(a.household, a.household, a.household, "2026-09-01", "2026-09-30");
  assert.equal(rows.find((row) => row.subcategory_id === a.subcategory)?.total, 20_000);
  assert.equal(rows.find((row) => row.subcategory_id === "subcategory_fuel")?.total, 5_000);
  assert.equal(rows.filter((row) => row.subcategory_id === null).reduce((sum, row) => sum + row.total, 0), 21_000);
});

test("analytics preserva compra de cartão legada sem subcategoria", () => {
  const { db, a } = seedAnalyticsScenario();
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,subcategory_id,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("purchase_legacy", a.household, "card_a", "Compra legada", 500, "2026-11-01", 1, a.category, null, "active", a.user, "web", AT, AT);
  db.prepare("INSERT INTO card_installments(id,household_id,purchase_id,invoice_id,installment_number,installment_count,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("installment_legacy", a.household, "purchase_legacy", "invoice_cancelled", 1, 1, 500, "pending", AT, AT);
  const legacy = events(db, a.household).find((row) => row.id === "installment_legacy");
  assert.equal(legacy?.subcategory_id, null);
  assert.equal(legacy?.amount_cents, 500);
});

test("analytics apresenta a numeração original de parcelamento importado", () => {
  const { db, a } = seedAnalyticsScenario();
  db.prepare("UPDATE card_purchases SET origin = 'system' WHERE household_id = ? AND id = 'purchase_active'").run(a.household);
  db.prepare("INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("batch_imported", a.household, "card_a", a.user, "analytics-import", "fingerprint", "2026-09", 10_000, 0, 1, 3, "pending", AT);
  db.prepare("INSERT INTO card_purchase_import_metadata(id,household_id,purchase_id,import_batch_id,first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date,imported_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("metadata_imported", a.household, "purchase_active", "batch_imported", 5, 7, 30_000, "2026-05-01", AT);
  db.prepare("UPDATE card_import_batches SET status = 'completed', completed_at = ? WHERE household_id = ? AND id = 'batch_imported'").run(AT, a.household);
  const rows = events(db, a.household, "WHERE e.entity_type = 'card_installment' ORDER BY e.installment_number");
  assert.deepEqual(rows.map((row) => [row.installment_number, row.installment_count]), [[5, 7], [6, 7], [7, 7]]);
});

test("analytics falha fechado quando metadata importada não corresponde às parcelas físicas", () => {
  const { db, a } = seedAnalyticsScenario();
  db.prepare("UPDATE card_purchases SET origin = 'system' WHERE household_id = ? AND id = 'purchase_active'").run(a.household);
  db.prepare("INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("batch_inconsistent", a.household, "card_a", a.user, "analytics-inconsistent", "fingerprint", "2026-09", 10_000, 0, 1, 3, "pending", AT);
  db.prepare("INSERT INTO card_purchase_import_metadata(id,household_id,purchase_id,import_batch_id,first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date,imported_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("metadata_inconsistent", a.household, "purchase_active", "batch_inconsistent", 5, 7, 30_000, "2026-05-01", AT);
  db.prepare("UPDATE card_import_batches SET status = 'completed', completed_at = ? WHERE household_id = ? AND id = 'batch_inconsistent'").run(AT, a.household);
  db.exec("DROP TRIGGER card_purchase_import_metadata_immutable_update");
  db.prepare("UPDATE card_purchase_import_metadata SET original_installment_count = 8 WHERE household_id = ? AND purchase_id = 'purchase_active'").run(a.household);
  const rows = events(db, a.household, "WHERE e.entity_type = 'card_installment'");
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.installment_number === null && row.installment_count === null));
  const service = readFileSync(new URL("../lib/finance-analytics-service.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/finance/analytics/route.ts", import.meta.url), "utf8");
  assert.match(service, /throw new FinanceAnalyticsIntegrityError/u);
  assert.match(route, /FinanceAnalyticsIntegrityError[\s\S]+status: 409/u);
});

test("analytics falha fechado quando compra importada está sem metadata", () => {
  const { db, a } = seedAnalyticsScenario();
  db.prepare("UPDATE card_purchases SET origin = 'system' WHERE household_id = ? AND id = 'purchase_active'").run(a.household);
  const rows = events(db, a.household, "WHERE e.entity_type = 'card_installment'");
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.installment_number === null && row.installment_count === null));
});

test("analytics falha fechado quando metadata aponta para batch de outro cartão", () => {
  const { db, a } = seedAnalyticsScenario();
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("card_other", a.household, "Outro", "Banco", "A", 500_000, 5, 10, AT, AT);
  db.prepare("UPDATE card_purchases SET origin = 'system' WHERE household_id = ? AND id = 'purchase_active'").run(a.household);
  db.prepare("INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("batch_wrong_card", a.household, "card_other", a.user, "analytics-wrong-card", "fingerprint", "2026-09", 30_000, 0, 1, 3, "pending", AT);
  db.exec("DROP TRIGGER card_purchase_import_metadata_relations_insert");
  db.prepare("INSERT INTO card_purchase_import_metadata(id,household_id,purchase_id,import_batch_id,first_original_installment_number,original_installment_count,original_total_cents,original_purchase_date,imported_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("metadata_wrong_card", a.household, "purchase_active", "batch_wrong_card", 5, 7, 30_000, "2026-05-01", AT);
  const rows = events(db, a.household, "WHERE e.entity_type = 'card_installment'");
  assert.ok(rows.every((row) => row.installment_number === null && row.installment_count === null));
});

test("saldo usa todo o histórico, ignora futuro e mantém contas inativas separadas", () => {
  const { db, a } = seedAnalyticsScenario();
  const balances = db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all(a.household, "2026-09-12", a.household, "2026-09-12", a.household);
  assert.equal(balances.find((row) => row.account_id === a.account)?.current_balance_cents, 255_000);
  assert.equal(balances.find((row) => row.account_id === "account_a_inactive")?.current_balance_cents, 49_000);
  assert.equal(balances.filter((row) => row.is_active).reduce((sum, row) => sum + row.current_balance_cents, 0), 255_000);
});

test("saldo não depende das últimas 200 movimentações", () => {
  const db = database();
  const a = seedHousehold(db, "many");
  for (let index = 0; index < 205; index++) insertTransaction(db, { id: `expense_${index}`, householdId: a.household, type: "expense", amountCents: 100, description: `Expense ${index}`, date: "2026-09-01", userId: a.user, accountId: a.account });
  const [balance] = db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all(a.household, "2026-09-12", a.household, "2026-09-12", a.household);
  assert.equal(balance.current_balance_cents, 79_500);
});

test("agregação por conta separa entradas, saídas reais e movimento líquido sem misturar households", () => {
  const { db, a, b } = seedAnalyticsScenario();
  const query = `${ACCOUNT_MOVEMENTS_CTE}
    SELECT
      a.id AS account_id,
      SUM(CASE WHEN am.type = 'income' THEN am.amount_cents ELSE 0 END) AS income_cents,
      SUM(CASE WHEN am.type = 'expense' THEN am.amount_cents ELSE 0 END) AS expense_cents,
      SUM(CASE WHEN am.type IN ('income', 'settlement_reversal') THEN am.amount_cents ELSE -am.amount_cents END) AS net_movement_cents,
      SUM(am.amount_cents) AS movement_cents,
      COUNT(*) AS movement_count
    FROM account_movements am
    INNER JOIN accounts a ON a.household_id = am.household_id AND a.id = am.account_id
    WHERE am.event_date BETWEEN ? AND ?
    GROUP BY a.id
    ORDER BY a.id`;
  const rows = db.prepare(query).all(a.household, a.household, "2026-09-01", "2026-09-30");
  const active = rows.find((row) => row.account_id === a.account);
  assert.deepEqual({ ...active }, {
    account_id: a.account,
    income_cents: 200_000,
    expense_cents: 35_000,
    net_movement_cents: 155_000,
    movement_cents: 245_000,
    movement_count: 5,
  });
  assert.deepEqual({ ...rows.find((row) => row.account_id === "account_a_inactive") }, {
    account_id: "account_a_inactive",
    income_cents: 0,
    expense_cents: 1_000,
    net_movement_cents: -1_000,
    movement_cents: 1_000,
    movement_count: 1,
  });
  assert.ok(!rows.some((row) => row.account_id === b.account));
});

test("agregação por responsável representa autoria financeira e permanece isolada por household", () => {
  const { db, a, b } = seedAnalyticsScenario();
  insertTransaction(db, { id: "cross-household-responsible", householdId: a.household, type: "expense", amountCents: 7_000, description: "Responsável externo", categoryId: a.category, date: "2026-09-05", userId: b.user, accountId: a.account });
  const query = `${FINANCIAL_EVENTS_CTE}
    SELECT
      hm.user_id AS responsible_user_id,
      COALESCE(u.name, 'Usuário indisponível') AS responsible_name,
      SUM(CASE WHEN e.type = 'income' THEN e.amount_cents ELSE 0 END) AS income_cents,
      SUM(CASE WHEN e.type = 'expense' THEN e.amount_cents ELSE 0 END) AS expense_cents,
      SUM(CASE WHEN e.type = 'income' THEN e.amount_cents ELSE -e.amount_cents END) AS net_movement_cents,
      COUNT(*) AS movement_count
    FROM financial_events e
    LEFT JOIN household_members hm ON hm.household_id = e.household_id AND hm.user_id = e.responsible_user_id
    LEFT JOIN users u ON u.id = hm.user_id
    WHERE e.event_date BETWEEN ? AND ?
    GROUP BY hm.user_id, u.name
    ORDER BY hm.user_id`;
  const rows = db.prepare(query).all(a.household, a.household, "2026-09-01", "2026-09-30");
  assert.deepEqual({ ...rows.find((row) => row.responsible_user_id === a.user) }, {
    responsible_user_id: a.user,
    responsible_name: "User a",
    income_cents: 200_000,
    expense_cents: 41_000,
    net_movement_cents: 159_000,
    movement_count: 5,
  });
  assert.deepEqual({ ...rows.find((row) => row.responsible_user_id === "user_a2") }, {
    responsible_user_id: "user_a2",
    responsible_name: "Second A",
    income_cents: 0,
    expense_cents: 5_000,
    net_movement_cents: -5_000,
    movement_count: 1,
  });
  assert.deepEqual({ ...rows.find((row) => row.responsible_user_id === null) }, {
    responsible_user_id: null,
    responsible_name: "Usuário indisponível",
    income_cents: 0,
    expense_cents: 7_000,
    net_movement_cents: -7_000,
    movement_count: 1,
  });
  assert.ok(!rows.some((row) => row.responsible_user_id === b.user));
  assert.ok(!rows.some((row) => row.responsible_name === "User b"));
  assert.equal(rows.reduce((sum, row) => sum + row.expense_cents, 0), 53_000);
});

test("paginação é estável e respostas vazias permanecem vazias", () => {
  const { db, a } = seedAnalyticsScenario();
  const query = `${FINANCIAL_EVENTS_CTE}
    SELECT id FROM financial_events e
    WHERE e.event_date BETWEEN ? AND ?
    ORDER BY e.event_date DESC, e.id DESC LIMIT ? OFFSET ?`;
  const first = db.prepare(query).all(a.household, a.household, "2026-09-01", "2026-09-30", 2, 0);
  const second = db.prepare(query).all(a.household, a.household, "2026-09-01", "2026-09-30", 2, 2);
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.deepEqual(new Set([...first, ...second].map((row) => row.id)).size, 4);
  assert.deepEqual(db.prepare(query).all(a.household, a.household, "2024-01-01", "2024-01-31", 50, 0), []);
});

function accountBalance(db, sql, householdId, throughDate, accountId) {
  return db.prepare(sql)
    .all(householdId, throughDate, householdId, throughDate, householdId)
    .find((row) => row.account_id === accountId)?.current_balance_cents;
}

function insertInvoiceOperation(db, values) {
  db.prepare(`INSERT INTO invoice_payment_operations(
    id, household_id, idempotency_key, kind, invoice_id, account_id,
    created_by_user_id, amount_cents, occurred_on, reversed_payment_id,
    request_fingerprint, created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.id,
    values.householdId,
    values.idempotencyKey,
    values.kind,
    values.invoiceId,
    values.accountId,
    values.userId,
    values.amountCents,
    values.occurredOn,
    values.reversedPaymentId ?? null,
    values.requestFingerprint,
    AT,
  );
}

test("fonte bancária canônica inclui somente movimentos realizados e mantém identidades distintas", () => {
  const { db, a, b } = seedAnalyticsScenario();

  insertTransaction(db, {
    id: "pending-transaction",
    householdId: a.household,
    type: "expense",
    amountCents: 700,
    description: "Pendente",
    date: "2026-09-02",
    userId: a.user,
    accountId: a.account,
    status: "pending",
  });
  insertTransaction(db, {
    id: "cancelled-transaction",
    householdId: a.household,
    type: "expense",
    amountCents: 800,
    description: "Cancelada",
    date: "2026-09-02",
    userId: a.user,
    accountId: a.account,
    status: "cancelled",
  });
  insertTransaction(db, {
    id: "same-day-expense",
    householdId: a.household,
    type: "expense",
    amountCents: 900,
    description: "Segunda no mesmo dia",
    date: "2026-09-02",
    userId: a.user,
    accountId: a.account,
  });
  insertInvoiceOperation(db, {
    id: "invoice-payment-reversal",
    householdId: a.household,
    idempotencyKey: "reversal-key",
    kind: "reversal",
    invoiceId: "invoice_2026-09",
    accountId: a.account,
    userId: a.user,
    amountCents: 10_000,
    occurredOn: "2026-09-11",
    reversedPaymentId: "invoice_payment",
    requestFingerprint: "reversal-fingerprint",
  });
  insertInvoiceOperation(db, {
    id: "invoice-no-payment",
    householdId: a.household,
    idempotencyKey: "no-payment-key",
    kind: "no_payment",
    invoiceId: "invoice_2026-10",
    accountId: a.account,
    userId: a.user,
    amountCents: 0,
    occurredOn: "2026-09-11",
    requestFingerprint: "no-payment-fingerprint",
  });

  db.prepare("INSERT INTO card_import_batches(id,household_id,card_id,created_by_user_id,idempotency_key,request_fingerprint,initial_reference_month,declared_invoice_total_cents,opening_balance_cents,imported_purchase_count,imported_installment_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("opening-batch", a.household, "card_a", a.user, "opening-key", "opening-fingerprint", "2026-09", 15_000, 5_000, 0, 0, "pending", AT);
  db.prepare("INSERT INTO card_invoice_adjustments(id,household_id,invoice_id,import_batch_id,kind,amount_cents,status,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("opening-adjustment", a.household, "invoice_2026-09", "opening-batch", "opening_balance", 5_000, "active", a.user, AT);
  db.prepare("UPDATE card_import_batches SET status = 'completed', completed_at = ? WHERE id = ? AND household_id = ?")
    .run(AT, "opening-batch", a.household);

  const rows = db.prepare(`${ACCOUNT_BANK_EVENTS_CTE}
    SELECT source_type, source_id, household_id, account_id, event_date,
      signed_amount_cents, event_type
    FROM account_bank_events
    ORDER BY event_date, source_type, source_id`).all(a.household, a.household);
  const byId = new Map(rows.map((row) => [row.source_id, row]));

  assert.equal(byId.get("income")?.event_type, "income");
  assert.equal(byId.get("income")?.signed_amount_cents, 200_000);
  assert.equal(byId.get("market")?.event_type, "expense");
  assert.equal(byId.get("market")?.signed_amount_cents, -10_000);
  assert.equal(byId.get("invoice_payment")?.event_type, "invoice_payment");
  assert.equal(byId.get("invoice_payment")?.signed_amount_cents, -10_000);
  assert.equal(byId.get("invoice-payment-reversal")?.event_type, "invoice_payment_reversal");
  assert.equal(byId.get("invoice-payment-reversal")?.signed_amount_cents, 10_000);
  assert.equal(
    byId.get("invoice_payment").signed_amount_cents + byId.get("invoice-payment-reversal").signed_amount_cents,
    0,
  );

  for (const excludedId of [
    "pending-transaction",
    "cancelled-transaction",
    "invoice-no-payment",
    "purchase_active",
    "installment_1",
    "opening-adjustment",
    "bill_pending",
  ]) assert.equal(byId.has(excludedId), false, `${excludedId} não deve ser evento bancário`);

  assert.equal(rows.filter((row) => row.source_id === "paid-bill-transaction").length, 1);
  assert.equal(rows.filter((row) => row.event_date === "2026-09-02").length, 2);
  assert.equal(new Set(rows.filter((row) => row.event_date === "2026-09-02").map((row) => row.source_id)).size, 2);
  assert.ok(rows.every((row) => row.household_id === a.household));
  assert.ok(!rows.some((row) => row.account_id === b.account || row.source_id === "other-house"));
});

test("saldo canônico preserva exatamente a consulta anterior e exclui eventos futuros", () => {
  const { db, a } = seedAnalyticsScenario();
  insertInvoiceOperation(db, {
    id: "balance-reversal",
    householdId: a.household,
    idempotencyKey: "balance-reversal-key",
    kind: "reversal",
    invoiceId: "invoice_2026-09",
    accountId: a.account,
    userId: a.user,
    amountCents: 10_000,
    occurredOn: "2026-09-11",
    reversedPaymentId: "invoice_payment",
    requestFingerprint: "balance-reversal-fingerprint",
  });

  for (const throughDate of ["2026-09-09", "2026-09-10", "2026-09-11", "2026-10-01"]) {
    assert.deepEqual(
      db.prepare(CURRENT_ACCOUNT_BALANCES_SQL).all(a.household, throughDate, a.household, throughDate, a.household),
      db.prepare(LEGACY_CURRENT_ACCOUNT_BALANCES_SQL).all(a.household, throughDate, a.household, throughDate, a.household),
    );
  }
  assert.equal(accountBalance(db, CURRENT_ACCOUNT_BALANCES_SQL, a.household, "2026-09-30", a.account), 265_000);
  assert.equal(accountBalance(db, CURRENT_ACCOUNT_BALANCES_SQL, a.household, "2026-10-01", a.account), 175_000);
});

test("saldo de 78,13 passa a -21,87 com pagamento e volta a 78,13 com reversão", () => {
  const { db, a } = seedAnalyticsScenario();
  db.prepare("INSERT INTO accounts(id,household_id,name,type,initial_balance_cents,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("manual-account", a.household, "Conta teste manual", "bank", 7_813, 1, AT, AT);
  db.prepare("INSERT INTO credit_cards(id,household_id,name,institution,holder,limit_cents,closing_day,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("manual-card", a.household, "Cartão manual", "Teste", "A", 100_000, 5, 10, AT, AT);
  db.prepare("INSERT INTO card_invoices(id,household_id,card_id,reference_month,due_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("manual-invoice", a.household, "manual-card", "2026-09", "2026-09-25", "open", AT, AT);
  db.prepare("INSERT INTO invoice_payments(id,household_id,invoice_id,account_id,amount_cents,paid_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("manual-payment", a.household, "manual-invoice", "manual-account", 10_000, "2026-09-19", a.user, AT);
  insertInvoiceOperation(db, {
    id: "manual-reversal",
    householdId: a.household,
    idempotencyKey: "manual-reversal-key",
    kind: "reversal",
    invoiceId: "manual-invoice",
    accountId: "manual-account",
    userId: a.user,
    amountCents: 10_000,
    occurredOn: "2026-09-20",
    reversedPaymentId: "manual-payment",
    requestFingerprint: "manual-reversal-fingerprint",
  });

  assert.equal(accountBalance(db, CURRENT_ACCOUNT_BALANCES_SQL, a.household, "2026-09-18", "manual-account"), 7_813);
  assert.equal(accountBalance(db, CURRENT_ACCOUNT_BALANCES_SQL, a.household, "2026-09-19", "manual-account"), -2_187);
  assert.equal(accountBalance(db, CURRENT_ACCOUNT_BALANCES_SQL, a.household, "2026-09-20", "manual-account"), 7_813);
  for (const throughDate of ["2026-09-18", "2026-09-19", "2026-09-20"]) {
    assert.equal(
      accountBalance(db, CURRENT_ACCOUNT_BALANCES_SQL, a.household, throughDate, "manual-account"),
      accountBalance(db, LEGACY_CURRENT_ACCOUNT_BALANCES_SQL, a.household, throughDate, "manual-account"),
    );
  }
});

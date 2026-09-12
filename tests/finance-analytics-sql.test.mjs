import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_ACCOUNT_BALANCES_SQL, FINANCIAL_EVENTS_CTE } from "../lib/finance-analytics.mjs";

const AT = "2026-09-12T12:00:00.000Z";

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
  db.prepare("INSERT INTO card_purchases(id,household_id,card_id,description,total_cents,purchase_date,installment_count,category_id,status,created_by_user_id,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("purchase_active", a.household, "card_a", "Compra parcelada", 30_000, "2026-08-01", 3, a.category, "active", a.user, "web", AT, AT);
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
  assert.equal(rows.find((row) => row.subcategory_id === a.subcategory)?.total, 10_000);
  assert.equal(rows.find((row) => row.subcategory_id === "subcategory_fuel")?.total, 5_000);
  assert.equal(rows.filter((row) => row.subcategory_id === null).reduce((sum, row) => sum + row.total, 0), 31_000);
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

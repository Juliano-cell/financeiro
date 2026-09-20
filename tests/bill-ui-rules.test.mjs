import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeBillSubcategories,
  billActions,
  billClassificationError,
  billDueDayOffset,
  billRelativeDueLabel,
  billTiming,
  billTodayInSaoPaulo,
  buildBillPaymentPayload,
  buildRecurringBillCalendarPayload,
  changeBillCategory,
  eligibleRecurringBillIds,
  filterAndSortBills,
  friendlyBillPaymentError,
  initialBillPaymentAccountId,
  normalizeBillAccountId,
  normalizeRecurringBillSelection,
  recurringBillOccurrences,
  summarizePendingBills,
  toggleRecurringBillSelection,
} from "../lib/bill-ui-rules.mjs";

const categories = [
  { id: "food", name: "Alimentação", type: "expense", isActive: true, subcategories: [{ id: "market", categoryId: "food", name: "Mercado", isActive: true }, { id: "old", categoryId: "food", name: "Antiga", isActive: false }] },
  { id: "transport", name: "Transporte", type: "expense", isActive: true, subcategories: [] },
  { id: "income", name: "Renda", type: "income", isActive: true, subcategories: [] },
  { id: "inactive", name: "Inativa", type: "expense", isActive: false, subcategories: [] },
];
const accounts = [{ id: "primary", name: "Principal", isActive: true }, { id: "second", name: "Segunda", isActive: true }, { id: "old", name: "Antiga", isActive: false }];
const today = "2026-09-20";
const bills = [
  { id: "future", description: "Curso", amountCents: 5000, dueDate: "2026-09-22", accountId: "second", categoryId: "transport", status: "pending" },
  { id: "cancelled", description: "Academia", amountCents: 6000, dueDate: "2026-09-18", accountId: null, categoryId: "food", status: "cancelled" },
  { id: "today", description: "Seguro", amountCents: 11366, dueDate: "2026-09-20", accountId: "primary", categoryId: "transport", status: "pending" },
  { id: "paid", description: "Água", amountCents: 7000, dueDate: "2026-09-17", accountId: "primary", categoryId: "food", status: "paid" },
  { id: "tomorrow", description: "Internet", amountCents: 11990, dueDate: "2026-09-21", accountId: null, categoryId: "food", status: "pending" },
  { id: "overdue", description: "Energia", amountCents: 25000, dueDate: "2026-09-17", accountId: "primary", categoryId: "food", status: "pending" },
];

test("classificação civil distingue atrasada, hoje, amanhã, futura, paga e cancelada", () => {
  assert.equal(billTiming(bills.find((bill) => bill.id === "overdue"), today), "overdue");
  assert.equal(billTiming(bills.find((bill) => bill.id === "today"), today), "today");
  assert.equal(billTiming(bills.find((bill) => bill.id === "tomorrow"), today), "upcoming");
  assert.equal(billTiming(bills.find((bill) => bill.id === "future"), today), "upcoming");
  assert.equal(billTiming(bills.find((bill) => bill.id === "paid"), today), "paid");
  assert.equal(billTiming(bills.find((bill) => bill.id === "cancelled"), today), "cancelled");
});

test("indicadores relativos preservam amanhã, futuro e pluralização do atraso", () => {
  assert.equal(billRelativeDueLabel("2026-09-20", today), "Hoje");
  assert.equal(billRelativeDueLabel("2026-09-21", today), "Amanhã");
  assert.equal(billRelativeDueLabel("2026-09-22", today), "Vence em 2 dias");
  assert.equal(billRelativeDueLabel("2026-09-19", today), "Atrasada há 1 dia");
  assert.equal(billRelativeDueLabel("2026-09-17", today), "Atrasada há 3 dias");
  assert.equal(billDueDayOffset("2026-09-17", today), -3);
});

test("hoje financeiro usa America/Sao_Paulo na virada do UTC", () => {
  assert.equal(billTodayInSaoPaulo(new Date("2026-09-21T01:30:00.000Z")), "2026-09-20");
  assert.equal(billTodayInSaoPaulo(new Date("2026-09-21T03:30:00.000Z")), "2026-09-21");
});

test("filtro padrão mostra pendentes na ordem atrasadas, hoje e próximas", () => {
  assert.deepEqual(filterAndSortBills(bills, { today }).map((bill) => bill.id), ["overdue", "today", "tomorrow", "future"]);
});

test("filtros Pagas, Canceladas e Todas preservam os registros", () => {
  assert.deepEqual(filterAndSortBills(bills, { today, status: "paid" }).map((bill) => bill.id), ["paid"]);
  assert.deepEqual(filterAndSortBills(bills, { today, status: "cancelled" }).map((bill) => bill.id), ["cancelled"]);
  assert.deepEqual(filterAndSortBills(bills, { today, status: "all" }).map((bill) => bill.id), ["overdue", "today", "tomorrow", "future", "paid", "cancelled"]);
});

test("busca, conta e categoria filtram somente os dados já carregados", () => {
  assert.deepEqual(filterAndSortBills(bills, { today, status: "all", search: "internet" }).map((bill) => bill.id), ["tomorrow"]);
  assert.deepEqual(filterAndSortBills(bills, { today, status: "all", accountId: "unassigned" }).map((bill) => bill.id), ["tomorrow", "cancelled"]);
  assert.deepEqual(filterAndSortBills(bills, { today, status: "all", categoryId: "transport" }).map((bill) => bill.id), ["today", "future"]);
});

test("resumo considera apenas pendentes e soma valores por urgência", () => {
  assert.deepEqual(summarizePendingBills(bills, today), {
    overdue: { count: 1, valueCents: 25000 },
    today: { count: 1, valueCents: 11366 },
    upcoming: { count: 2, valueCents: 16990 },
  });
});

test("pagamento preseleciona somente a conta ativa definida na bill", () => {
  assert.equal(initialBillPaymentAccountId({ accountId: "second" }, accounts), "second");
  assert.equal(initialBillPaymentAccountId({ accountId: null }, accounts), null);
  assert.equal(initialBillPaymentAccountId({ accountId: "old" }, accounts), null);
});

test("pagamento nunca usa fallback para a primeira conta ativa", () => {
  assert.equal(initialBillPaymentAccountId({ accountId: null }, accounts), null);
  assert.throws(() => buildBillPaymentPayload("bill", null), /selecione a conta/i);
});

test("pagamento envia accountId explicitamente e respeita troca de conta", () => {
  assert.deepEqual(buildBillPaymentPayload("bill", "primary"), { action: "pay_bill", id: "bill", accountId: "primary" });
  assert.deepEqual(buildBillPaymentPayload("bill", "second"), { action: "pay_bill", id: "bill", accountId: "second" });
});

test("Definir ao pagar é serializado como accountId null no cadastro", () => {
  assert.equal(normalizeBillAccountId("none"), null);
  assert.equal(normalizeBillAccountId(null), null);
  assert.equal(normalizeBillAccountId("second"), "second");
});

test("criação exige categoria e subcategoria ativa quando aplicável", () => {
  assert.match(billClassificationError({ categoryId: null, subcategoryId: null }, categories), /categoria/i);
  assert.match(billClassificationError({ categoryId: "food", subcategoryId: null }, categories), /subcategoria/i);
  assert.equal(billClassificationError({ categoryId: "food", subcategoryId: "market" }, categories), null);
  assert.deepEqual(activeBillSubcategories(categories, "food").map((item) => item.id), ["market"]);
});

test("categoria sem subcategoria aceita null e troca de categoria limpa seleção anterior", () => {
  assert.equal(billClassificationError({ categoryId: "transport", subcategoryId: null }, categories), null);
  assert.deepEqual(changeBillCategory({ categoryId: "food", subcategoryId: "market" }, "transport"), { categoryId: "transport", subcategoryId: null });
});

test("categoria inativa, de receita ou subcategoria incompatível são rejeitadas", () => {
  assert.match(billClassificationError({ categoryId: "inactive", subcategoryId: null }, categories), /inválida/i);
  assert.match(billClassificationError({ categoryId: "income", subcategoryId: null }, categories), /inválida/i);
  assert.match(billClassificationError({ categoryId: "food", subcategoryId: "old" }, categories), /inválida/i);
});

test("ações dependem do status financeiro da bill", () => {
  assert.deepEqual(billActions("pending"), ["pay", "edit", "cancel"]);
  assert.deepEqual(billActions("paid"), ["undo"]);
  assert.deepEqual(billActions("cancelled"), []);
});

test("seleção de recorrências fica restrita à série e somente a ocorrências pendentes", () => {
  const bills = [
    { id: "previous", recurrenceSeriesId: "series-a", dueDate: "2026-08-10", status: "pending" },
    { id: "anchor", recurrenceSeriesId: "series-a", dueDate: "2026-09-10", status: "pending" },
    { id: "paid", recurrenceSeriesId: "series-a", dueDate: "2026-10-10", status: "paid" },
    { id: "cancelled", recurrenceSeriesId: "series-a", dueDate: "2026-11-10", status: "cancelled" },
    { id: "next", recurrenceSeriesId: "series-a", dueDate: "2026-12-10", status: "pending" },
    { id: "foreign-series", recurrenceSeriesId: "series-b", dueDate: "2026-10-05", status: "pending" },
  ];
  assert.deepEqual(recurringBillOccurrences(bills, "series-a").map((bill) => bill.id), ["previous", "anchor", "paid", "cancelled", "next"]);
  assert.deepEqual(eligibleRecurringBillIds(bills, "series-a"), ["previous", "anchor", "next"]);
  assert.deepEqual(eligibleRecurringBillIds(bills, "series-a", "2026-09-10"), ["anchor", "next"]);
});

test("seleção manual normaliza duplicados, bloqueia inelegíveis e permite alternar itens", () => {
  const eligible = ["one", "two"];
  assert.deepEqual(normalizeRecurringBillSelection(["one", "paid", "one"], eligible), ["one"]);
  assert.deepEqual(toggleRecurringBillSelection(["one"], "two", true, eligible), ["one", "two"]);
  assert.deepEqual(toggleRecurringBillSelection(["one", "two"], "one", false, eligible), ["two"]);
  assert.deepEqual(toggleRecurringBillSelection(["one"], "paid", true, eligible), ["one"]);
});

test("payload recorrente só envia calendário quando a opção correspondente está marcada", () => {
  const valueOnly = buildRecurringBillCalendarPayload({ scope: "future", changeDueDate: false, changeRecurrenceEnd: false, dayOfMonth: "14", endsOn: "2026-12-13" });
  assert.deepEqual(valueOnly, { changeDueDate: false, changeRecurrenceEnd: false });
  assert.equal("dayOfMonth" in valueOnly, false);
  assert.equal("endsOn" in valueOnly, false);

  assert.deepEqual(buildRecurringBillCalendarPayload({ scope: "future", changeDueDate: true, changeRecurrenceEnd: false, dayOfMonth: "14", endsOn: "2026-12-13" }), { changeDueDate: true, changeRecurrenceEnd: false, dayOfMonth: 14 });
  assert.deepEqual(buildRecurringBillCalendarPayload({ scope: "future", changeDueDate: false, changeRecurrenceEnd: true, dayOfMonth: "14", endsOn: "2026-12-13" }), { changeDueDate: false, changeRecurrenceEnd: true, endsOn: "2026-12-13" });
  assert.deepEqual(buildRecurringBillCalendarPayload({ scope: "future", changeDueDate: true, changeRecurrenceEnd: true, dayOfMonth: "14", endsOn: "" }), { changeDueDate: true, changeRecurrenceEnd: true, dayOfMonth: 14, endsOn: null });
  assert.deepEqual(buildRecurringBillCalendarPayload({ scope: "selected", changeDueDate: false, changeRecurrenceEnd: true, dayOfMonth: "14", endsOn: "2026-12-13" }), { changeDueDate: false, changeRecurrenceEnd: false });
});

test("erro de classificação recebe mensagem amigável", () => {
  assert.equal(friendlyBillPaymentError("BILL_CLASSIFICATION_REQUIRED", "erro técnico"), "Antes de pagar este vencimento, informe a categoria e a subcategoria.");
  assert.equal(friendlyBillPaymentError(undefined, "Conta inválida."), "Conta inválida.");
});

test("interface abre confirmação e delega operações sem fallback automático", () => {
  const source = readFileSync(new URL("../app/advanced-finance.tsx", import.meta.url), "utf8");
  assert.match(source, /openPayment\(item\)/);
  assert.match(source, /<BillPaymentDialog/);
  assert.match(source, /buildBillPaymentPayload\(bill\.id, accountId\)/);
  assert.match(source, /disabled=\{busy \|\| !accountId\}/);
  assert.doesNotMatch(source, /accounts\.find\(\(value\) => value\.id === item\.accountId\) \?\? accounts\.find/);
  assert.match(source, /action: "undo_bill_payment"/);
  assert.match(source, /action: "update_bill_occurrence"/);
  assert.match(source, /action: "update_recurring_bill_series"/);
  assert.match(source, /anchorBillId: item\.id/);
  assert.match(source, /occurrenceIds/);
  assert.match(source, /buildRecurringBillCalendarPayload/);
  assert.doesNotMatch(source, /changeDueDate: scope === "future" \|\| changeSelectedDueDate/);
  assert.match(source, /Alterar também o dia de vencimento/);
  assert.match(source, /Alterar também a data limite da recorrência/);
  assert.match(source, /Alterar também o dia do vencimento/);
  assert.match(source, /cada ocorrência mantém sua própria data/);
  assert.match(source, /Este e os próximos vencimentos pendentes/);
  assert.match(source, /Escolher vencimentos/);
  assert.match(source, /disabled=\{busy \|\| \(scope === "selected" && selectedIds\.length === 0\)\}/);
  assert.match(source, /action: "cancel_recurring_bill_series"/);
  assert.match(source, /await onChanged\(\)/);
  assert.match(source, /useState<BillStatusFilter>\("pending"\)/);
  assert.match(source, /Resumo dos vencimentos pendentes/);
  assert.match(source, /Buscar descrição/);
  assert.match(source, /Todas as contas/);
  assert.match(source, /Todas as categorias/);
  assert.match(source, /min-h-11 flex-1 sm:flex-none/);
});

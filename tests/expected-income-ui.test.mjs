import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  centsToCurrencyInput,
  currencyInputToCents,
  expectedIncomeDifference,
  expectedIncomeFilterMatch,
  expectedIncomeStatusLabel,
  mutationSemanticKey,
  normalizeExpectedIncomeClassification,
  normalizeExpectedIncomeSelectId,
  recurringExpectedIncomePreview,
  recurringExpectedIncomeStartsOn,
} from "../lib/expected-income-ui-rules.mjs";

const component = readFileSync(new URL("../app/expected-income-manager.tsx", import.meta.url), "utf8");
const parent = readFileSync(new URL("../app/finance-app.tsx", import.meta.url), "utf8");

test("navegação integra Entradas previstas sem substituir Dashboard", () => {
  assert.match(parent, /"expected-income"/u); assert.match(parent, /label: "Entradas previstas"/u); assert.match(parent, /view === "dashboard".*FinanceDashboard/u); assert.match(parent, /ExpectedIncomeManager/u);
});

test("render possui loading, erro recuperável e empty state", () => {
  assert.match(component, /aria-busy="true"/u); assert.match(component, /Não foi possível carregar as entradas previstas/u); assert.match(component, /Tentar novamente/u); assert.match(component, /Nenhuma entrada neste estado/u); assert.match(component, /visible\.slice\(0, visibleLimit\)/u); assert.match(component, /Mostrar mais/u);
});

test("filtros distinguem pending, overdue, received e cancelled", () => {
  const pending = { status: "pending", timing: "pending" }; const overdue = { status: "pending", timing: "overdue" };
  assert.equal(expectedIncomeFilterMatch(pending, "pending"), true); assert.equal(expectedIncomeFilterMatch(pending, "overdue"), false); assert.equal(expectedIncomeFilterMatch(overdue, "overdue"), true); assert.equal(expectedIncomeFilterMatch({ status: "received", timing: "received" }, "received"), true); assert.equal(expectedIncomeFilterMatch({ status: "cancelled", timing: "cancelled" }, "cancelled"), true);
  assert.equal(expectedIncomeStatusLabel(overdue), "Atrasada"); assert.equal(expectedIncomeStatusLabel(pending), "A receber");
});

test("formulário cria única e recorrente e deixa edição limitada à occurrence", () => {
  assert.match(component, /create_occurrence/u); assert.match(component, /create_recurring_series/u); assert.match(component, /update_occurrence/u); assert.match(component, /afeta somente esta ocorrência/u); assert.doesNotMatch(component, /update_series/u);
});

test("entrada única sem categoria normaliza sentinelas e ausência para payload canônico válido", () => {
  for (const empty of [undefined, null, "", "none"]) assert.equal(normalizeExpectedIncomeSelectId(empty), null);
  assert.deepEqual(normalizeExpectedIncomeClassification("none", "none"), { categoryId: null, subcategoryId: null });
  assert.deepEqual(normalizeExpectedIncomeClassification(null, undefined), { categoryId: null, subcategoryId: null });
  assert.deepEqual(normalizeExpectedIncomeClassification("category-a", "none"), { categoryId: "category-a", subcategoryId: null });
  assert.deepEqual(normalizeExpectedIncomeClassification("category-a", "subcategory-a"), { categoryId: "category-a", subcategoryId: "subcategory-a" });
  assert.match(component, /normalizeExpectedIncomeClassification\(categoryId, subcategoryId\)/u);
});

test("remover categoria limpa subcategoria controlada e mantém formulário válido", () => {
  assert.match(component, /setCategoryId\(value\); setSubcategoryId\("none"\)/u);
  assert.match(component, /value=\{subcategoryId\} onValueChange=\{setSubcategoryId\}/u);
  assert.deepEqual(normalizeExpectedIncomeClassification("none", "subcategory-a"), { categoryId: null, subcategoryId: null });
});

test("preview mensal reutiliza regra canônica 29/30/31", () => {
  assert.deepEqual(recurringExpectedIncomePreview("2026-01-01", 31), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.deepEqual(recurringExpectedIncomePreview("2028-01-31", 31), ["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30"]);
  assert.equal(recurringExpectedIncomeStartsOn("2026-01-31", 30), "2026-02-28");
  assert.throws(() => recurringExpectedIncomePreview("2026-03-01", 31, "2026-02-01"), /anterior/u);
});

test("valores monetários preservam centavos e diferença positiva/negativa", () => {
  assert.equal(currencyInputToCents("3.020,00"), 302000); assert.equal(currencyInputToCents("200,5"), 20050); assert.equal(currencyInputToCents("0"), null); assert.equal(centsToCurrencyInput(22000), "220,00");
  assert.equal(expectedIncomeDifference(20000, 22000), 2000); assert.equal(expectedIncomeDifference(20000, 18000), -2000); assert.equal(expectedIncomeDifference(20000, 20000), 0);
  assert.match(component, /Diferença/u); assert.match(component, /difference > 0 \? "\+" : "−"/u);
});

test("recebimento exige conta, impede data futura e permite outra conta", () => {
  assert.match(component, /Selecione a conta efetiva/u); assert.match(component, /receivedDate > today/u); assert.match(component, /A data recebida não pode estar no futuro/u); assert.match(component, /item\.plannedAccount\.id/u); assert.match(component, /accounts\.filter\(\(account\) => account\.isActive\)/u);
});

test("received e cancelled não expõem edição e ações respeitam lifecycle", () => {
  assert.match(component, /item\.status === "pending".*Receber/u); assert.match(component, /item\.status === "received".*Estornar recebimento/u); assert.match(component, /cancel_occurrence/u); assert.match(component, /reverse_receipt/u); assert.match(component, /recebimento original será preservado no extrato/iu); assert.match(component, /name="reversalDate"/u); assert.match(component, /min=\{received\.receivedDate\}/u); assert.match(component, /max=\{today\}/u);
});

test("materialização é explícita e nunca acontece no carregamento GET", () => {
  assert.match(component, /Estender série/u); assert.match(component, /materialize_series/u); assert.match(component, /Abrir a página nunca materializa/u);
  const loadBody = component.slice(component.indexOf("const load ="), component.indexOf("const mutate =")); assert.doesNotMatch(loadBody, /materialize_series|method: "POST"/u);
});

test("double submit usa busy guard e operationId estável por intenção/retry", () => {
  const first = mutationSemanticKey("receive", { amount: 200, date: "2026-01-01" }); const retry = mutationSemanticKey("receive", { date: "2026-01-01", amount: 200 }); const changed = mutationSemanticKey("receive", { amount: 201, date: "2026-01-01" });
  assert.equal(first, retry); assert.notEqual(first, changed); assert.match(component, /intents\.current\.get\(key\)/u); assert.match(component, /intent\.semantic !== semantic/u); assert.match(component, /busy\.current\.has\(key\)/u); assert.match(component, /intents\.current\.delete\(key\)/u);
});

test("privacy mascara lista, formulários, recebido e diferença sem aria vazar valor", () => {
  assert.match(component, /formatFinancialCents\(cents, \{ hidden: valuesHidden \}\)/u); assert.match(component, /type=\{valuesHidden \? "password" : "text"\}/u); assert.match(component, /Valor previsto oculto/u); assert.match(component, /Valor recebido oculto/u); assert.match(component, /Diferença oculta/u); assert.match(component, /valuesHidden \? formatFinancialCents\(0, \{ hidden: true \}\)/u); assert.doesNotMatch(component, /aria-label=\{[^}]*expectedAmountCents/u);
});

test("dark mode usa tokens semânticos e estrutura mobile em cards/dialogs", () => {
  for (const token of ["bg-card", "text-card-foreground", "text-muted-foreground", "border-border", "bg-muted", "text-destructive"]) assert.match(component, new RegExp(token, "u"));
  assert.doesNotMatch(component, /#[0-9a-f]{3,8}/iu); assert.match(component, /grid gap-4 lg:grid-cols-2/u); assert.match(component, /max-h-\[92vh\] overflow-y-auto/u); assert.doesNotMatch(component, /<Table/u);
});

test("acessibilidade inclui labels, tabs, estados, foco e erros associados", () => {
  assert.match(component, /role="tablist"/u); assert.match(component, /role="tab"/u); assert.match(component, /aria-selected/u); assert.match(component, /<Label htmlFor=/u); assert.match(component, /role="alert"/u); assert.match(component, /aria-describedby/u); assert.match(component, /focus-visible:ring/u); assert.match(component, /aria-busy/u);
});

test("UI não permite editar transaction vinculada nem afirma integração ao forecast", () => {
  assert.doesNotMatch(component, /edit_transaction|delete_transaction|receivedTransaction\.id.*onClick/su); assert.match(component, /só entram no realizado quando você confirmar/u); assert.doesNotMatch(component, /\/api\/finance\/forecast/u);
});

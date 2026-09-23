import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBillInstallmentPlan } from "../lib/bill-installment-rules.mjs";
import { FINANCIAL_VALUES_MASK, formatFinancialCents } from "../lib/ui-preferences.mjs";

const source = readFileSync(new URL("../app/advanced-finance.tsx", import.meta.url), "utf8");
const editor = source.slice(source.indexOf("function BillEditorDialog"), source.indexOf("function BillClassificationFields"));
const billsView = source.slice(source.indexOf("function BillsView"), source.indexOf("function BillEditorDialog"));

function plan(totalAmountCents, installmentCount, firstDueDate) {
  return buildBillInstallmentPlan({ description: "Prévia", totalAmountCents, installmentCount, firstDueDate, categoryId: "preview", subcategoryId: null, accountId: null, notes: null });
}

test("cadastro oferece Única, Recorrente e Parcelada sem criar uma segunda tela", () => {
  assert.match(editor, /Tipo da conta/);
  assert.match(editor, /"single","label":"Única"/);
  assert.match(editor, /"recurring","label":"Recorrente"/);
  assert.match(editor, /"installment","label":"Parcelada"/);
  assert.match(editor, /aria-pressed=\{creationMode === option\.value\}/);
  assert.equal((source.match(/function BillEditorDialog/g) ?? []).length, 1);
});

test("modo parcelado apresenta campos e labels específicos sem término de recorrência", () => {
  assert.match(editor, /Valor total \(R\$\)/);
  assert.match(editor, /Quantidade de parcelas/);
  assert.match(editor, /min=\{2\} max=\{120\} step=\{1\}/);
  assert.match(editor, /Primeiro vencimento/);
  assert.match(editor, /creationMode === "recurring".*recurrenceEndDate/);
  assert.doesNotMatch(editor, /creationMode === "installment".*recurrenceEndDate/);
});

test("preview reutiliza a regra pura do servidor e não duplica algoritmo monetário ou calendário", () => {
  assert.match(source, /import \{ buildBillInstallmentPlan \} from "@\/lib\/bill-installment-rules\.mjs"/);
  assert.match(editor, /buildBillInstallmentPlan\(/);
  assert.match(editor, /Prévia visual\. O servidor recalculará o plano ao salvar\./);
  assert.doesNotMatch(editor, /splitInstallments|dateForDayOfMonth|addMonths/);
});

test("preview preserva a divisão canônica em centavos", () => {
  assert.deepEqual(plan(10000, 3, "2026-10-23").map((item) => item.amountCents), [3333, 3333, 3334]);
  assert.deepEqual(plan(500000, 3, "2026-10-23").map((item) => item.amountCents), [166666, 166667, 166667]);
  assert.equal(plan(500000, 3, "2026-10-23").reduce((sum, item) => sum + item.amountCents, 0), 500000);
});

test("preview preserva dias 29, 30, 31, fevereiro e ano bissexto", () => {
  assert.deepEqual(plan(500, 5, "2027-01-31").map((item) => item.dueDate), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
  assert.deepEqual(plan(300, 3, "2028-01-29").map((item) => item.dueDate), ["2028-01-29", "2028-02-29", "2028-03-29"]);
  assert.deepEqual(plan(300, 3, "2027-01-30").map((item) => item.dueDate), ["2027-01-30", "2027-02-28", "2027-03-30"]);
});

test("preview cobre virada de ano e 120 parcelas sem crescer o diálogo indefinidamente", () => {
  assert.deepEqual(plan(400, 4, "2026-11-15").map((item) => item.dueDate), ["2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15"]);
  assert.equal(plan(120, 120, "2026-10-01").length, 120);
  assert.match(editor, /max-h-64/);
  assert.match(editor, /overflow-y-auto/);
});

test("operationId permanece durante retry e só é renovado após sucesso e atualização", () => {
  assert.match(editor, /const \[operationId, setOperationId\] = useState\(\(\) => crypto\.randomUUID\(\)\)/);
  assert.match(editor, /action: "create_installment_bill_series", operationId/);
  const refresh = editor.indexOf("await onChanged();");
  const renew = editor.indexOf("setOperationId(crypto.randomUUID())");
  assert.ok(refresh >= 0 && renew > refresh);
  assert.match(editor, /BILL_INSTALLMENT_IDEMPOTENCY_CONFLICT/);
});

test("lock síncrono e estado busy impedem submissão duplicada", () => {
  assert.match(editor, /const submitLock = useRef\(false\)/);
  assert.match(editor, /if \(submitLock\.current\) return/);
  assert.match(editor, /submitLock\.current = true/);
  assert.match(editor, /submitLock\.current = false/);
  assert.match(editor, /disabled=\{busy \|\|/);
});

test("submissão preserva Única e Recorrente e usa o contrato da API para Parcelada", () => {
  assert.match(editor, /const recurrence = creationMode === "recurring" \? "monthly" : "none"/);
  assert.match(editor, /action: "create_bill"/);
  assert.match(editor, /action: "create_installment_bill_series"/);
  for (const field of ["totalAmountCents", "installmentCount", "firstDueDate", "categoryId", "subcategoryId", "accountId", "notes"]) assert.match(editor, new RegExp(field));
  assert.match(editor, /`\$\{preview\.length\} parcelas criadas\.`/);
});

test("erro recuperável mantém campos controlados e aparece de forma acessível", () => {
  assert.match(editor, /setSubmitError\(message\)/);
  assert.match(editor, /role="alert"/);
  assert.match(editor, /value=\{amount\}/);
  assert.match(editor, /value=\{installmentCount\}/);
  assert.match(editor, /value=\{dueDate\}/);
  assert.doesNotMatch(editor, /setAmount\(""\)|setDueDate\(""\)|setInstallmentCount\("2"\)/);
});

test("listas identificam 1\/N em atrasadas e pagas sem alterar descrição", () => {
  assert.match(billsView, /Parcela \{item\.installment\.number\}\/\{item\.installment\.count\}/);
  assert.match(billsView, /const kind = item\.installment \? "Parcelada"/);
  assert.match(billsView, /item\.description/);
  assert.match(billsView, /Atrasadas — todos os meses/);
  assert.match(billsView, /Por vencimento/);
  assert.match(billsView, /Por pagamento/);
});

test("edição e cancelamento continuam individuais para conta parcelada", () => {
  assert.match(editor, /Editando somente a parcela/);
  assert.match(editor, /As demais parcelas e o valor total original da série não serão recalculados/);
  assert.match(source, /const recurring = Boolean\(bill\.recurrenceSeriesId\)/);
  assert.doesNotMatch(source, /cancel_bill_installment_series|update_bill_installment_series/);
});

test("preview respeita privacidade, dark mode semântico e layout responsivo", () => {
  assert.equal(formatFinancialCents(500000, { hidden: true }), FINANCIAL_VALUES_MASK);
  assert.match(editor, /useUiPreferences\(\)/);
  assert.match(editor, /formatFinancialCents\(previewTotalCents, \{ hidden: valuesHidden \}\)/);
  assert.match(editor, /bg-muted\/40/);
  assert.match(editor, /bg-background/);
  assert.match(editor, /text-muted-foreground/);
  assert.match(editor, /grid-cols-\[auto_minmax\(0,1fr\)\]/);
  assert.match(editor, /sm:grid-cols-\[auto_minmax\(0,1fr\)_auto\]/);
});

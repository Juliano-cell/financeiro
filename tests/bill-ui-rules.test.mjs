import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeBillSubcategories,
  billActions,
  billClassificationError,
  buildBillPaymentPayload,
  changeBillCategory,
  friendlyBillPaymentError,
  initialBillPaymentAccountId,
  normalizeBillAccountId,
} from "../lib/bill-ui-rules.mjs";

const categories = [
  { id: "food", name: "Alimentação", type: "expense", isActive: true, subcategories: [{ id: "market", categoryId: "food", name: "Mercado", isActive: true }, { id: "old", categoryId: "food", name: "Antiga", isActive: false }] },
  { id: "transport", name: "Transporte", type: "expense", isActive: true, subcategories: [] },
  { id: "income", name: "Renda", type: "income", isActive: true, subcategories: [] },
  { id: "inactive", name: "Inativa", type: "expense", isActive: false, subcategories: [] },
];
const accounts = [{ id: "primary", name: "Principal", isActive: true }, { id: "second", name: "Segunda", isActive: true }, { id: "old", name: "Antiga", isActive: false }];

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
  assert.match(source, /action: "cancel_recurring_bill_series"/);
  assert.match(source, /await onChanged\(\)/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeSubcategories,
  applyReportCategoryFilter,
  applyReportSubcategoryFilter,
  changeTransactionCategory,
  changeTransactionType,
  reportMovementMode,
  transactionClassificationError,
} from "../lib/finance-ui-rules.mjs";

const categories = [
  { id: "food", name: "Alimentação", type: "expense", isActive: true, subcategories: [{ id: "market", categoryId: "food", name: "Mercado", isActive: true }, { id: "old", categoryId: "food", name: "Antiga", isActive: false }] },
  { id: "transport", name: "Transporte", type: "expense", isActive: true, subcategories: [] },
  { id: "both", name: "Outros", type: "both", isActive: true, subcategories: [{ id: "other", categoryId: "both", name: "Outros", isActive: true }] },
  { id: "income", name: "Renda", type: "income", isActive: true, subcategories: [] },
];

test("despesa aceita categoria e subcategoria ativas da mesma classificação", () => {
  assert.equal(transactionClassificationError({ type: "expense", categoryId: "food", subcategoryId: "market" }, categories), null);
  assert.deepEqual(activeSubcategories(categories, "food").map((item) => item.id), ["market"]);
});

test("despesa rejeita ausência de subcategoria quando existem opções ativas", () => {
  assert.match(transactionClassificationError({ type: "expense", categoryId: "food", subcategoryId: null }, categories), /subcategoria/i);
});

test("categoria sem subcategorias permite despesa sem subcategoria", () => {
  assert.equal(transactionClassificationError({ type: "expense", categoryId: "transport", subcategoryId: null }, categories), null);
});

test("trocar categoria limpa a subcategoria anterior", () => {
  assert.deepEqual(changeTransactionCategory({ type: "expense", categoryId: "food", subcategoryId: "market" }, "transport"), { type: "expense", categoryId: "transport", subcategoryId: null });
});

test("trocar tipo limpa combinações incompatíveis e preserva categoria compatível", () => {
  assert.deepEqual(changeTransactionType({ type: "expense", categoryId: "food", subcategoryId: "market" }, "income", categories), { type: "income", categoryId: null, subcategoryId: null });
  assert.deepEqual(changeTransactionType({ type: "expense", categoryId: "both", subcategoryId: "other" }, "income", categories), { type: "income", categoryId: "both", subcategoryId: "other" });
});

test("combinação inválida de categoria e subcategoria é rejeitada", () => {
  assert.match(transactionClassificationError({ type: "expense", categoryId: "food", subcategoryId: "other" }, categories), /inválida/i);
});

test("registro legado sem subcategoria exige classificação apenas ao ser salvo novamente", () => {
  const legacy = { type: "expense", categoryId: "food", subcategoryId: null };
  assert.match(transactionClassificationError(legacy, categories), /subcategoria/i);
  assert.equal(legacy.subcategoryId, null);
});

test("filtros por categoria e subcategoria preservam filtros compatíveis", () => {
  const filters = { type: "expense", accountId: "account", categoryId: "food", subcategoryId: "market", responsibleUserId: "user" };
  assert.deepEqual(applyReportCategoryFilter(filters, "transport", categories), { ...filters, categoryId: "transport", subcategoryId: "" });
  assert.deepEqual(applyReportSubcategoryFilter(filters, "other", categories), { ...filters, categoryId: "both", subcategoryId: "other" });
  assert.equal(applyReportSubcategoryFilter(filters, "missing", categories), filters);
});

test("movimentação comum é editável e eventos gerenciados são somente leitura", () => {
  assert.equal(reportMovementMode({ entityType: "transaction", paymentMethod: "pix" }), "edit");
  assert.equal(reportMovementMode({ entityType: "card_installment", paymentMethod: null }), "readonly");
  assert.equal(reportMovementMode({ entityType: "transaction", paymentMethod: "conta_a_pagar" }), "readonly");
});

test("período personalizado continua compartilhado por Dashboard e Relatórios", () => {
  const filter = readFileSync(new URL("../app/finance-period-filter.tsx", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../app/finance-dashboard.tsx", import.meta.url), "utf8");
  const reports = readFileSync(new URL("../app/finance-reports.tsx", import.meta.url), "utf8");
  assert.match(filter, /type="date"/);
  assert.match(filter, /from > to/);
  assert.match(dashboard, /<FinancePeriodFilter/);
  assert.match(reports, /<FinancePeriodFilter/);
});

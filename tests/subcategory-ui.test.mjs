import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manager = readFileSync(new URL("../app/subcategory-manager.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/finance-app.tsx", import.meta.url), "utf8");
const billUi = readFileSync(new URL("../lib/bill-ui-rules.mjs", import.meta.url), "utf8");
const transactionUi = readFileSync(new URL("../lib/finance-ui-rules.mjs", import.meta.url), "utf8");

test("tela organiza subcategorias por categoria e filtra ativas e inativas", () => {
  assert.match(manager, /Subcategorias/);
  assert.match(manager, /value="all">Todas/);
  assert.match(manager, /value="active">Ativas/);
  assert.match(manager, /value="inactive">Inativas/);
  assert.match(manager, /visibleGroups/);
});

test("interface cria, edita, desativa e reativa sem enviar householdId", () => {
  assert.match(manager, /item \? "update_subcategory" : "create_subcategory"/);
  assert.match(manager, /action: "set_subcategory_active"/);
  assert.doesNotMatch(manager, /householdId|household_id/);
  assert.doesNotMatch(manager, /delete_subcategory|DELETE FROM/);
});

test("subcategoria usada bloqueia mudança de categoria com explicação amigável", () => {
  assert.match(manager, /const categoryLocked = Boolean\(item\?\.isInUse\)/);
  assert.match(manager, /já possui lançamentos e não pode ser movida/);
  assert.match(manager, /disabled=\{categoryLocked\}/);
});

test("desativação exige confirmação e explica preservação histórica", () => {
  assert.match(manager, /<AlertDialog/);
  assert.match(manager, /deixará de aparecer em novos lançamentos, mas continuará sendo exibida no histórico/);
  assert.match(manager, /isActive: false/);
});

test("reativação depende de categoria ativa e atualiza o snapshot compartilhado", () => {
  assert.match(manager, /!category\.isActive/);
  assert.match(manager, /Ative a categoria/);
  assert.match(manager, /await onChanged\(\)/);
  assert.match(app, /<SubcategoryManager categories=\{categories\}/);
});

test("formulários existentes continuam filtrando apenas subcategorias ativas", () => {
  assert.match(billUi, /subcategory\.isActive !== false/);
  assert.match(transactionUi, /item\.isActive !== false/);
  assert.match(app, /sub\.isActive !== false/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildAccountStatementQuery,
  formatStatementDate,
  formatStatementMoney,
  formatStatementReferenceMonth,
  mergeStatementItems,
  statementEmptyMessage,
  statementErrorMessage,
  statementEventPresentation,
  statementPaymentMethodLabel,
  validateStatementCustomPeriod,
} from "../lib/account-statement-ui.mjs";

const componentSource = readFileSync(new URL("../app/account-statement.tsx", import.meta.url), "utf8");
const financeAppSource = readFileSync(new URL("../app/finance-app.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../app/api/finance/account-statement/route.ts", import.meta.url), "utf8");

test("integra uma ação explícita Ver extrato na área de Contas", () => {
  assert.match(financeAppSource, /Ver extrato/);
  assert.match(financeAppSource, /setStatementAccountId\(account\.id\)/);
  assert.match(financeAppSource, /<AccountStatementView account=\{statementAccount\}/);
});

test("abre subvisão com retorno, nome, saldo atual e indicador de conta inativa", () => {
  for (const value of ["Voltar para contas", "Extrato da conta", "Saldo atual", "Conta inativa", "account.name", "account.currentBalanceCents"]) {
    assert.ok(componentSource.includes(value), value);
  }
});

test("consome exclusivamente a API read-only do extrato", () => {
  assert.match(componentSource, /fetch\(`\/api\/finance\/account-statement\?\$\{query\}`/);
  assert.doesNotMatch(componentSource, /method:\s*["']POST["']/);
  assert.doesNotMatch(componentSource, /\/api\/finance\/advanced/);
});

test("período padrão é este mês e filtro padrão inclui todos", () => {
  assert.match(componentSource, /useState<PeriodFilter>\("this_month"\)/);
  assert.match(componentSource, /useState<AccountStatementEventFilter>\("all"\)/);
});

test("query envia período, tipo, limite e conta sem datas explícitas em períodos predefinidos", () => {
  const query = new URLSearchParams(buildAccountStatementQuery({ accountId: "account-1", period: "this_month", from: "2026-09-01", to: "2026-09-20", eventType: "all" }));
  assert.deepEqual(Object.fromEntries(query), { accountId: "account-1", period: "this_month", eventType: "all", limit: "50" });
});

test("query personalizada envia datas e cursor opaco sem modificá-lo", () => {
  const query = new URLSearchParams(buildAccountStatementQuery({ accountId: "account-1", period: "custom", from: "2026-08-01", to: "2026-09-20", eventType: "expense", cursor: "opaque_cursor-1", limit: 25 }));
  assert.deepEqual(Object.fromEntries(query), { accountId: "account-1", period: "custom", eventType: "expense", limit: "25", from: "2026-08-01", to: "2026-09-20", cursor: "opaque_cursor-1" });
});

test("validação de período personalizado rejeita datas ausentes, ordem inválida e futuro", () => {
  const common = { period: "custom", today: "2026-09-20" };
  assert.match(validateStatementCustomPeriod({ ...common, from: "", to: "" }), /Informe/);
  assert.match(validateStatementCustomPeriod({ ...common, from: "2026-09-20", to: "2026-09-19" }), /posterior/);
  assert.match(validateStatementCustomPeriod({ ...common, from: "2026-09-20", to: "2026-09-21" }), /futuras/);
  assert.equal(validateStatementCustomPeriod({ ...common, from: "2026-09-01", to: "2026-09-20" }), null);
  assert.equal(validateStatementCustomPeriod({ period: "this_month", from: "", to: "", today: "2026-09-20" }), null);
});

test("alterações de conta e filtros abortam requisição anterior e impedem resposta obsoleta", () => {
  assert.match(componentSource, /new AbortController\(\)/);
  assert.match(componentSource, /controller\.abort\(\)/);
  assert.match(componentSource, /generation !== requestGeneration\.current/);
  assert.match(componentSource, /\[account\.id, eventType, from, period, retry, to, validationError\]/);
});

test("mudança de escopo limpa snapshot, erro e cursor antes da nova resposta", () => {
  assert.match(componentSource, /setSnapshot\(null\)/);
  assert.match(componentSource, /setError\(null\)/);
  assert.match(componentSource, /paginationCursor\.current = null/);
});

test("paginação usa hasMore e nextCursor de topo e evita requisição concorrente repetida", () => {
  assert.match(componentSource, /snapshot\?\.nextCursor/);
  assert.match(componentSource, /!snapshot\?\.hasMore/);
  assert.match(componentSource, /paginationCursor\.current === cursor/);
  assert.match(componentSource, /Carregar mais/);
});

test("paginação preserva reconciliação da primeira página e apenas agrega itens e próximo cursor", () => {
  assert.match(componentSource, /\{ \.\.\.current, items: mergeStatementItems/);
  assert.match(componentSource, /hasMore: next\.hasMore, nextCursor: next\.nextCursor/);
});

test("merge da paginação preserva ordem e remove ids repetidos", () => {
  const first = [{ id: "3" }, { id: "2" }];
  const next = [{ id: "2" }, { id: "1" }];
  assert.deepEqual(mergeStatementItems(first, next).map((item) => item.id), ["3", "2", "1"]);
});

test("reconciliação renderiza diretamente os quatro valores canônicos da API", () => {
  for (const field of ["openingBalanceCents", "periodCreditsCents", "periodDebitsCents", "closingBalanceCents"]) {
    assert.match(componentSource, new RegExp(`snapshot\\.summary\\.${field}`));
  }
  assert.doesNotMatch(componentSource, /openingBalanceCents\s*[+-]/);
  assert.doesNotMatch(componentSource, /closingBalanceCents\s*=/);
});

test("valores em centavos são formatados em pt-BR sem float de domínio", () => {
  assert.equal(formatStatementMoney(10000), "R$ 100,00");
  assert.equal(formatStatementMoney(-2187), "-R$ 21,87");
  assert.equal(formatStatementMoney(1), "R$ 0,01");
});

test("datas civis e mês de referência são formatados sem conversão de timezone", () => {
  assert.equal(formatStatementDate("2026-09-19"), "19/09/2026");
  assert.equal(formatStatementDate("invalid"), "Data indisponível");
  assert.equal(formatStatementReferenceMonth("2026-09"), "09/2026");
  assert.equal(formatStatementReferenceMonth(null), null);
});

test("rótulos contábeis não confundem pagamento com despesa nem reversão com renda", () => {
  assert.deepEqual(statementEventPresentation("income"), { label: "Entrada", direction: "credit" });
  assert.deepEqual(statementEventPresentation("expense"), { label: "Despesa", direction: "debit" });
  assert.deepEqual(statementEventPresentation("invoice_payment"), { label: "Pagamento de fatura", direction: "debit" });
  assert.deepEqual(statementEventPresentation("invoice_payment_reversal"), { label: "Reversão de pagamento", direction: "credit" });
});

test("direção da API controla sinal, cor e descrição acessível", () => {
  assert.match(componentSource, /item\.direction === "credit"/);
  assert.match(componentSource, /credit \? "\+" : "−"/);
  assert.match(componentSource, /aria-label=\{`\$\{credit \? "Crédito" : "Débito"\}/);
});

test("metadados exibem categoria, subcategoria, forma, cartão e referência sem ids", () => {
  for (const field of ["categoryName", "subcategoryName", "paymentMethod", "cardName", "referenceMonth"]) assert.ok(componentSource.includes(field), field);
  assert.doesNotMatch(componentSource, /item\.categoryId/);
  assert.doesNotMatch(componentSource, /item\.cardId/);
  assert.equal(statementPaymentMethodLabel("pix"), "Pix");
  assert.equal(statementPaymentMethodLabel("custom"), "custom");
});

test("estado vazio distingue período sem movimentos de filtro sem resultados", () => {
  const empty = { periodCreditsCents: 0, periodDebitsCents: 0 };
  const movements = { periodCreditsCents: 100, periodDebitsCents: 25 };
  assert.equal(statementEmptyMessage("all", empty), "Nenhuma movimentação neste período.");
  assert.equal(statementEmptyMessage("expense", movements), "Nenhuma movimentação deste tipo no período selecionado.");
  assert.equal(statementEmptyMessage("invoice_payment", empty), "Nenhuma movimentação neste período.");
});

test("erros 400, 401, 403, 404, 409 e genérico têm mensagens amigáveis", () => {
  for (const status of [400, 401, 403, 404, 409, 500]) assert.ok(statementErrorMessage(status).length > 20, status);
  assert.match(statementErrorMessage(401), /sessão expirou/i);
  assert.match(statementErrorMessage(409), /revisados/i);
});

test("sessão expirada segue para login e demais falhas oferecem retry", () => {
  assert.match(componentSource, /errorStatus === 401 \? window\.location\.assign\("\/entrar"\)/);
  assert.match(componentSource, /Tentar novamente/);
  assert.match(componentSource, /Recarregar extrato/);
});

test("loading inicial não exibe falso zero e paginação mantém a lista", () => {
  assert.match(componentSource, /Carregando extrato/);
  assert.match(componentSource, /!loading && snapshot/);
  assert.match(componentSource, /loadingMore/);
  assert.doesNotMatch(componentSource, /setSnapshot\(\{[^}]*openingBalanceCents:\s*0/s);
});

test("layout é responsivo, em lista e sem tabela horizontal", () => {
  assert.match(componentSource, /sm:grid-cols-2 xl:grid-cols-4/);
  assert.match(componentSource, /sm:flex-row/);
  assert.match(componentSource, /<ul>/);
  assert.doesNotMatch(componentSource, /<Table|overflow-x-auto/);
});

test("filtros do frontend permanecem alinhados ao contrato validado pela API", () => {
  for (const value of ["this_month", "last_30_days", "custom", "all", "income", "expense", "invoice_payment", "invoice_payment_reversal"]) {
    assert.ok(componentSource.includes(value), value);
    assert.ok(apiSource.includes(value), value);
  }
});

test("a interface declara que compra no cartão só aparece após movimentar a conta", () => {
  assert.match(componentSource, /Compras no cartão aparecem aqui somente quando a fatura movimenta esta conta/);
});

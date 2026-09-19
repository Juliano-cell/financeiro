import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addReferenceMonth,
  buildOnboardingPayload,
  createOnboardingAttemptManager,
  friendlyOnboardingError,
  nextOriginalInstallments,
  parseBrlCents,
  referenceMonthOptions,
  resolveInstallmentDisplay,
  validateInstallmentDraft,
} from "../lib/card-onboarding-ui-rules.mjs";

const component = readFileSync(new URL("../app/card-onboarding-dialog.tsx", import.meta.url), "utf8");
const advanced = readFileSync(new URL("../app/advanced-finance.tsx", import.meta.url), "utf8");
const detailService = readFileSync(new URL("../lib/invoice-detail-service.ts", import.meta.url), "utf8");
const advancedRoute = readFileSync(new URL("../app/api/finance/advanced/route.ts", import.meta.url), "utf8");
const analytics = readFileSync(new URL("../lib/finance-analytics.mjs", import.meta.url), "utf8");

const installment = (changes = {}) => ({ id: "draft-1", description: "Celular", originalTotal: "600,00", originalInstallmentCount: "10", currentInstallmentNumber: "5", installmentAmount: "60,00", originalPurchaseDate: "2026-05-10", categoryId: "", subcategoryId: "", notes: "", ...changes });
const draft = (changes = {}) => ({ cardId: "card-a", referenceMonth: "2026-10", invoiceTotal: "1.400,00", hasInstallments: true, installments: [installment()], ...changes });

test("botão de configuração está conectado à tela real de cartões", () => {
  assert.match(advanced, /CardOnboardingAction[^>]+card=\{card\}/u);
  assert.match(component, />Configurar situação atual</u);
});

test("elegibilidade é consultada no endpoint aprovado", () => assert.match(component, /\/api\/finance\/card-onboarding\?cardId=/u));
test("cartão inelegível não renderiza ação de onboarding", () => assert.match(component, /eligibility !== "eligible" && !open\) return null/u));
test("fluxo abre em dialog identificado e acessível", () => assert.match(component, /Configurar situação atual · \{card\.name\}/u));
test("cancelar fecha e limpa a tentativa sem POST", () => { assert.match(component, /const close = \(\) => \{ setOpen\(false\); reset\(\); \}/u); assert.match(component, /attempt\.current\.clear\(\)/u); });

test("competências mostram somente mês atual e seguinte em São Paulo", () => {
  const options = referenceMonthOptions(new Date("2026-10-31T23:30:00-03:00"));
  assert.deepEqual(options.map((item) => item.value), ["2026-10", "2026-11"]);
  assert.match(options[0].label, /outubro de 2026/iu);
});
test("adição de mês atravessa dezembro para janeiro", () => assert.equal(addReferenceMonth("2026-12", 1), "2027-01"));

for (const [source, expected] of [["1.400,00", 140000], ["1400,00", 140000], ["R$ 1.400,00", 140000], ["60", 6000], ["60,5", 6050], ["0,01", 1], ["1400.00", 140000]]) {
  test(`reais são convertidos exatamente para cents: ${source}`, () => assert.equal(parseBrlCents(source), expected));
}
for (const source of ["", "-1,00", "1,234", "1.40.0,00", "NaN", "Infinity", "1000000000,01"]) {
  test(`valor monetário inválido é rejeitado: ${source || "vazio"}`, () => assert.equal(parseBrlCents(source), null));
}

test("fatura sem parcelamentos produz payload vazio", () => {
  const result = buildOnboardingPayload(draft({ hasInstallments: false, installments: [] }));
  assert.equal(result.valid, true); assert.deepEqual(result.payload.existingInstallments, []); assert.equal(result.preview.openingBalanceCents, 140000);
});
test("adicionar parcelamento está disponível no formulário", () => assert.match(component, /Adicionar parcelamento/u));
test("remover parcelamento elimina somente o item escolhido", () => assert.match(component, /current\.filter\(\(item\) => item\.id !== installment\.id\)/u));
test("múltiplos parcelamentos entram na prévia", () => {
  const result = buildOnboardingPayload(draft({ installments: [installment(), installment({ id: "draft-2", description: "Notebook", installmentAmount: "100,00" })] }));
  assert.equal(result.valid, true); assert.equal(result.payload.existingInstallments.length, 2); assert.equal(result.preview.currentInstallmentsCents, 16000);
});
test("5/10 permanece 5/10 na revisão", () => { const result = buildOnboardingPayload(draft()); assert.equal(result.payload.existingInstallments[0].currentInstallmentNumber, 5); assert.equal(result.payload.existingInstallments[0].originalInstallmentCount, 10); });
test("próximas parcelas de 5/10 são 6–10", () => assert.deepEqual(nextOriginalInstallments(5, 10), [6, 7, 8, 9, 10]));
test("parcela atual maior que total é bloqueada", () => assert.equal(validateInstallmentDraft(installment({ currentInstallmentNumber: "11" })).valid, false));
test("campos obrigatórios são validados", () => { const result = validateInstallmentDraft(installment({ description: "", originalTotal: "", installmentAmount: "" })); assert.deepEqual(Object.keys(result.errors).sort(), ["description", "installmentAmount", "originalTotal"]); });
test("revisão calcula opening sem se tornar autoridade do backend", () => { const result = buildOnboardingPayload(draft()); assert.deepEqual(result.preview, { declaredCurrentInvoiceTotalCents: 140000, currentInstallmentsCents: 6000, openingBalanceCents: 134000 }); assert.match(component, /backend continua/u); });
test("confirmação financeira é explicitamente separada", () => assert.match(component, /Confirmar situação atual/u));
test("nenhuma escrita ocorre ao avançar pelas etapas", () => { assert.equal((component.match(/method: "POST"/gu) ?? []).length, 1); assert.match(component, /const confirm = async/u); });
test("loading desabilita ações e possui texto compreensível", () => { assert.match(component, /submitting \? "Configurando…"/u); assert.match(component, /disabled=\{submitting/u); });
test("duplo clique é bloqueado sincronamente", () => { assert.match(component, /if \(submittingRef\.current\) return/u); assert.match(component, /submittingRef\.current = true/u); });

test("retry do mesmo payload mantém a idempotency key", () => { let sequence = 0; const manager = createOnboardingAttemptManager(() => `key-${++sequence}`); const payload = { value: 1 }; assert.equal(manager.keyFor(payload), "key-1"); assert.equal(manager.keyFor({ value: 1 }), "key-1"); });
test("alteração financeira gera nova tentativa lógica", () => { let sequence = 0; const manager = createOnboardingAttemptManager(() => `key-${++sequence}`); assert.equal(manager.keyFor({ value: 1 }), "key-1"); assert.equal(manager.keyFor({ value: 2 }), "key-2"); });
test("sucesso encerra tentativa e mostra resumo", () => { assert.match(component, /Situação atual configurada com sucesso/u); assert.match(component, /Compras importadas/u); assert.match(component, /Parcelas importadas/u); });

for (const [status, text] of [[400, /dados/iu], [401, /sessão/iu], [403, /permissão/iu], [404, /disponível/iu], [409, /cartão/iu], [500, /tente novamente/iu]]) {
  test(`erro HTTP ${status} possui mensagem amigável`, () => assert.match(friendlyOnboardingError(status, ""), text));
}

test("sucesso atualiza a tela e marca cartão como inelegível", () => {
  assert.match(component, /setEligibility\("ineligible"\)/u);
  assert.match(component, /await onChanged\(\)/u);
});
test("conflito 409 refaz a consulta de elegibilidade sem forçar", () => assert.match(component, /status === 409 \|\| status === 404/u));
test("wizard fechado não preserva formulário anterior", () => { assert.match(component, /setInvoiceTotal\(""\)/u); assert.match(component, /setInstallments\(\[\]\)/u); });
test("estrutura é mobile-first e dialog possui scroll limitado", () => { assert.match(component, /max-h-\[90vh\] overflow-y-auto sm:max-w-2xl/u); assert.match(component, /w-full sm:w-auto/u); });
test("campos possuem labels e erros acessíveis", () => { assert.match(component, /aria-invalid=\{Boolean\(error\)\}/u); assert.match(component, /role="alert"/u); });

test("read model converte físico 1/6 em 5/10", () => assert.deepEqual(resolveInstallmentDisplay({ physicalNumber: 1, physicalCount: 6, firstOriginalNumber: 5, originalCount: 10 }), { installmentNumber: 5, installmentCount: 10 }));
test("read model converte próxima fatura física 2/6 em 6/10", () => assert.deepEqual(resolveInstallmentDisplay({ physicalNumber: 2, physicalCount: 6, firstOriginalNumber: 5, originalCount: 10 }), { installmentNumber: 6, installmentCount: 10 }));
test("read model converte última física 6/6 em 10/10", () => assert.deepEqual(resolveInstallmentDisplay({ physicalNumber: 6, physicalCount: 6, firstOriginalNumber: 5, originalCount: 10 }), { installmentNumber: 10, installmentCount: 10 }));
test("compra normal sem metadata preserva numeração", () => assert.deepEqual(resolveInstallmentDisplay({ physicalNumber: 2, physicalCount: 10 }), { installmentNumber: 2, installmentCount: 10 }));
test("metadata inconsistente falha fechada", () => assert.equal(resolveInstallmentDisplay({ physicalNumber: 1, physicalCount: 5, firstOriginalNumber: 5, originalCount: 10 }), null));
test("Ver fatura usa metadata sem alterar ledger", () => { assert.match(detailService, /LEFT JOIN card_purchase_import_metadata/u); assert.match(detailService, /resolveInstallmentDisplay/u); });
test("lista geral de parcelas também usa numeração original", () => { assert.match(advancedRoute, /cardPurchaseImportMetadata/u); assert.match(advancedRoute, /inconsistentInstallmentDisplay/u); });
test("dashboard e relatórios também usam numeração original", () => { assert.match(analytics, /card_purchase_import_metadata/u); assert.match(analytics, /first_original_installment_number \+ ci\.installment_number - 1/u); });
test("opening balance continua visível separadamente", () => assert.match(readFileSync(new URL("../app/invoice-detail-dialog.tsx", import.meta.url), "utf8"), /Saldo anterior à implantação/u));
test("paginação do detalhe permanece delegada ao contrato existente", () => { assert.match(detailService, /activePage/u); assert.match(detailService, /cancelledPage/u); assert.match(detailService, /pageSize/u); });

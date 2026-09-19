import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addReferenceMonth,
  buildOnboardingPayload,
  canAddOnboardingCommitment,
  createOnboardingAttemptManager,
  createOnboardingAttemptRegistry,
  friendlyOnboardingError,
  MAX_ONBOARDING_COMMITMENTS,
  nextOriginalInstallments,
  parseBrlCents,
  parseOnboardingSuccessResponse,
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
test("cancelar fecha e limpa somente tentativa ainda não enviada", () => { assert.match(component, /const close = \(\) => \{ setOpen\(false\); reset\(\); \}/u); assert.match(component, /attempt\.clearPrepared\(\)/u); });

test("competências mostram somente mês atual e seguinte em São Paulo", () => {
  const options = referenceMonthOptions(new Date("2026-10-31T23:30:00-03:00"));
  assert.deepEqual(options.map((item) => item.value), ["2026-10", "2026-11"]);
  assert.match(options[0].label, /outubro de 2026/iu);
});
test("adição de mês atravessa dezembro para janeiro", () => assert.equal(addReferenceMonth("2026-12", 1), "2027-01"));

for (const [source, expected] of [["1", 100], ["1,1", 110], ["1,10", 110], ["1.10", 110], ["1.000", 100000], ["1.000,00", 100000], ["1400", 140000], ["1400,00", 140000], ["R$ 1.400,00", 140000], ["  R$ 1.400,00  ", 140000], ["60", 6000], ["60,5", 6050], ["0,01", 1], ["1400.00", 140000]]) {
  test(`reais são convertidos exatamente para cents: ${source}`, () => assert.equal(parseBrlCents(source), expected));
}
for (const source of ["", "1 2", "12 34", "1 000", "1. 000", "1 .000", "1.000 ,00", "1.000, 00", "1\t000", "1\n000", "-1", "-1,00", "1,,00", "1..000", "1.2.3", "1e3", "1E3", "abc", "R$ abc", ",", ".", "R$", "1,234", "1.40.0,00", "NaN", "Infinity", "1000000000,01"]) {
  test(`valor monetário inválido é rejeitado: ${source || "vazio"}`, () => assert.equal(parseBrlCents(source), null));
}
test("regressão: espaço interno não concatena 1 e 2 em R$ 12,00", () => { assert.equal(parseBrlCents("1 2"), null); assert.notEqual(parseBrlCents("1 2"), 1200); });
test("wizard usa diretamente o parser monetário estrito", () => { assert.match(component, /buildOnboardingPayload\(draft\)/u); assert.equal(buildOnboardingPayload(draft({ invoiceTotal: "1 2" })).valid, false); });

test("fatura sem parcelamentos produz payload vazio", () => {
  const result = buildOnboardingPayload(draft({ hasInstallments: false, installments: [] }));
  assert.equal(result.valid, true); assert.deepEqual(result.payload.existingInstallments, []); assert.equal(result.preview.openingBalanceCents, 140000);
});
test("adicionar parcelamento está disponível no formulário", () => assert.match(component, /Adicionar parcelamento/u));
test("remover parcelamento elimina somente o item escolhido", () => assert.match(component, /current\.filter\(\(item\) => item\.id !== installment\.id\)/u));
test("49 parcelamentos ainda permitem adicionar", () => assert.equal(canAddOnboardingCommitment(49), true));
test("50 parcelamentos impedem o 51º no wizard", () => { assert.equal(MAX_ONBOARDING_COMMITMENTS, 50); assert.equal(canAddOnboardingCommitment(50), false); assert.match(component, /disabled=\{!canAddOnboardingCommitment\(installments\.length\)\}/u); });
test("remover um dos 50 permite adicionar novamente", () => { const items = Array.from({ length: 50 }, (_, index) => index); assert.equal(canAddOnboardingCommitment(items.length), false); assert.equal(canAddOnboardingCommitment(items.slice(1).length), true); });
test("payload manipulado com 51 parcelamentos é rejeitado também pelas regras do wizard", () => { const installments = Array.from({ length: 51 }, (_, index) => installment({ id: `draft-${index}` })); const result = buildOnboardingPayload(draft({ installments })); assert.equal(result.valid, false); assert.match(result.error, /no máximo 50/iu); });
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

test("timeout permite retry sem fechar com a mesma idempotency key", () => { let sequence = 0; const manager = createOnboardingAttemptManager(() => `key-${++sequence}`); const payload = { value: 1 }; const first = manager.keyFor(payload); manager.markAmbiguous(payload, first); assert.equal(manager.keyFor({ value: 1 }), first); });
test("timeout sobrevive a fechar e reabrir com a mesma key", () => { let sequence = 0; const manager = createOnboardingAttemptManager(() => `key-${++sequence}`); const payload = { value: 1 }; const first = manager.keyFor(payload); manager.markAmbiguous(payload, first); manager.clearPrepared(); assert.equal(manager.keyFor({ value: 1 }), first); });
test("network failure sobrevive a fechar e reabrir com a mesma key", () => { const manager = createOnboardingAttemptManager(() => "network-key"); const payload = { cardId: "card-a" }; manager.markAmbiguous(payload, manager.keyFor(payload)); manager.clearPrepared(); assert.equal(manager.keyFor(payload), "network-key"); });
test("2xx malformado sobrevive a fechar e reabrir com a mesma key", () => { const manager = createOnboardingAttemptManager(() => "malformed-key"); const payload = { cardId: "card-a" }; const key = manager.keyFor(payload); assert.equal(parseOnboardingSuccessResponse({}, "card-a"), null); manager.markAmbiguous(payload, key); manager.clearPrepared(); assert.equal(manager.keyFor(payload), key); });
test("payload alterado após ambiguidade exige revalidação e não reutiliza key", () => { let sequence = 0; const manager = createOnboardingAttemptManager(() => `key-${++sequence}`); const original = { value: 1 }; const key = manager.keyFor(original); manager.markAmbiguous(original, key); assert.deepEqual(manager.prepare({ value: 2 }), { kind: "requires_revalidation" }); assert.equal(sequence, 1); });
test("cartões diferentes isolam keys e voltar ao cartão A preserva a proteção", () => { let sequence = 0; const registry = createOnboardingAttemptRegistry(() => `key-${++sequence}`); const a = registry.forCard("card-a"); const payloadA = { cardId: "card-a" }; const keyA = a.keyFor(payloadA); a.markAmbiguous(payloadA, keyA); a.clearPrepared(); const keyB = registry.forCard("card-b").keyFor({ cardId: "card-b" }); assert.notEqual(keyB, keyA); assert.equal(registry.forCard("card-a").keyFor(payloadA), keyA); assert.match(component, /const onboardingAttempts = createOnboardingAttemptRegistry\(\)/u); });
test("eligibility posterior inelegível resolve tentativa sem segundo POST", () => { let sequence = 0; const manager = createOnboardingAttemptManager(() => `key-${++sequence}`); const payload = { cardId: "card-a" }; manager.markAmbiguous(payload, manager.keyFor(payload)); manager.resolve(); assert.equal(manager.keyFor(payload), "key-2"); assert.match(component, /if \(!eligible\) attempt\.resolve\(\)/u); });
test("sucesso canônico encerra tentativa", () => { let sequence = 0; const manager = createOnboardingAttemptManager(() => `key-${++sequence}`); const payload = { value: 1 }; manager.keyFor(payload); manager.resolve(); assert.equal(manager.keyFor(payload), "key-2"); });
test("cancelar antes do POST descarta tentativa preparada", () => { let sequence = 0; const manager = createOnboardingAttemptManager(() => `key-${++sequence}`); const payload = { value: 1 }; manager.keyFor(payload); manager.clearPrepared(); assert.equal(manager.keyFor(payload), "key-2"); });
test("sucesso encerra tentativa e mostra resumo", () => { assert.match(component, /Situação atual configurada com sucesso/u); assert.match(component, /Compras importadas/u); assert.match(component, /Parcelas importadas/u); });

const validSuccessResponse = {
  cardId: "card-a",
  batchId: "batch-a",
  invoiceId: "invoice-a",
  referenceMonth: "2026-10",
  declaredCurrentInvoiceTotalCents: 140000,
  openingBalanceCents: 130000,
  importedPurchaseCount: 1,
  importedInstallmentCount: 6,
  status: "completed",
  replayed: false,
};

test("resposta 2xx canônica é aceita sem coerção", () => assert.deepEqual(parseOnboardingSuccessResponse(validSuccessResponse, "card-a"), validSuccessResponse));
for (const identifier of ["card_123", "card:123", "card/123.with spaces", "x"]) {
  test(`ID legítimo aceito conforme contrato da API: ${identifier}`, () => {
    const response = { ...validSuccessResponse, cardId: identifier, batchId: identifier, invoiceId: identifier };
    assert.deepEqual(parseOnboardingSuccessResponse(response, identifier), response);
  });
}
for (const identifier of ["", null, 123, {}, "x".repeat(101)]) {
  test(`ID fora do contrato da API é rejeitado: ${String(identifier)}`, () => assert.equal(parseOnboardingSuccessResponse({ ...validSuccessResponse, batchId: identifier }, "card-a"), null));
}
for (const [label, response] of [
  ["null", null], ["objeto vazio", {}], ["array", []], ["string", "ok"], ["true", true], ["false", false], ["zero", 0],
  ["cardId ausente", { ...validSuccessResponse, cardId: undefined }],
  ["cardId errado", { ...validSuccessResponse, cardId: "card-b" }],
  ["batchId ausente", { ...validSuccessResponse, batchId: undefined }],
  ["invoiceId ausente", { ...validSuccessResponse, invoiceId: undefined }],
  ["referenceMonth ausente", { ...validSuccessResponse, referenceMonth: undefined }],
  ["referenceMonth inválido", { ...validSuccessResponse, referenceMonth: "10/2026" }],
  ["total ausente", { ...validSuccessResponse, declaredCurrentInvoiceTotalCents: undefined }],
  ["total string", { ...validSuccessResponse, declaredCurrentInvoiceTotalCents: "140000" }],
  ["opening ausente", { ...validSuccessResponse, openingBalanceCents: undefined }],
  ["opening negativo", { ...validSuccessResponse, openingBalanceCents: -1 }],
  ["count ausente", { ...validSuccessResponse, importedPurchaseCount: undefined }],
  ["count inválido", { ...validSuccessResponse, importedInstallmentCount: 1.5 }],
  ["status ausente", { ...validSuccessResponse, status: undefined }],
  ["status inesperado", { ...validSuccessResponse, status: "pending" }],
  ["replayed inválido", { ...validSuccessResponse, replayed: "false" }],
]) test(`resposta 2xx malformada não declara sucesso: ${label}`, () => assert.equal(parseOnboardingSuccessResponse(response, "card-a"), null));

test("JSON inválido em 2xx segue para validação estrita e não declara sucesso", () => { assert.match(component, /catch \{ \/\* resposta inválida é tratada abaixo \*\//u); assert.match(component, /parseOnboardingSuccessResponse\(body, card\.id\)/u); assert.equal(parseOnboardingSuccessResponse({}, "card-a"), null); });
test("resposta 2xx ambígua preserva a mesma tentativa idempotente", () => { let sequence = 0; const manager = createOnboardingAttemptManager(() => `key-${++sequence}`); const payload = { cardId: "card-a" }; const first = manager.keyFor(payload); assert.equal(parseOnboardingSuccessResponse({}, "card-a"), null); manager.markAmbiguous(payload, first); assert.equal(manager.keyFor(payload), first); assert.match(component, /if \(!outcome\) throw[\s\S]+attempt\.resolve\(\); setSuccess/u); });
test("payload diferente após ambiguidade revalida elegibilidade antes de qualquer POST", () => { assert.match(component, /prepared\.kind === "requires_revalidation"[\s\S]+onboardingRequest\(`\/api\/finance\/card-onboarding\?cardId=/u); assert.match(component, /repita os mesmos dados enviados anteriormente/iu); });

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

test("read model converte físico 1/6 em 5/10", () => assert.deepEqual(resolveInstallmentDisplay({ physicalNumber: 1, physicalCount: 6, origin: "system", metadataValid: true, firstOriginalNumber: 5, originalCount: 10 }), { installmentNumber: 5, installmentCount: 10 }));
test("read model converte próxima fatura física 2/6 em 6/10", () => assert.deepEqual(resolveInstallmentDisplay({ physicalNumber: 2, physicalCount: 6, origin: "system", metadataValid: true, firstOriginalNumber: 5, originalCount: 10 }), { installmentNumber: 6, installmentCount: 10 }));
test("read model converte última física 6/6 em 10/10", () => assert.deepEqual(resolveInstallmentDisplay({ physicalNumber: 6, physicalCount: 6, origin: "system", metadataValid: true, firstOriginalNumber: 5, originalCount: 10 }), { installmentNumber: 10, installmentCount: 10 }));
test("compra normal sem metadata preserva numeração", () => assert.deepEqual(resolveInstallmentDisplay({ physicalNumber: 2, physicalCount: 3, origin: "web" }), { installmentNumber: 2, installmentCount: 3 }));
test("compra normal do Telegram sem metadata preserva numeração", () => assert.deepEqual(resolveInstallmentDisplay({ physicalNumber: 3, physicalCount: 3, origin: "telegram" }), { installmentNumber: 3, installmentCount: 3 }));
test("compra importada sem metadata falha fechada", () => assert.equal(resolveInstallmentDisplay({ physicalNumber: 1, physicalCount: 6, origin: "system" }), null));
test("metadata de outra purchase ou cartão falha fechada", () => assert.equal(resolveInstallmentDisplay({ physicalNumber: 1, physicalCount: 6, origin: "system", metadataValid: false, firstOriginalNumber: 5, originalCount: 10 }), null));
test("metadata inconsistente falha fechada", () => assert.equal(resolveInstallmentDisplay({ physicalNumber: 1, physicalCount: 5, origin: "system", metadataValid: true, firstOriginalNumber: 5, originalCount: 10 }), null));
test("metadata que excede total original falha fechada", () => assert.equal(resolveInstallmentDisplay({ physicalNumber: 6, physicalCount: 6, origin: "system", metadataValid: true, firstOriginalNumber: 6, originalCount: 10 }), null));
test("Ver fatura usa metadata sem alterar ledger", () => { assert.match(detailService, /LEFT JOIN card_purchase_import_metadata/u); assert.match(detailService, /resolveInstallmentDisplay/u); });
test("lista geral de parcelas também usa numeração original", () => { assert.match(advancedRoute, /cardPurchaseImportMetadata/u); assert.match(advancedRoute, /inconsistentInstallmentDisplay/u); });
test("dashboard e relatórios também usam numeração original", () => { assert.match(analytics, /card_purchase_import_metadata/u); assert.match(analytics, /first_original_installment_number \+ ci\.installment_number - 1/u); });
test("opening balance continua visível separadamente", () => assert.match(readFileSync(new URL("../app/invoice-detail-dialog.tsx", import.meta.url), "utf8"), /Saldo anterior à implantação/u));
test("paginação do detalhe permanece delegada ao contrato existente", () => { assert.match(detailService, /activePage/u); assert.match(detailService, /cancelledPage/u); assert.match(detailService, /pageSize/u); });

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTelegramMessage } from "../lib/telegram-parser.mjs";
import { buildTelegramInstallmentPreview, isLegacyTelegramCardPersistence, parseTelegramInstallmentCount, resolveTelegramDueDate, telegramFinancialPersistenceTarget, transitionTelegramPaymentFlow } from "../lib/telegram-payment-flow.mjs";

const now = new Date("2026-09-14T12:00:00.000Z");
const context = {
  accounts: [{ id: "bank", name: "Conta Principal", type: "bank" }],
  cards: [{ id: "nubank-card", name: "Nubank" }],
  categories: [{ id: "clothes", name: "Vestuário", type: "expense" }],
  subcategories: [{ id: "shirts", categoryId: "clothes", name: "Camisetas" }],
};

test("parser reconhece os quatro paymentFlow e preserva paymentMethod somente no imediato", () => {
  for (const phrase of ["Gastei 80 no pix", "Paguei 80 no débito", "Paguei 80 em dinheiro", "Paguei 80 na hora"]) {
    assert.equal(parseTelegramMessage(phrase, context, { now }).paymentFlow, "immediate", phrase);
  }
  assert.equal(parseTelegramMessage("Gastei 80 no pix", context, { now }).paymentMethod, "pix");
  assert.equal(parseTelegramMessage("Comprei uma camiseta de 120 e vou pagar depois", context, { now }).paymentFlow, "future_bill");
  const futureWithDate = parseTelegramMessage("Comprei uma camiseta de 120 hoje e vou pagar dia 10 do mês que vem", context, { now });
  assert.equal(futureWithDate.paymentFlow, "future_bill");
  assert.equal(futureWithDate.dueDate, "2026-10-10");
  const card = parseTelegramMessage("Comprei 300 no cartão Nubank em 3x", context, { now });
  assert.equal(card.paymentFlow, "credit_card");
  assert.equal(card.legacyCardCompatible, true);
  assert.equal(card.cardId, "nubank-card");
  assert.equal(card.installmentCount, 3);
  assert.equal(card.paymentMethod, null);
  const direct = parseTelegramMessage("Comprei 300 em 3 parcelas direto na loja, primeiro vencimento dia 20", context, { now });
  assert.equal(direct.paymentFlow, "direct_installments");
  assert.equal(direct.installmentCount, 3);
  assert.equal(direct.firstDueDate, "2026-09-20");
  assert.equal(direct.cardId, null);
  assert.equal(parseTelegramMessage("Comprei um celular em 3 parcelas direto na loja", context, { now }).amountCents, null);
});

test("despesa sem forma solicita escolha e conta/cartão homônimos permanecem ambíguos", () => {
  const missing = parseTelegramMessage("Comprei uma camiseta de 120", context, { now });
  assert.equal(missing.paymentFlow, null);
  assert.equal(missing.ambiguity, "forma_pagamento");
  const ambiguousContext = { ...context, accounts: [{ id: "nubank-account", name: "Nubank", type: "bank" }] };
  const ambiguous = parseTelegramMessage("Comprei 120 no Nubank", ambiguousContext, { now });
  assert.equal(ambiguous.paymentFlow, null);
  assert.equal(ambiguous.accountId, null);
  assert.equal(ambiguous.cardId, null);
  assert.equal(ambiguous.ambiguity, "forma_pagamento");
});

test("parcelamento ou menção explícita ao cartão desambigua conta e cartão homônimos", () => {
  const homonymous = {
    ...context,
    accounts: [{ id: "nubank-account", name: "Nubank", type: "bank" }],
  };
  for (const phrase of [
    "Comprei 50 no Nubank em 2x",
    "Comprei 50 no cartão Nubank",
    "Comprei 50 no crédito no Nubank",
  ]) {
    const parsed = parseTelegramMessage(phrase, homonymous, { now });
    assert.equal(parsed.paymentFlow, "credit_card", phrase);
    assert.equal(parsed.cardId, "nubank-card", phrase);
    assert.equal(parsed.accountId, null, phrase);
  }
  const installments = parseTelegramMessage("Comprei 50 no Nubank em 2x", homonymous, { now });
  assert.equal(installments.installmentCount, 2);
  assert.equal(installments.legacyCardCompatible, true);

  const ambiguous = parseTelegramMessage("Comprei 50 no Nubank", homonymous, { now });
  assert.equal(ambiguous.paymentFlow, null);
  assert.equal(ambiguous.cardId, null);
  assert.equal(ambiguous.accountId, null);

  const accountOnly = parseTelegramMessage("Gastei 50 no Nubank", { ...context, accounts: homonymous.accounts, cards: [] }, { now });
  assert.equal(accountOnly.paymentFlow, "immediate");
  assert.equal(accountOnly.accountId, "nubank-account");
  assert.equal(accountOnly.cardId, null);

  const cardOnly = parseTelegramMessage("Comprei 50 no Nubank em 2x", { ...context, accounts: [] }, { now });
  assert.equal(cardOnly.paymentFlow, "credit_card");
  assert.equal(cardOnly.cardId, "nubank-card");
  assert.equal(cardOnly.installmentCount, 2);
  assert.equal(cardOnly.legacyCardCompatible, true);
});

test("troca de paymentFlow limpa somente campos incompatíveis", () => {
  const full = { paymentFlow: "credit_card", paymentMethod: "pix", accountId: "account", cardId: "card", dueDate: "2026-10-10", installmentCount: 3, firstDueDate: "2026-10-20", installmentDayOfMonth: 20, categoryId: "category", subcategoryId: "subcategory" };
  assert.deepEqual(transitionTelegramPaymentFlow(full, "immediate"), { ...full, paymentFlow: "immediate", legacyCardCompatible: false, cardId: null, dueDate: null, installmentCount: null, firstDueDate: null, installmentDayOfMonth: null });
  assert.deepEqual(transitionTelegramPaymentFlow(full, "future_bill"), { ...full, paymentFlow: "future_bill", legacyCardCompatible: false, cardId: null, accountId: null, paymentMethod: null, installmentCount: null, firstDueDate: null, installmentDayOfMonth: null });
  assert.deepEqual(transitionTelegramPaymentFlow(full, "credit_card"), { ...full, paymentFlow: "credit_card", accountId: null, paymentMethod: null, dueDate: null, firstDueDate: null, installmentDayOfMonth: null });
  assert.deepEqual(transitionTelegramPaymentFlow(full, "direct_installments"), { ...full, paymentFlow: "direct_installments", legacyCardCompatible: false, accountId: null, paymentMethod: null, cardId: null, dueDate: null });
});

test("datas futuras são determinísticas em virada de ano e ano bissexto", () => {
  assert.deepEqual(resolveTelegramDueDate("ficou para dia 20", "2026-09-14"), { status: "resolved", date: "2026-09-20", desiredDay: 20 });
  assert.deepEqual(resolveTelegramDueDate("vence dia 20", "2026-09-20"), { status: "resolved", date: "2026-10-20", desiredDay: 20 });
  assert.equal(resolveTelegramDueDate("vou pagar dia 15/10", "2026-10-15").date, "2026-10-15");
  assert.equal(resolveTelegramDueDate("vou pagar dia 15/10", "2026-10-16").date, "2027-10-15");
  assert.equal(resolveTelegramDueDate("vence dia 10", "2026-12-20").date, "2027-01-10");
  assert.equal(resolveTelegramDueDate("vou pagar dia 29/02", "2027-03-01").date, "2028-02-29");
  assert.equal(resolveTelegramDueDate("pago mês que vem", "2026-09-14").status, "incomplete");
  assert.equal(resolveTelegramDueDate("vou pagar 2026-02-30", "2026-01-01").status, "invalid");
});

test("parser reconhece pago dia N como vencimento futuro sem inventar descrição", () => {
  const parsed = parseTelegramMessage("Comprei uma camiseta de 50 e pago dia 20", context, { now });
  assert.equal(parsed.paymentFlow, "future_bill");
  assert.equal(parsed.dueDate, "2026-09-20");
  assert.equal(parsed.description, "Camiseta");
});

test("parcelas reconhecem formatos, preservam centavos e o dia desejado", () => {
  assert.equal(parseTelegramInstallmentCount("em 2x"), 2);
  assert.equal(parseTelegramInstallmentCount("3 parcelas"), 3);
  assert.equal(parseTelegramInstallmentCount("5"), 5);
  assert.equal(parseTelegramInstallmentCount("0x"), null);
  assert.equal(parseTelegramInstallmentCount("-2x"), null);
  assert.equal(parseTelegramInstallmentCount("parcelado: -3 parcelas"), null);
  assert.equal(parseTelegramInstallmentCount("121x"), null);
  const preview = buildTelegramInstallmentPreview({ totalCents: 10_000, count: 3, firstDueDate: "2027-01-31", desiredDay: 31 });
  assert.equal(preview.reduce((sum, item) => sum + item.amountCents, 0), 10_000);
  assert.deepEqual(preview.map((item) => item.amountCents), [3_333, 3_333, 3_334]);
  assert.deepEqual(preview.map((item) => item.dueDate), ["2027-01-31", "2027-02-28", "2027-03-31"]);
  const leap = buildTelegramInstallmentPreview({ totalCents: 300, count: 3, firstDueDate: "2028-01-31", desiredDay: 31 });
  assert.deepEqual(leap.map((item) => item.dueDate), ["2028-01-31", "2028-02-29", "2028-03-31"]);
  assert.throws(() => buildTelegramInstallmentPreview({ totalCents: 2, count: 3, firstDueDate: "2027-01-31", desiredDay: 31 }), /Parcelamento inválido/);
  assert.throws(() => buildTelegramInstallmentPreview({ totalCents: 1, count: 120, firstDueDate: "2027-01-31", desiredDay: 31 }), /Parcelamento inválido/);
});

test("cartão legado é marcado somente quando cartão e parcelas já estão explícitos", () => {
  const supported = parseTelegramMessage("Comprei 300 no cartão Nubank em 2x", context, { now });
  assert.equal(supported.legacyCardCompatible, true);
  assert.equal(isLegacyTelegramCardPersistence(supported), true);
  assert.equal(telegramFinancialPersistenceTarget(supported), "card_purchase");
  assert.equal(parseTelegramMessage("Comprei 300 no cartão Nubank", context, { now }).legacyCardCompatible, false);
  assert.equal(parseTelegramMessage("Passei 300 no crédito em 2x", context, { now }).legacyCardCompatible, false);
  assert.equal(isLegacyTelegramCardPersistence(parseTelegramMessage("Passei 300 no crédito em 2x", context, { now })), false);
  assert.equal(telegramFinancialPersistenceTarget({ paymentFlow: "immediate", accountId: "bank" }), "transaction");
  assert.equal(telegramFinancialPersistenceTarget({ paymentFlow: "future_bill" }), null);
  assert.equal(telegramFinancialPersistenceTarget({ paymentFlow: "direct_installments" }), null);
  assert.equal(telegramFinancialPersistenceTarget({ paymentFlow: "credit_card", cardId: "nubank-card" }), null);
  assert.equal(transitionTelegramPaymentFlow({ paymentFlow: "credit_card", legacyCardCompatible: true, cardId: "nubank-card" }, "future_bill").legacyCardCompatible, false);
});

test("confirmação de fluxos futuros não possui fallback para transaction ou persistência prematura", () => {
  const handler = readFileSync(new URL("../lib/telegram-handler.ts", import.meta.url), "utf8");
  assert.match(handler, /if \(paymentFlow !== "immediate"\)[\s\S]+Nenhum lançamento foi criado/);
  assert.match(handler, /persistenceTarget === "card_purchase" && intent\.cardId/);
  assert.doesNotMatch(handler, /createBill\(/);
  assert.doesNotMatch(handler, /createRecurring/);
  assert.match(handler, /if \(persistenceTarget === "transaction"\)[\s\S]+await createTransaction/);
  assert.match(handler, /if \(paymentFlow !== "immediate"\)[\s\S]+Nenhum lançamento foi criado/);
});

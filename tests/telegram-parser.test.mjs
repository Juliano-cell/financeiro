import test from "node:test";
import assert from "node:assert/strict";
import { dateInSaoPaulo, mergeFinancialIntent, parseTelegramMessage } from "../lib/telegram-parser.mjs";

const now = new Date("2026-09-11T15:00:00.000Z");
const context = {
  accounts: [{ id: "wallet", name: "Carteira", type: "cash" }, { id: "bank", name: "Conta Principal", type: "bank" }],
  cards: [{ id: "nubank", name: "Nubank" }],
  categories: [{ id: "food", name: "Alimentação", type: "expense" }, { id: "transport", name: "Transporte", type: "expense" }, { id: "home", name: "Moradia", type: "expense" }, { id: "other", name: "Outros", type: "both" }, { id: "income", name: "Renda", type: "income" }],
  subcategories: [{ id: "market", householdId: "h1", categoryId: "food", name: "Mercado" }, { id: "fuel", householdId: "h1", categoryId: "transport", name: "Combustível" }, { id: "internet", householdId: "h1", categoryId: "home", name: "Internet" }, { id: "health", householdId: "h1", categoryId: "other", name: "Saúde" }, { id: "daily", householdId: "h1", categoryId: "income", name: "Diárias" }, { id: "services", householdId: "h1", categoryId: "income", name: "Serviços" }],
};

for (const [text, cents, description] of [
  ["Comprei teste C2 por 1,12 no cartão", 112, "Teste C2"],
  ["Comprei teste por 1,12 no cartão", 112, "Teste"],
  ["Comprei teste C3 por 1,12 no cartão", 112, "Teste C3"],
  ["Comprei teste C10 por 1,12 no cartão", 112, "Teste C10"],
  ["Comprei teste C2 por R$ 1,12 no cartão", 112, "Teste C2"],
  ["Comprei teste C2 por 1,12 reais no cartão", 112, "Teste C2"],
  ["Comprei teste C2 por 2,50 no cartão", 250, "Teste C2"],
  ["Comprei teste C2 por 10,50 no cartão", 1050, "Teste C2"],
  ["Comprei teste C2 por 112,00 no cartão", 11200, "Teste C2"],
  ["Comprei capa iPhone 15 por 50,00 no cartão", 5000, "Capa iPhone 15"],
  ["Comprei cabo USB 2.0 por 25,90 no cartão", 2590, "Cabo USB 2.0"],
  ["Comprei camiseta tamanho 42 por 79,90 no cartão", 7990, "Camiseta tamanho 42"],
  ["Comprei 2 camisetas por 30,00 no cartão", 3000, "2 camisetas"],
  ["Comprei teste C2 R$ 1,12 no cartão", 112, "Teste C2"],
  ["Comprei teste C2 1,12 reais no cartão", 112, "Teste C2"],
  ["Comprei iPhone 15 por 1200 no cartão", 120000, "iPhone 15"],
  ["Comprei teste C2 por R$ 1.250,90 no cartão", 125090, "Teste C2"],
]) {
  test(`preço contextual não remove números da descrição: ${text}`, () => {
    const parsed = parseTelegramMessage(text, context, { now });
    assert.equal(parsed.amountCents, cents);
    assert.equal(parsed.description, description);
    assert.equal(parsed.paymentFlow, "credit_card");
  });
}

test("identificadores e múltiplos preços ambíguos não inventam valor", () => {
  for (const text of [
    "Comprei C2 no cartão", "Comprei C10 no cartão", "Comprei A15 no cartão", "Comprei S23 no cartão",
    "Comprei iPhone 15 tamanho 42 no cartão", "Comprei 2 camisetas 30 no cartão",
    "Comprei teste por R$ 10 ou R$ 20 no cartão",
  ]) {
    const parsed = parseTelegramMessage(text, context, { now });
    assert.equal(parsed.amountCents, null, text);
    assert.ok(parsed.missing.includes("valor"), text);
  }
  assert.equal(parseTelegramMessage("Comprei teste C2 50 no cartão", context, { now }).amountCents, 5000);
  assert.equal(parseTelegramMessage("Gastei 85, no mercado", context, { now }).amountCents, 8500);
  assert.equal(parseTelegramMessage("Gastei 85. no mercado", context, { now }).amountCents, 8500);
});

test("parser reconhece despesas, entradas e valores brasileiros", () => {
  const expense = parseTelegramMessage("gastei 85 no mercado", context, { now });
  assert.equal(expense.type, "expense"); assert.equal(expense.amountCents, 8_500); assert.equal(expense.description, "Mercado"); assert.equal(expense.subcategoryId, "market");
  const income = parseTelegramMessage("entrou 200 da diária da Alessandra", context, { now });
  assert.equal(income.type, "income"); assert.equal(income.amountCents, 20_000); assert.equal(income.subcategoryId, "daily");
  assert.equal(parseTelegramMessage("paguei R$85,50 de internet", context, { now }).amountCents, 8_550);
  assert.equal(parseTelegramMessage("comprei R$ 1.250,90 no mercado", context, { now }).amountCents, 125_090);
});

test("datas relativas usam o calendário de São Paulo", () => {
  assert.equal(dateInSaoPaulo(now), "2026-09-11");
  assert.equal(parseTelegramMessage("recebi 200 do cliente hoje", context, { now }).purchaseDate, "2026-09-11");
  assert.equal(parseTelegramMessage("gastei 10 no mercado ontem", context, { now }).purchaseDate, "2026-09-10");
  assert.equal(parseTelegramMessage("paguei 20 de gasolina anteontem", context, { now }).purchaseDate, "2026-09-09");
});

test("categorias, subcategorias, contas e cartões vêm somente do contexto", () => {
  const fuel = parseTelegramMessage("paguei 120 de gasolina", context, { now });
  assert.equal(fuel.categoryId, "transport"); assert.equal(fuel.subcategoryId, "fuel");
  const card = parseTelegramMessage("gastei 100 de gasolina no Nubank em 2x", context, { now });
  assert.equal(card.cardId, "nubank"); assert.equal(card.paymentFlow, "credit_card"); assert.equal(card.paymentMethod, null); assert.equal(card.installmentCount, 2);
  const cash = parseTelegramMessage("gastei 50 em dinheiro", context, { now });
  assert.equal(cash.paymentMethod, "cash"); assert.equal(cash.accountId, null);
  assert.equal(parseTelegramMessage("gastei 50 no Banco Inventado", context, { now }).accountId, null);
});

test("mensagem incompleta e continuação não inventam campos", () => {
  const incomplete = parseTelegramMessage("gastei 100", context, { now });
  assert.deepEqual(incomplete.missing, ["descrição"]);
  const continuation = parseTelegramMessage("mercado", context, { now });
  const merged = mergeFinancialIntent(incomplete, continuation);
  assert.equal(merged.type, "expense"); assert.equal(merged.amountCents, 10_000); assert.equal(merged.description, "Mercado"); assert.deepEqual(merged.missing, []);
  const invalid = parseTelegramMessage("olá, tudo bem?", context, { now });
  assert.equal(invalid.intent, "unknown"); assert.ok(invalid.missing.includes("valor"));
  assert.ok(parseTelegramMessage("comprei um celular em 10x", context, { now }).missing.includes("valor"));
});

test("comandos de vínculo, ajuda, confirmação, alteração e cancelamento são distintos", () => {
  assert.deepEqual(parseTelegramMessage("/start 012345"), { intent: "connect", code: "012345" });
  assert.deepEqual(parseTelegramMessage("/conectar 654321"), { intent: "connect", code: "654321" });
  assert.equal(parseTelegramMessage("/start").intent, "start");
  assert.equal(parseTelegramMessage("/ajuda").intent, "help");
  assert.equal(parseTelegramMessage("Confirmar").intent, "confirm");
  assert.equal(parseTelegramMessage("Alterar").intent, "alter");
  assert.equal(parseTelegramMessage("Cancelar").intent, "cancel");
});

test("mensagens acima do limite são rejeitadas", () => {
  const parsed = parseTelegramMessage("x".repeat(1_001), context, { now });
  assert.equal(parsed.intent, "unknown"); assert.equal(parsed.error, "message_too_long");
});

test("parser exige contexto futuro de despesa e preserva mês-alvo incompleto", () => {
  const tomorrow = parseTelegramMessage("Gastei 80 mas ficou para pagar amanhã", context, { now });
  assert.equal(tomorrow.paymentFlow, "future_bill");
  assert.equal(tomorrow.dueDate, "2026-09-12");

  const nextMonth = parseTelegramMessage("Comprei 300 e ficou para mês que vem", context, { now });
  assert.equal(nextMonth.paymentFlow, "future_bill");
  assert.equal(nextMonth.dueDate, null);
  assert.equal(nextMonth.dueMonth, "2026-10");

  const namedMonth = parseTelegramMessage("Comprei 100 e ficou para outubro", context, { now });
  assert.equal(namedMonth.paymentFlow, "future_bill");
  assert.equal(namedMonth.dueMonth, "2026-10");

  assert.notEqual(parseTelegramMessage("Recebi 50 dia 20", context, { now }).paymentFlow, "future_bill");
  assert.notEqual(parseTelegramMessage("Ganhei 100 ontem", context, { now }).paymentFlow, "future_bill");
});

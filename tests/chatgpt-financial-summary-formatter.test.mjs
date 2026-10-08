import test from "node:test";
import assert from "node:assert/strict";
import { formatChatGptFinancialSummary } from "../lib/chatgpt-financial-summary-formatter.mjs";

function fixture(overrides = {}) {
  return {
    period: { month: "2028-02", generatedAt: "2026-10-08T12:00:00.000Z", asOfDate: "2026-10-08", timezone: "America/Sao_Paulo", isFutureMonth: true },
    balances: { basis: "current_as_of_date", totalAvailableCents: 150_050, accounts: [
      { name: "Carteira", type: "cash", currentBalanceCents: 5_050 },
      { name: "Banco", type: "bank", currentBalanceCents: 145_000 },
    ] },
    realized: { basis: "realized_by_competence", incomeCents: 220_000, expenseCents: 80_000, resultCents: 140_000, items: [
      { date: "2028-02-29", competenceMonth: "2028-02", type: "expense", amountCents: 80_000, description: "Mercado", categoryName: "Casa", subcategoryName: "Mercado", accountName: "Banco", paymentMethod: "cash", installment: null },
      { date: "2028-02-01", competenceMonth: "2028-02", type: "income", amountCents: 220_000, description: "Recebimento", categoryName: "Sem categoria", subcategoryName: "Sem subcategoria", accountName: "Banco", paymentMethod: null, installment: null },
    ] },
    expectedIncome: { basis: "planned", pendingCents: 302_000, overdueCents: 0, receivedCents: 220_000, items: [
      { description: "Recorrência", expectedAmountCents: 302_000, expectedDate: "2028-02-29", status: "pending", timing: "pending", plannedAccountName: null, categoryName: null, subcategoryName: null, receivedAmountCents: null, receivedDate: null, actualAccountName: null, recurrence: { type: "monthly", configuredDay: 31 } },
      { description: "Recebida", expectedAmountCents: 200_000, expectedDate: "2028-02-01", status: "received", timing: "received", plannedAccountName: "Banco", categoryName: null, subcategoryName: null, receivedAmountCents: 220_000, receivedDate: "2028-02-02", actualAccountName: "Banco", recurrence: null },
    ] },
    bills: { basis: "planned_due_date", pendingCents: 100_000, overdueCents: 50_000, paidScheduledCents: 90_000, paidActualCents: 85_000, items: [
      { description: "Parcela", scheduledAmountCents: 100_000, dueDate: "2028-02-29", status: "pending", categoryName: "Casa", subcategoryName: null, plannedAccountName: null, actualPaidAmountCents: null, paidDate: null, paymentAdjustment: null, recurrence: null, installment: { number: 2, count: 3, originalTotalCents: 300_000 } },
      { description: "Conta paga", scheduledAmountCents: 90_000, dueDate: "2028-02-10", status: "paid", categoryName: "Casa", subcategoryName: null, plannedAccountName: "Banco", actualPaidAmountCents: 85_000, paidDate: "2028-02-09", paymentAdjustment: { type: "discount", amountCents: -5_000 }, recurrence: null, installment: null },
    ] },
    cards: [{ name: "Cartão", institution: "Banco", isActive: true, limitCents: 500_000, closingDay: 31, dueDay: 10, invoices: [{
      referenceMonth: "2028-02", dueDate: "2028-02-10", closesOn: "2028-01-31",
      invoiceTotalCents: 120_000, paidCents: 20_000, remainingCents: 100_000,
      cycleStatus: "closed", paymentStatus: "partial", openingBalance: null,
      purchases: [{ purchaseDate: "2028-01-05", description: "Compra", installmentAmountCents: 120_000, installmentNumber: 1, installmentCount: 1, purchaseTotalCents: 120_000, categoryName: "Casa", subcategoryName: null }],
    }] }],
    commitments: [{ source: "bill", direction: "outflow", description: "Parcela", amountCents: 100_000, originalDate: "2028-02-29", allocationMonth: "2028-02", status: "pending", overdue: false, installment: { number: 2, count: 3 } }],
    projection: { basis: "known_cash_only", month: "2028-02", openingBalanceCents: 150_050, knownFutureIncomeCents: 0, expectedIncomeCents: 302_000, overdueExpectedIncomeCents: 0, futureTransactionExpenseCents: 0, overdueBillsCents: 0, dueBillsCents: 100_000, cardInvoiceRemainingCents: 100_000, knownOutflowCents: 200_000, projectedNetCashFlowCents: 102_000, closingBalanceCents: 252_050 },
    warnings: [{ code: "UNREGISTERED_INCOME_NOT_INCLUDED", message: "Receitas futuras não cadastradas não fazem parte desta projeção." }],
    ...overrides,
  };
}

test("formatter gera as nove seções em pt-BR e distingue saldo atual de projeção futura", () => {
  const output = formatChatGptFinancialSummary(fixture());
  for (const section of [
    "1. Identificação do período", "2. Saldos atuais", "3. Realizado da competência",
    "4. Receitas previstas", "5. Contas e vencimentos", "6. Cartões e faturas",
    "7. Compromissos cadastrados para a projeção", "8. Projeção", "9. Avisos e limitações",
  ]) assert.ok(output.includes(section));
  assert.match(output, /fevereiro de 2028/u);
  assert.match(output, /29\/02\/2028/u);
  assert.match(output, /saldos reais de hoje/u);
  assert.match(output, /R\$\s*3\.020,00/u);
  assert.match(output, /parcela 2\/3/u);
});

test("formatter localiza todos os status e o ciclo da fatura sem alterar os enums", () => {
  const base = fixture();
  const pendingBill = base.bills.items[0];
  const paidBill = base.bills.items[1];
  const invoice = base.cards[0].invoices[0];
  const commitment = base.commitments[0];
  const dto = fixture({
    bills: { ...base.bills, items: [
      pendingBill,
      { ...pendingBill, description: "Conta atrasada", dueDate: "2026-09-10", status: "overdue" },
      paidBill,
    ] },
    cards: [{ ...base.cards[0], invoices: [
      { ...invoice, referenceMonth: "2028-01", cycleStatus: "open", paymentStatus: "unpaid" },
      invoice,
      { ...invoice, referenceMonth: "2028-03", cycleStatus: "unknown", paymentStatus: "settled" },
    ] }],
    commitments: [
      { ...commitment, description: "Confirmada", status: "confirmed" },
      commitment,
      { ...commitment, description: "Não paga", status: "unpaid" },
      { ...commitment, description: "Parcial", status: "partial" },
    ],
  });
  const before = structuredClone(dto);
  const output = formatChatGptFinancialSummary(dto);
  for (const label of ["pendente", "paga", "atrasada", "não paga", "parcialmente paga", "quitada", "confirmada", "ciclo aberto", "ciclo fechado", "ciclo desconhecido"]) {
    assert.match(output, new RegExp(label, "u"));
  }
  assert.doesNotMatch(output, /\b(?:pending|paid|overdue|unpaid|partial|settled|confirmed)\b/u);
  assert.deepEqual(dto, before);
});

test("formatter apresenta generatedAt em pt-BR e America/Sao_Paulo sem alterar o instante", () => {
  const dto = fixture();
  const before = dto.period.generatedAt;
  const output = formatChatGptFinancialSummary(dto);
  assert.match(output, /Gerado em: 08\/10\/2026 às 09:00 — America\/Sao_Paulo/u);
  assert.equal(dto.period.generatedAt, before);
  assert.doesNotMatch(output, /2026-10-08T12:00:00\.000Z/u);
});

test("formatter explica competência versus caixa e detalha somente campos canônicos da projeção", () => {
  const base = fixture();
  const dto = fixture({
    projection: {
      ...base.projection,
      knownFutureIncomeCents: 1_111,
      expectedIncomeCents: 2_222,
      overdueExpectedIncomeCents: 3_333,
      futureTransactionExpenseCents: 4_444,
      overdueBillsCents: 5_555,
      dueBillsCents: 6_666,
      cardInvoiceRemainingCents: 7_777,
      knownOutflowCents: 24_442,
      projectedNetCashFlowCents: -17_776,
      closingBalanceCents: 132_274,
    },
  });
  const output = formatChatGptFinancialSummary(dto);
  assert.match(output, /realizado por competência não equivale necessariamente a dinheiro já pago/u);
  assert.match(output, /não devem ser somados como despesas distintas/u);
  assert.match(output, /Entradas futuras confirmadas: R\$\s*11,11/u);
  assert.match(output, /Receitas previstas pendentes: R\$\s*22,22/u);
  assert.match(output, /Receitas previstas atrasadas alocadas: R\$\s*33,33/u);
  assert.match(output, /Saídas futuras de transações confirmadas: R\$\s*44,44/u);
  assert.match(output, /Contas atrasadas alocadas: R\$\s*55,55/u);
  assert.match(output, /Contas pendentes no mês: R\$\s*66,66/u);
  assert.match(output, /Faturas restantes: R\$\s*77,77/u);
  assert.match(output, /Total de saídas futuras cadastradas: R\$\s*244,42/u);
  assert.match(output, /Fluxo líquido projetado: -R\$\s*177,76/u);
  assert.match(output, /Saldo projetado final: R\$\s*1\.322,74/u);
});

test("formatter identifica atrasados e preserva a competência original", () => {
  const base = fixture();
  const output = formatChatGptFinancialSummary(fixture({ commitments: [{
    ...base.commitments[0],
    description: "Conta antiga",
    originalDate: "2026-09-13",
    allocationMonth: "2026-10",
    overdue: true,
  }] }));
  assert.match(output, /compromissos vencidos anteriormente são considerados no primeiro mês da projeção de caixa, sem alterar sua competência original/u);
  assert.match(output, /13\/09\/2026 · Saída · Conta antiga.*vencido anteriormente; alocado no primeiro mês apenas para a projeção de caixa/u);
});

test("formatter distingue configuração atual da série do vencimento excepcional", () => {
  const base = fixture();
  const exceptional = {
    ...base.bills.items[0],
    description: "teste recorrente",
    dueDate: "2026-10-13",
    recurrence: { type: "monthly", configuredDay: 20 },
  };
  const output = formatChatGptFinancialSummary(fixture({ bills: { ...base.bills, items: [exceptional] } }));
  assert.match(output, /recorrente mensal — configuração atual: dia 20 — vencimento desta ocorrência: 13\/10\/2026/u);
});

test("formatter normaliza controles em textos livres e preserva UUID legítimo", () => {
  const base = fixture();
  const uuid = "00e2924f-317f-4e5f-b755-7e20c8dead41";
  const description = `Regressão\r\nlocal\tcom\u0007controle ${uuid}`;
  const output = formatChatGptFinancialSummary(fixture({
    realized: { ...base.realized, items: [{ ...base.realized.items[0], description }] },
  }));
  assert.match(output, new RegExp(`Regressão local com controle ${uuid}`, "u"));
  assert.doesNotMatch(output, /Regressão\r|Regressão\n|local\t|\u0007/u);
});

test("formatter exibe contexto opcional disponível e omite ausentes sem placeholders técnicos", () => {
  const base = fixture();
  const expectedWithContext = {
    ...base.expectedIncome.items[0],
    categoryName: "Receitas",
    subcategoryName: "Serviços",
    plannedAccountName: "Banco",
  };
  const output = formatChatGptFinancialSummary(fixture({
    expectedIncome: { ...base.expectedIncome, items: [expectedWithContext] },
  }));
  assert.match(output, /categoria: Receitas/u);
  assert.match(output, /subcategoria: Serviços/u);
  assert.match(output, /conta planejada: Banco/u);
  assert.match(output, /ciclo fechado · parcialmente paga/u);
  assert.doesNotMatch(output, /\b(?:null|undefined)\b/u);
});

test("formatter é determinístico, ordena cópias e não muta o DTO", () => {
  const dto = fixture();
  const before = structuredClone(dto);
  const first = formatChatGptFinancialSummary(dto);
  const second = formatChatGptFinancialSummary(dto);
  assert.equal(first, second);
  assert.deepEqual(dto, before);
  assert.ok(first.indexOf("- Banco:") < first.indexOf("- Carteira:"));
  assert.ok(first.indexOf("Recebimento") < first.indexOf("Mercado"));
});

test("formatter não inclui campos sensíveis, IDs internos, notas ou payloads brutos", () => {
  const dto = fixture();
  dto.internalId = "invoice-secret";
  dto.email = "pessoa@example.com";
  dto.notes = "nota privada";
  dto.auditLog = "audit-secret";
  dto.token = "token-secret";
  dto.cookie = "cookie-secret";
  const output = formatChatGptFinancialSummary(dto);
  assert.doesNotMatch(output, /invoice-secret|pessoa@example\.com|nota privada|audit-secret|token-secret|cookie-secret/u);
  assert.doesNotMatch(output, /household|userId|idempotency|payload/iu);
});

test("formatter não trunca listas e representa estados vazios explicitamente", () => {
  const items = Array.from({ length: 150 }, (_, index) => ({
    date: "2028-02-01", competenceMonth: "2028-02", type: "expense", amountCents: 1,
    description: `Item ${String(index).padStart(3, "0")}`, categoryName: "Casa",
    subcategoryName: "Sem subcategoria", accountName: "Banco", paymentMethod: null, installment: null,
  }));
  const base = fixture();
  const dto = fixture({ realized: { ...base.realized, items }, cards: [], commitments: [], warnings: [] });
  const output = formatChatGptFinancialSummary(dto);
  assert.match(output, /Item 149/u);
  assert.match(output, /Nenhum registro/u);
});

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
    "7. Compromissos futuros cadastrados", "8. Projeção", "9. Avisos e limitações",
  ]) assert.ok(output.includes(section));
  assert.match(output, /fevereiro de 2028/u);
  assert.match(output, /29\/02\/2028/u);
  assert.match(output, /saldos reais de hoje/u);
  assert.match(output, /R\$\s*3\.020,00/u);
  assert.match(output, /parcela 2\/3/u);
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

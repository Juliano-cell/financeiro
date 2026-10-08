const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const monthNames = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function formatMoney(cents) {
  if (!Number.isSafeInteger(cents)) throw new TypeError("Valor monetário inválido no resumo.");
  return money.format(cents / 100);
}

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError("Data civil inválida no resumo.");
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

function formatMonth(value) {
  if (!/^\d{4}-\d{2}$/u.test(value)) throw new TypeError("Competência inválida no resumo.");
  return `${monthNames[Number(value.slice(5, 7)) - 1]} de ${value.slice(0, 4)}`;
}

const compareText = (left, right) => left.localeCompare(right, "pt-BR", { sensitivity: "base" });
const dateValue = (item) => item.expectedDate ?? item.dueDate ?? item.originalDate ?? item.date ?? item.purchaseDate;
const byDateDescription = (left, right) => compareText(dateValue(left), dateValue(right)) || compareText(left.description, right.description);

function linesOrEmpty(items, render) {
  return items.length ? items.map(render) : ["- Nenhum registro."];
}

function installment(value) {
  return value ? ` · parcela ${value.number}/${value.count}` : "";
}

export function formatChatGptFinancialSummary(dto) {
  const accounts = [...dto.balances.accounts].sort((a, b) => compareText(a.name, b.name));
  const realized = [...dto.realized.items].sort(byDateDescription);
  const expected = [...dto.expectedIncome.items].sort(byDateDescription);
  const bills = [...dto.bills.items].sort(byDateDescription);
  const cards = [...dto.cards].sort((a, b) => compareText(a.name, b.name));
  const commitments = [...dto.commitments].sort(byDateDescription);
  const warnings = [...dto.warnings].sort((a, b) => compareText(a.code, b.code) || compareText(a.message, b.message));
  return [
    "RESUMO FINANCEIRO PARA PLANEJAMENTO",
    "",
    "1. Identificação do período e data de corte",
    `- Competência analisada: ${formatMonth(dto.period.month)} (${dto.period.month})`,
    `- Data de corte: ${formatDate(dto.period.asOfDate)} · America/Sao_Paulo`,
    `- Gerado em: ${dto.period.generatedAt}`,
    ...(dto.period.isFutureMonth ? ["- Atenção: os saldos abaixo são os saldos reais de hoje, não saldos do mês futuro selecionado."] : []),
    "",
    "2. Saldos atuais",
    `- Dinheiro disponível nas contas ativas em ${formatDate(dto.period.asOfDate)}: ${formatMoney(dto.balances.totalAvailableCents)}`,
    ...linesOrEmpty(accounts, (account) => `- ${account.name}: ${formatMoney(account.currentBalanceCents)}`),
    "",
    "3. Realizado da competência",
    `- Receitas realizadas: ${formatMoney(dto.realized.incomeCents)}`,
    `- Despesas realizadas: ${formatMoney(dto.realized.expenseCents)}`,
    `- Resultado realizado: ${formatMoney(dto.realized.resultCents)}`,
    ...linesOrEmpty(realized, (item) => `- ${formatDate(item.date)} · ${item.type === "income" ? "Entrada" : "Saída"} · ${item.description} · ${formatMoney(item.amountCents)} · ${item.categoryName}/${item.subcategoryName} · ${item.accountName}${installment(item.installment)}`),
    "",
    "4. Receitas previstas",
    `- Pendentes no mês: ${formatMoney(dto.expectedIncome.pendingCents)}`,
    `- Pendentes atrasadas: ${formatMoney(dto.expectedIncome.overdueCents)}`,
    `- Já recebidas entre as ocorrências da competência: ${formatMoney(dto.expectedIncome.receivedCents)}`,
    ...linesOrEmpty(expected, (item) => {
      const status = item.status === "received"
        ? `recebida em ${formatDate(item.receivedDate)} por ${formatMoney(item.receivedAmountCents)}`
        : item.timing === "overdue" ? "atrasada" : "pendente";
      return `- ${formatDate(item.expectedDate)} · ${item.description} · previsto ${formatMoney(item.expectedAmountCents)} · ${status}${item.recurrence ? ` · recorrente mensal (dia ${item.recurrence.configuredDay})` : ""}`;
    }),
    "",
    "5. Contas e vencimentos",
    `- Pendentes no mês: ${formatMoney(dto.bills.pendingCents)}`,
    `- Atrasadas: ${formatMoney(dto.bills.overdueCents)}`,
    `- Pagas (valor previsto): ${formatMoney(dto.bills.paidScheduledCents)}`,
    `- Pagas (valor efetivo): ${formatMoney(dto.bills.paidActualCents)}`,
    ...linesOrEmpty(bills, (bill) => {
      const paid = bill.status === "paid" ? ` · pago ${formatMoney(bill.actualPaidAmountCents)} em ${formatDate(bill.paidDate)}` : "";
      const recurrence = bill.recurrence ? ` · recorrente mensal (dia ${bill.recurrence.configuredDay})` : "";
      return `- ${formatDate(bill.dueDate)} · ${bill.description} · ${formatMoney(bill.scheduledAmountCents)} · ${bill.status}${paid}${recurrence}${installment(bill.installment)}`;
    }),
    "",
    "6. Cartões e faturas",
    ...linesOrEmpty(cards, (card) => {
      const header = `- ${card.name} (${card.institution}) · fechamento dia ${card.closingDay} · vencimento dia ${card.dueDay} · limite ${formatMoney(card.limitCents)}`;
      const invoices = card.invoices.length ? card.invoices.flatMap((invoice) => [
        `  - Fatura ${invoice.referenceMonth} · fecha ${invoice.closesOn ? formatDate(invoice.closesOn) : "data histórica indisponível"} · vence ${formatDate(invoice.dueDate)} · total ${formatMoney(invoice.invoiceTotalCents)} · pago ${formatMoney(invoice.paidCents)} · restante ${formatMoney(invoice.remainingCents)} · ${invoice.paymentStatus}`,
        ...(invoice.openingBalance ? [`    - Saldo inicial: ${formatMoney(invoice.openingBalance.openingCents)} · identificado ${formatMoney(invoice.openingBalance.identifiedCents)} · residual ${formatMoney(invoice.openingBalance.residualCents)}`] : []),
        ...linesOrEmpty(invoice.purchases, (purchase) => `    - ${formatDate(purchase.purchaseDate)} · ${purchase.description} · ${formatMoney(purchase.installmentAmountCents)} · parcela ${purchase.installmentNumber}/${purchase.installmentCount}`),
      ]) : ["  - Nenhuma fatura com compras na competência ou no horizonte futuro cadastrado."];
      return [header, ...invoices].join("\n");
    }),
    "",
    "7. Compromissos futuros cadastrados",
    ...linesOrEmpty(commitments, (item) => `- ${formatDate(item.originalDate)} · ${item.direction === "income" ? "Entrada" : "Saída"} · ${item.description} · ${formatMoney(item.amountCents)} · ${item.status}${item.overdue ? " · atrasado" : ""}${installment(item.installment)}`),
    "",
    "8. Projeção",
    "- Base: somente valores cadastrados; receitas não cadastradas não são presumidas.",
    `- Saldo projetado inicial: ${formatMoney(dto.projection.openingBalanceCents)}`,
    `- Entradas futuras confirmadas: ${formatMoney(dto.projection.knownFutureIncomeCents)}`,
    `- Receitas previstas pendentes: ${formatMoney(dto.projection.expectedIncomeCents)}`,
    `- Receitas previstas atrasadas alocadas: ${formatMoney(dto.projection.overdueExpectedIncomeCents)}`,
    `- Saídas futuras cadastradas: ${formatMoney(dto.projection.knownOutflowCents)}`,
    `- Fluxo líquido projetado: ${formatMoney(dto.projection.projectedNetCashFlowCents)}`,
    `- Saldo projetado final: ${formatMoney(dto.projection.closingBalanceCents)}`,
    "",
    "9. Avisos e limitações",
    ...linesOrEmpty(warnings, (warning) => `- ${warning.message}`),
  ].join("\n");
}

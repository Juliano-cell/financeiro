const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const monthNames = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const TIMEZONE = "America/Sao_Paulo";

const billStatusLabels = { pending: "pendente", paid: "paga", overdue: "atrasada" };
const invoicePaymentStatusLabels = { unpaid: "não paga", partial: "parcialmente paga", settled: "quitada" };
const invoiceCycleStatusLabels = { open: "ciclo aberto", closed: "ciclo fechado", unknown: "ciclo desconhecido" };
const commitmentStatusLabels = { confirmed: "confirmada", pending: "pendente", unpaid: "não paga", partial: "parcialmente paga" };

function formatMoney(cents) {
  if (!Number.isSafeInteger(cents)) throw new TypeError("Valor monetário inválido no resumo.");
  return money.format(cents / 100);
}

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError("Data civil inválida no resumo.");
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Data de geração inválida no resumo.");
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  const day = part("day");
  const month = part("month");
  const year = part("year");
  const hour = part("hour");
  const minute = part("minute");
  if (!day || !month || !year || !hour || !minute) throw new TypeError("Data de geração inválida no resumo.");
  return `${day}/${month}/${year} às ${hour}:${minute} — ${TIMEZONE}`;
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

function safeText(value) {
  if (typeof value !== "string") throw new TypeError("Texto inválido no resumo.");
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ");
}

function optionalContext(items) {
  return items.filter((item) => item[1]).map(([label, value]) => ` · ${label}: ${safeText(value)}`).join("");
}

function recurrenceContext(recurrence, occurrenceDate, occurrenceLabel) {
  if (!recurrence) return "";
  const currentConfiguration = ` · recorrente mensal — configuração atual: dia ${recurrence.configuredDay}`;
  const occurrenceDay = Number(occurrenceDate.slice(8, 10));
  return occurrenceDay === recurrence.configuredDay
    ? currentConfiguration
    : `${currentConfiguration} — ${occurrenceLabel}: ${formatDate(occurrenceDate)}`;
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
    `- Data de corte: ${formatDate(dto.period.asOfDate)} · ${TIMEZONE}`,
    `- Gerado em: ${formatTimestamp(dto.period.generatedAt)}`,
    ...(dto.period.isFutureMonth ? ["- Atenção: os saldos abaixo são os saldos reais de hoje, não saldos do mês futuro selecionado."] : []),
    "",
    "2. Saldos atuais",
    `- Dinheiro disponível nas contas ativas em ${formatDate(dto.period.asOfDate)}: ${formatMoney(dto.balances.totalAvailableCents)}`,
    ...linesOrEmpty(accounts, (account) => `- ${safeText(account.name)}: ${formatMoney(account.currentBalanceCents)}`),
    "",
    "3. Realizado da competência",
    `- Receitas realizadas: ${formatMoney(dto.realized.incomeCents)}`,
    `- Despesas realizadas: ${formatMoney(dto.realized.expenseCents)}`,
    `- Resultado realizado: ${formatMoney(dto.realized.resultCents)}`,
    "- Nota de leitura: realizado por competência não equivale necessariamente a dinheiro já pago. Despesas realizadas podem incluir parcelas de cartão, enquanto faturas pendentes representam pagamentos futuros de caixa; esses valores não devem ser somados como despesas distintas.",
    ...linesOrEmpty(realized, (item) => `- ${formatDate(item.date)} · ${item.type === "income" ? "Entrada" : "Saída"} · ${safeText(item.description)} · ${formatMoney(item.amountCents)} · ${safeText(item.categoryName)}/${safeText(item.subcategoryName)} · ${safeText(item.accountName)}${installment(item.installment)}`),
    "",
    "4. Receitas previstas",
    `- Pendentes no mês: ${formatMoney(dto.expectedIncome.pendingCents)}`,
    `- Pendentes atrasadas: ${formatMoney(dto.expectedIncome.overdueCents)}`,
    `- Já recebidas entre as ocorrências da competência: ${formatMoney(dto.expectedIncome.receivedCents)}`,
    ...linesOrEmpty(expected, (item) => {
      const status = item.status === "received"
        ? `recebida em ${formatDate(item.receivedDate)} por ${formatMoney(item.receivedAmountCents)}${item.actualAccountName ? ` na conta ${safeText(item.actualAccountName)}` : ""}`
        : item.timing === "overdue" ? "atrasada" : "pendente";
      return `- ${formatDate(item.expectedDate)} · ${safeText(item.description)} · previsto ${formatMoney(item.expectedAmountCents)} · ${status}${optionalContext([
        ["categoria", item.categoryName],
        ["subcategoria", item.subcategoryName],
        ["conta planejada", item.plannedAccountName],
      ])}${recurrenceContext(item.recurrence, item.expectedDate, "data prevista desta ocorrência")}`;
    }),
    "",
    "5. Contas e vencimentos",
    `- Pendentes no mês: ${formatMoney(dto.bills.pendingCents)}`,
    `- Atrasadas: ${formatMoney(dto.bills.overdueCents)}`,
    `- Pagas (valor previsto): ${formatMoney(dto.bills.paidScheduledCents)}`,
    `- Pagas (valor efetivo): ${formatMoney(dto.bills.paidActualCents)}`,
    ...linesOrEmpty(bills, (bill) => {
      const paid = bill.status === "paid" ? ` · pago ${formatMoney(bill.actualPaidAmountCents)} em ${formatDate(bill.paidDate)}` : "";
      return `- ${formatDate(bill.dueDate)} · ${safeText(bill.description)} · ${formatMoney(bill.scheduledAmountCents)} · ${billStatusLabels[bill.status]}${paid}${optionalContext([
        ["categoria", bill.categoryName],
        ["subcategoria", bill.subcategoryName],
        ["conta planejada", bill.plannedAccountName],
      ])}${recurrenceContext(bill.recurrence, bill.dueDate, "vencimento desta ocorrência")}${installment(bill.installment)}`;
    }),
    "",
    "6. Cartões e faturas",
    ...linesOrEmpty(cards, (card) => {
      const header = `- ${safeText(card.name)} (${safeText(card.institution)}) · fechamento dia ${card.closingDay} · vencimento dia ${card.dueDay} · limite ${formatMoney(card.limitCents)}`;
      const invoices = card.invoices.length ? card.invoices.flatMap((invoice) => [
        `  - Fatura ${invoice.referenceMonth} · fecha ${invoice.closesOn ? formatDate(invoice.closesOn) : "data histórica indisponível"} · vence ${formatDate(invoice.dueDate)} · total ${formatMoney(invoice.invoiceTotalCents)} · pago ${formatMoney(invoice.paidCents)} · restante ${formatMoney(invoice.remainingCents)} · ${invoiceCycleStatusLabels[invoice.cycleStatus]} · ${invoicePaymentStatusLabels[invoice.paymentStatus]}`,
        ...(invoice.openingBalance ? [`    - Saldo inicial: ${formatMoney(invoice.openingBalance.openingCents)} · identificado ${formatMoney(invoice.openingBalance.identifiedCents)} · residual ${formatMoney(invoice.openingBalance.residualCents)}`] : []),
        ...linesOrEmpty(invoice.purchases, (purchase) => `    - ${formatDate(purchase.purchaseDate)} · ${safeText(purchase.description)} · ${formatMoney(purchase.installmentAmountCents)} · parcela ${purchase.installmentNumber}/${purchase.installmentCount}`),
      ]) : ["  - Nenhuma fatura com compras na competência ou no horizonte futuro cadastrado."];
      return [header, ...invoices].join("\n");
    }),
    "",
    "7. Compromissos cadastrados para a projeção",
    "- Nota sobre atrasados: compromissos vencidos anteriormente são considerados no primeiro mês da projeção de caixa, sem alterar sua competência original.",
    ...linesOrEmpty(commitments, (item) => `- ${formatDate(item.originalDate)} · ${item.direction === "income" ? "Entrada" : "Saída"} · ${safeText(item.description)} · ${formatMoney(item.amountCents)} · ${commitmentStatusLabels[item.status]}${item.overdue ? " · vencido anteriormente; alocado no primeiro mês apenas para a projeção de caixa" : ""}${installment(item.installment)}`),
    "",
    "8. Projeção",
    "- Base: somente valores cadastrados; receitas não cadastradas não são presumidas.",
    `- Saldo atual nas contas ativas na data de corte: ${formatMoney(dto.balances.totalAvailableCents)}`,
    `- Saldo projetado inicial: ${formatMoney(dto.projection.openingBalanceCents)}`,
    `- Entradas futuras confirmadas: ${formatMoney(dto.projection.knownFutureIncomeCents)}`,
    `- Receitas previstas pendentes: ${formatMoney(dto.projection.expectedIncomeCents)}`,
    `- Receitas previstas atrasadas alocadas: ${formatMoney(dto.projection.overdueExpectedIncomeCents)}`,
    `- Saídas futuras de transações confirmadas: ${formatMoney(dto.projection.futureTransactionExpenseCents)}`,
    `- Contas atrasadas alocadas: ${formatMoney(dto.projection.overdueBillsCents)}`,
    `- Contas pendentes no mês: ${formatMoney(dto.projection.dueBillsCents)}`,
    `- Faturas restantes: ${formatMoney(dto.projection.cardInvoiceRemainingCents)}`,
    `- Total de saídas futuras cadastradas: ${formatMoney(dto.projection.knownOutflowCents)}`,
    `- Fluxo líquido projetado: ${formatMoney(dto.projection.projectedNetCashFlowCents)}`,
    `- Saldo projetado final: ${formatMoney(dto.projection.closingBalanceCents)}`,
    "",
    "9. Avisos e limitações",
    ...linesOrEmpty(warnings, (warning) => `- ${safeText(warning.message)}`),
  ].join("\n");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

export function parseBrazilianMoney(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new Error("Valor inválido.");
    return Math.round(input * 100);
  }
  let value = String(input ?? "").trim().toLowerCase().replace(/r\$|reais?|\s/g, "");
  if (!value) throw new Error("Valor não informado.");
  const negative = value.startsWith("-");
  value = value.replace(/^-/, "");
  if (value.includes(",")) value = value.replace(/\./g, "").replace(",", ".");
  else if ((value.match(/\./g) ?? []).length > 1) value = value.replace(/\./g, "");
  else if (/^\d{1,3}\.\d{3}$/.test(value)) value = value.replace(".", "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Valor inválido.");
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0 || negative) throw new Error("Valor inválido.");
  return cents;
}

export function splitInstallments(totalCents, count) {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new Error("O total deve ser positivo e em centavos.");
  if (!Number.isInteger(count) || count < 1 || count > 120) throw new Error("Número de parcelas inválido.");
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, index) => base + (index >= count - remainder ? 1 : 0));
}

export function addMonths(month, amount) {
  if (!MONTH.test(month) || !Number.isInteger(amount)) throw new Error("Mês inválido.");
  const [year, index] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, index - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function daysInMonth(month) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index, 0)).getUTCDate();
}

export function invoiceSchedule(purchaseDate, closingDay, dueDay, count) {
  if (!ISO_DATE.test(purchaseDate)) throw new Error("Data da compra inválida.");
  if (![closingDay, dueDay].every((day) => Number.isInteger(day) && day >= 1 && day <= 31)) throw new Error("Dia de fechamento ou vencimento inválido.");
  const purchaseMonth = purchaseDate.slice(0, 7);
  const purchaseDay = Number(purchaseDate.slice(8, 10));
  const closingMonth = addMonths(purchaseMonth, purchaseDay > closingDay ? 1 : 0);
  const firstDueMonth = addMonths(closingMonth, dueDay <= closingDay ? 1 : 0);
  return splitInstallments(100 * count, count).map((_, index) => {
    const referenceMonth = addMonths(firstDueMonth, index);
    const actualDueDay = Math.min(dueDay, daysInMonth(referenceMonth));
    return { referenceMonth, dueDate: `${referenceMonth}-${String(actualDueDay).padStart(2, "0")}` };
  });
}

export function buildInstallmentPlan({ totalCents, count, purchaseDate, closingDay, dueDay }) {
  const amounts = splitInstallments(totalCents, count);
  const schedule = invoiceSchedule(purchaseDate, closingDay, dueDay, count);
  return amounts.map((amountCents, index) => ({ installmentNumber: index + 1, installmentCount: count, amountCents, ...schedule[index] }));
}

export function monthRange(startMonth, count) {
  if (!Number.isInteger(count) || count < 1 || count > 120) throw new Error("Período inválido.");
  return Array.from({ length: count }, (_, index) => addMonths(startMonth, index));
}

export function simulatePurchase(input) {
  const { startMonth, availableCents, months, purchaseCents, installmentCount = 1, firstImpactMonth = startMonth } = input;
  if (!Number.isSafeInteger(availableCents) || !Array.isArray(months) || !months.length) return { confidence: "insufficient", rating: null, reasons: ["Não existem informações suficientes para uma análise confiável."], months: [] };
  const values = splitInstallments(purchaseCents, installmentCount);
  const purchaseByMonth = new Map(values.map((amount, index) => [addMonths(firstImpactMonth, index), amount]));
  let running = availableCents;
  const projection = months.map((row) => {
    const simulatedCents = purchaseByMonth.get(row.month) ?? 0;
    running += (row.incomeCents ?? 0) - (row.commitmentCents ?? 0) - simulatedCents;
    const income = row.incomeCents ?? 0;
    return { ...row, simulatedCents, projectedBalanceCents: running, incomeCommitmentPercent: income > 0 ? Math.round(((row.commitmentCents ?? 0) + simulatedCents) * 1000 / income) / 10 : null };
  });
  const lowest = Math.min(...projection.map((row) => row.projectedBalanceCents));
  const incomeSamples = projection.filter((row) => (row.incomeCents ?? 0) > 0);
  if (!incomeSamples.length && months.every((row) => (row.commitmentCents ?? 0) === 0)) return { confidence: "insufficient", rating: null, reasons: ["Não existem informações suficientes para uma análise confiável."], installmentCents: values[0], lowestBalanceCents: lowest, months: projection };
  const tight = projection.filter((row) => row.projectedBalanceCents >= 0 && ((row.incomeCommitmentPercent ?? 0) >= 80 || row.projectedBalanceCents < Math.max(20_000, (row.incomeCents ?? 0) * .1)));
  const rating = lowest < 0 ? "red" : tight.length ? "yellow" : "green";
  const labels = { green: "Pode comprar", yellow: "É possível, mas vai apertar o orçamento", red: "Não recomendado neste momento" };
  const worst = projection.reduce((a, b) => a.projectedBalanceCents <= b.projectedBalanceCents ? a : b);
  const reasons = [`A compra adiciona ${installmentCount} compromisso(s), começando em ${firstImpactMonth}.`, `O menor saldo projetado é no mês ${worst.month}: ${worst.projectedBalanceCents} centavos.`];
  if (rating === "red") reasons.push("A projeção fica negativa em pelo menos um mês.");
  if (rating === "yellow") reasons.push("A margem para imprevistos fica abaixo de 10% da renda ou R$ 200,00, ou os compromissos atingem 80% da renda.");
  return { confidence: "sufficient", rating, label: labels[rating], reasons, installmentCents: values[0], lowestBalanceCents: lowest, months: projection };
}

export function parseTelegramMessage(message, context = {}) {
  const raw = String(message ?? "").trim();
  const normalized = raw.toLocaleLowerCase("pt-BR");
  if (!raw) return { intent: "unknown", missing: ["mensagem"] };
  if (/^(cancelar|\/cancelar)$/i.test(raw)) return { intent: "cancel" };
  if (/^(desfazer|excluir) (o )?(último|ultimo) lançamento$/i.test(raw)) return { intent: "undo_last" };
  if (/^\/conectar\s+\d{6}$/i.test(raw)) return { intent: "connect", code: raw.match(/\d{6}/)[0] };
  if (/posso|consigo|cabe no meu orçamento|qual parcela cabe/.test(normalized)) return { intent: "simulate", ...parseTransactionText(raw, context) };
  const knownCards = Array.isArray(context.cards) ? context.cards : [];
  const queriedCard = knownCards.find((item) => normalized.includes(String(item.name).toLocaleLowerCase("pt-BR")));
  if (queriedCard && /quanto (tem|tenho)|fatura/.test(normalized)) return { intent: "query", query: "invoices", period: /mês que vem|próximo mês|proximo mês/.test(normalized) ? "next_month" : "month", cardId: queriedCard.id };
  const queries = [
    [/quanto temos|qual (é )?nosso saldo/, "balance"], [/quanto entrou/, "income_month"], [/quanto gastamos esse mês|quanto gastei essa semana/, "expenses"], [/quanto temos de cartão|quanto tenho de fatura/, "invoices"], [/quais parcelas/, "installments"], [/o que vence|contas estão atrasadas|quanto tenho para pagar/, "bills"],
  ];
  for (const [pattern, query] of queries) if (pattern.test(normalized)) return { intent: "query", query, period: /amanhã/.test(normalized) ? "tomorrow" : /semana|7 dias/.test(normalized) ? "week" : /mês que vem|proximo mês|próximo mês/.test(normalized) ? "next_month" : "month" };
  return { intent: "transaction", ...parseTransactionText(raw, context) };
}

function parseTransactionText(raw, context) {
  const normalized = raw.toLocaleLowerCase("pt-BR");
  const amountMatch = normalized.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{1,2}|\d+(?:[,.]\d{1,2})?)(?:\s*reais?)?/);
  let amountCents = null;
  try { if (amountMatch) amountCents = parseBrazilianMoney(amountMatch[1]); } catch { /* ambiguity is returned to the caller */ }
  const installmentsMatch = normalized.match(/(?:em\s+)?(\d{1,3})x\b/);
  const installmentCount = installmentsMatch ? Number(installmentsMatch[1]) : 1;
  const income = /\b(entrou|recebi|ganhei|pagou)\b/.test(normalized);
  const expense = /\b(gastei|paguei|comprei|comprar|gastar)\b/.test(normalized);
  const knownCards = Array.isArray(context.cards) ? context.cards : [];
  const card = knownCards.find((item) => normalized.includes(String(item.name).toLocaleLowerCase("pt-BR")));
  const knownCategories = Array.isArray(context.categories) ? context.categories : [];
  const category = knownCategories.find((item) => normalized.includes(String(item.name).toLocaleLowerCase("pt-BR")));
  const knownAccounts = Array.isArray(context.accounts) ? context.accounts : [];
  const account = knownAccounts.find((item) => normalized.includes(String(item.name).toLocaleLowerCase("pt-BR")));
  let type = income && !expense ? "income" : expense && !income ? "expense" : card ? "expense" : null;
  let description = normalized.replace(/\b(entrou|recebi|ganhei|gastei|paguei|comprei|comprar|gastar|posso|consigo|uma?|de|da|do|no|na|em)\b/g, " ").replace(/(?:r\$\s*)?\d{1,3}(?:\.\d{3})*,\d{1,2}|(?:r\$\s*)?\d+(?:[,.]\d{1,2})?|\d+x/g, " ").replace(/\s+/g, " ").trim();
  for (const item of [card, account].filter(Boolean)) description = description.replace(String(item.name).toLocaleLowerCase("pt-BR"), "").replace(/\s+/g, " ").trim();
  if (description) description = description[0].toLocaleUpperCase("pt-BR") + description.slice(1);
  if (!type && amountCents && description) type = "expense";
  const missing = [];
  if (!type) missing.push("tipo");
  if (!amountCents) missing.push("valor");
  if (!description) missing.push("descrição");
  if (card && installmentCount < 1) missing.push("parcelas");
  return { type, amountCents, description: description || null, installmentCount, cardId: card?.id ?? null, categoryId: category?.id ?? null, accountId: account?.id ?? null, missing, ambiguous: missing.length > 0 };
}

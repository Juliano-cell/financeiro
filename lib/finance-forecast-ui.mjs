export const FORECAST_HORIZONS = [3, 6, 12];

export function forecastSummary(forecast) {
  const months = Array.isArray(forecast?.months) ? forecast.months : [];
  const lowestMonth = months.reduce((lowest, month) => (
    !lowest || month.closingBalanceCents < lowest.closingBalanceCents ? month : lowest
  ), null);
  return {
    currentBalanceCents: forecast.currentBalanceCents,
    projectedIncomeCents:
      forecast.knownFutureIncomeCents
      + forecast.expectedIncomeCents
      + forecast.overdueExpectedIncomeCents,
    projectedOutflowCents: forecast.knownFutureOutflowCents,
    projectedEndingBalanceCents: forecast.projectedEndingBalanceCents,
    lowestMonth: lowestMonth ? { month: lowestMonth.month, closingBalanceCents: lowestMonth.closingBalanceCents } : null,
    hasNegativeMonth: months.some((month) => month.closingBalanceCents < 0),
    hasFutureActivity:
      forecast.knownFutureIncomeCents !== 0
      || forecast.expectedIncomeCents !== 0
      || forecast.overdueExpectedIncomeCents !== 0
      || forecast.knownFutureOutflowCents !== 0,
  };
}

export function forecastMonthPresentation(month) {
  return {
    month: month.month,
    openingBalanceCents: month.openingBalanceCents,
    projectedIncomeCents:
      month.knownFutureIncomeCents
      + month.expectedIncomeCents
      + month.overdueExpectedIncomeCents,
    projectedOutflowCents: month.knownOutflowCents,
    closingBalanceCents: month.closingBalanceCents,
    isNegative: month.closingBalanceCents < 0,
    income: {
      expectedIncomeCents: month.expectedIncomeCents,
      overdueExpectedIncomeCents: month.overdueExpectedIncomeCents,
      knownFutureIncomeCents: month.knownFutureIncomeCents,
    },
    outflow: {
      pendingBillsCents: month.overdueBillsCents + month.dueBillsCents,
      cardInvoiceCents: month.cardInvoiceRemainingCents,
      futureTransactionExpenseCents: month.futureTransactionExpenseCents,
    },
  };
}

export function forecastMonthLabel(month) {
  if (!/^\d{4}-\d{2}$/u.test(month)) return "Mês indisponível";
  const [year, monthNumber] = month.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) return "Mês indisponível";
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

export function forecastWarningPresentation(code) {
  if (code === "UNREGISTERED_INCOME_NOT_INCLUDED") return {
    title: "Entradas ainda não cadastradas",
    description: "Esta previsão considera apenas as entradas cadastradas. Se você espera receber outros valores, adicione-os em Entradas previstas.",
    action: "expected-income",
  };
  if (code === "POSSIBLE_FUTURE_INCOME_OVERLAP") return {
    title: "Possível sobreposição de entradas",
    description: "Encontramos lançamentos futuros que podem representar a mesma entrada prevista. Os valores foram mantidos separados na projeção.",
    action: null,
  };
  if (code === "RECURRENCE_COVERAGE_LIMITED" || code === "EXPECTED_INCOME_COVERAGE_LIMITED") return {
    title: "Período parcialmente coberto",
    description: "Algumas recorrências ainda não estão cadastradas para todo o período selecionado. A previsão pode ficar incompleta nos meses mais distantes.",
    action: null,
  };
  return {
    title: "Atenção à projeção",
    description: "Algumas informações podem não cobrir todo o período selecionado.",
    action: null,
  };
}

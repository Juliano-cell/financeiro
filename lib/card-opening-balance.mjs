export function resolveOpeningBalanceBreakdown({ initialInvoiceTotalCents, openingCents, allocatedCents }) {
  if (![initialInvoiceTotalCents, openingCents, allocatedCents].every((value) => Number.isSafeInteger(value) && value >= 0)
    || openingCents > initialInvoiceTotalCents || allocatedCents > openingCents) return null;
  const initialStateInstallmentsCents = initialInvoiceTotalCents - openingCents;
  const residualCents = openingCents - allocatedCents;
  const identifiedCents = initialStateInstallmentsCents + allocatedCents;
  if (identifiedCents + residualCents !== initialInvoiceTotalCents) return null;
  return {
    originalCents: initialInvoiceTotalCents,
    openingCents,
    initialStateInstallmentsCents,
    allocatedCents,
    residualCents,
    identifiedCents,
  };
}

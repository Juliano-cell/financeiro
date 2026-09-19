import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getCurrentUser, isSameOriginRequest } from "@/app/auth";
import { getDb } from "@/db";
import { bills, cardInstallments, cardInvoices, cardPurchaseImportMetadata, cardPurchases, creditCards, householdMembers, notificationPreferences, transactions } from "@/db/schema";
import { BillServiceError, cancelBillOccurrence, cancelRecurringBillSeries, createBill, payBill, undoBillPayment, updateBillOccurrence, updateRecurringBillSeries } from "@/lib/bill-service";
import { addMonths, buildInstallmentPlan, simulatePurchase } from "@/lib/finance-rules.mjs";
import { createCardPurchase, FinanceValidationError } from "@/lib/finance-service";
import { getCurrentAccountBalances } from "@/lib/finance-analytics-service";
import { cancelCardPurchase, getHouseholdInvoiceStates, getInvoicePaymentHistory, invoiceCivilDate, InvoiceServiceError, payInvoiceResidual, reverseInvoicePayment } from "@/lib/invoice-service";
import { resolveInstallmentDisplay } from "@/lib/card-onboarding-ui-rules.mjs";

export const dynamic = "force-dynamic";

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const id = z.string().min(1).max(100);
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().int().safe().min(1).max(100_000_000_000);
const shortText = z.string().trim().min(1).max(120);
const operationKey = z.string().min(1).max(200);
const privateHeaders = { "Cache-Control": "private, no-store" };
const occurrenceIds = z.array(id).min(1).max(48).refine((values) => new Set(values).size === values.length, "A seleção contém vencimentos duplicados.");
const recurringUpdateSchema = z.object({
  id,
  anchorBillId: id,
  scope: z.enum(["future", "selected"]),
  occurrenceIds,
  changeDueDate: z.boolean(),
  changeRecurrenceEnd: z.boolean(),
  description: shortText,
  amountCents: money,
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  categoryId: id,
  subcategoryId: id.nullable().optional(),
  accountId: id.nullable().optional(),
  endsOn: dateSchema.nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
}).superRefine((value, issue) => {
  if (value.changeDueDate && value.dayOfMonth === undefined) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["dayOfMonth"], message: "Informe o novo dia de vencimento." });
  if (value.changeRecurrenceEnd && value.endsOn === undefined) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["endsOn"], message: "Informe explicitamente a nova data limite da recorrência." });
  if (value.scope === "selected" && value.changeRecurrenceEnd) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["changeRecurrenceEnd"], message: "A data limite só pode ser alterada para este e os próximos vencimentos." });
});

async function identity() {
  const user = await getCurrentUser();
  if (!user) return null;
  const db = getDb();
  const d1 = env.DB;
  if (!d1) throw new Error("Binding DB não configurado.");
  const [membership] = await db.select().from(householdMembers).where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active"))).limit(1);
  return membership ? { db, d1, user, householdId: membership.householdId } : null;
}

export async function GET(request: Request) {
  const current = await identity();
  if (!current) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const today = invoiceCivilDate();
  const selectedMonth = new URL(request.url).searchParams.get("month") ?? today.slice(0, 7);
  if (!monthSchema.safeParse(selectedMonth).success) return NextResponse.json({ error: "Mês inválido." }, { status: 400 });
  const { db, d1, householdId } = current;
  const [cardRows, purchaseRows, invoiceRows, installmentRows, importMetadataRows, billRows, transactionRows, preferenceRows, invoiceStates, balanceRows] = await Promise.all([
    db.select().from(creditCards).where(eq(creditCards.householdId, householdId)).orderBy(asc(creditCards.name)),
    db.select().from(cardPurchases).where(eq(cardPurchases.householdId, householdId)),
    db.select().from(cardInvoices).where(eq(cardInvoices.householdId, householdId)),
    db.select().from(cardInstallments).where(eq(cardInstallments.householdId, householdId)),
    db.select().from(cardPurchaseImportMetadata).where(eq(cardPurchaseImportMetadata.householdId, householdId)),
    db.select().from(bills).where(eq(bills.householdId, householdId)).orderBy(asc(bills.dueDate)),
    db.select().from(transactions).where(eq(transactions.householdId, householdId)),
    db.select().from(notificationPreferences).where(eq(notificationPreferences.householdId, householdId)),
    getHouseholdInvoiceStates({ d1, householdId, userId: current.user.id }),
    getCurrentAccountBalances(householdId, today),
  ]);
  const stateById = new Map(invoiceStates.map((invoice) => [invoice.invoiceId, invoice]));
  if (invoiceRows.some((invoice) => !stateById.has(invoice.id))) return NextResponse.json({ error: "As faturas foram atualizadas durante a consulta. Tente novamente." }, { status: 409, headers: privateHeaders });
  const purchaseById = new Map(purchaseRows.map((item) => [item.id, item]));
  const invoiceById = new Map(invoiceRows.map((item) => [item.id, item]));
  const metadataByPurchaseId = new Map(importMetadataRows.map((item) => [item.purchaseId, item]));
  let inconsistentInstallmentDisplay = false;
  const installments = installmentRows.map((item) => {
    const metadata = metadataByPurchaseId.get(item.purchaseId);
    const display = resolveInstallmentDisplay({ physicalNumber: item.installmentNumber, physicalCount: item.installmentCount, firstOriginalNumber: metadata?.firstOriginalInstallmentNumber ?? null, originalCount: metadata?.originalInstallmentCount ?? null });
    if (!display) inconsistentInstallmentDisplay = true;
    return { ...item, installmentNumber: display?.installmentNumber ?? item.installmentNumber, installmentCount: display?.installmentCount ?? item.installmentCount, purchase: purchaseById.get(item.purchaseId), invoice: invoiceById.get(item.invoiceId), card: cardRows.find((card) => card.id === purchaseById.get(item.purchaseId)?.cardId) };
  });
  if (inconsistentInstallmentDisplay) return NextResponse.json({ error: "Não foi possível exibir as parcelas porque os dados estão inconsistentes." }, { status: 409, headers: privateHeaders });
  const invoices = invoiceRows.map((invoice) => {
    const parts = installments.filter((item) => item.invoiceId === invoice.id && item.status !== "cancelled");
    const state = stateById.get(invoice.id)!;
    return { ...invoice, ...state, totalCents: state.invoiceTotalCents, installments: parts };
  });
  const cards = cardRows.map((card) => {
    const activeParts = installments.filter((item) => item.card?.id === card.id && item.status !== "cancelled" && (stateById.get(item.invoiceId)?.remainingCents ?? 0) > 0 && item.purchase?.status === "active");
    const usedCents = invoiceStates.filter((invoice) => invoice.cardId === card.id).reduce((sum, invoice) => sum + invoice.remainingCents, 0);
    return { ...card, usedCents, availableCents: card.limitCents - usedCents, currentInvoiceCents: invoices.find((item) => item.cardId === card.id && item.referenceMonth === selectedMonth)?.remainingCents ?? 0, nextInvoiceCents: invoices.find((item) => item.cardId === card.id && item.referenceMonth === addMonths(selectedMonth, 1))?.remainingCents ?? 0, installmentPurchaseCount: new Set(activeParts.filter((item) => item.installmentCount > 1).map((item) => item.purchaseId)).size };
  });
  const availableCents = balanceRows.filter((item) => item.isActive).reduce((sum, item) => sum + item.currentBalanceCents, 0);
  const monthTransactions = transactionRows.filter((item) => item.status === "confirmed" && item.transactionDate.startsWith(selectedMonth));
  const monthInstallments = installments.filter((item) => item.invoice?.referenceMonth === selectedMonth && item.status !== "cancelled" && item.purchase?.status === "active");
  const monthBills = billRows.filter((item) => item.dueDate.startsWith(selectedMonth) && item.status !== "cancelled");
  const pendingBillsCents = monthBills.filter((item) => item.status === "pending").reduce((sum, item) => sum + item.amountCents, 0);
  const incomeCents = monthTransactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amountCents, 0);
  const cashExpenseCents = monthTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amountCents, 0);
  const cardExpenseCents = monthInstallments.reduce((sum, item) => sum + item.amountCents, 0);
  const pendingCardCents = invoiceStates.filter((item) => item.referenceMonth === selectedMonth).reduce((sum, item) => sum + item.remainingCents, 0);
  const preference = preferenceRows[0]; let notificationOffsets = [7, 3, 1, 0, -1]; try { if (preference) notificationOffsets = JSON.parse(preference.offsetsJson); } catch { /* defaults */ }
  return NextResponse.json({ selectedMonth, cards, purchases: purchaseRows, invoices, installments, bills: billRows.map((bill) => ({ ...bill, displayStatus: bill.status === "pending" && bill.dueDate < today ? "overdue" : bill.status })), notificationSettings: { enabled: preference?.enabled ?? true, offsets: notificationOffsets }, summary: { availableCents, incomeCents, expenseCents: cashExpenseCents + cardExpenseCents, paidBillsCents: monthBills.filter((item) => item.status === "paid").reduce((sum, item) => sum + item.amountCents, 0), pendingBillsCents, cardCents: cardExpenseCents, pendingCardCents, installmentCents: monthInstallments.filter((item) => item.installmentCount > 1).reduce((sum, item) => sum + item.amountCents, 0), commitmentsCents: pendingBillsCents + pendingCardCents, projectedCents: availableCents + (selectedMonth > today.slice(0, 7) ? incomeCents : 0) - pendingBillsCents - pendingCardCents } }, { headers: privateHeaders });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Origem da solicitação inválida." }, { status: 403 });
  const current = await identity();
  if (!current) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = z.string().parse(body.action);
    const { db, d1, householdId, user } = current;
    const timestamp = now();
    if (action === "create_card" || action === "update_card") {
      const parsed = z.object({ id: id.optional(), name: shortText, institution: shortText, holder: shortText, limitCents: z.number().int().min(0), closingDay: z.number().int().min(1).max(31), dueDay: z.number().int().min(1).max(31), isActive: z.boolean().default(true), notes: z.string().trim().max(500).nullable().optional() }).parse(body);
      if (action === "create_card") { const entityId = uid("card"); await db.insert(creditCards).values({ ...parsed, id: entityId, householdId, createdAt: timestamp, updatedAt: timestamp }); return NextResponse.json({ ok: true, id: entityId }); }
      const [owned] = await db.select().from(creditCards).where(and(eq(creditCards.id, parsed.id!), eq(creditCards.householdId, householdId))).limit(1);
      if (!owned) return NextResponse.json({ error: "Cartão não encontrado." }, { status: 404 });
      const { id: entityId, ...changes } = parsed; await db.update(creditCards).set({ ...changes, updatedAt: timestamp }).where(and(eq(creditCards.id, entityId!), eq(creditCards.householdId, householdId))); return NextResponse.json({ ok: true });
    }
    if (action === "update_notification_settings") {
      const parsed = z.object({ enabled: z.boolean(), offsets: z.array(z.union([z.literal(7), z.literal(3), z.literal(1), z.literal(0), z.literal(-1)])).max(5) }).parse(body); await db.insert(notificationPreferences).values({ householdId, enabled: parsed.enabled, offsetsJson: JSON.stringify([...new Set(parsed.offsets)]), updatedAt: timestamp }).onConflictDoUpdate({ target: notificationPreferences.householdId, set: { enabled: parsed.enabled, offsetsJson: JSON.stringify([...new Set(parsed.offsets)]), updatedAt: timestamp } }); return NextResponse.json({ ok: true });
    }
    if (action === "delete_card") {
      const parsed = z.object({ id }).parse(body); const [owned] = await db.select().from(creditCards).where(and(eq(creditCards.id, parsed.id), eq(creditCards.householdId, householdId))).limit(1); if (!owned) return NextResponse.json({ error: "Cartão não encontrado." }, { status: 404 });
      const [used] = await db.select({ id: cardPurchases.id }).from(cardPurchases).where(and(eq(cardPurchases.cardId, parsed.id), eq(cardPurchases.householdId, householdId))).limit(1);
      if (used) { await db.update(creditCards).set({ isActive: false, updatedAt: timestamp }).where(and(eq(creditCards.id, parsed.id), eq(creditCards.householdId, householdId))); return NextResponse.json({ ok: true, inactivated: true }); }
      await db.delete(creditCards).where(and(eq(creditCards.id, parsed.id), eq(creditCards.householdId, householdId))); return NextResponse.json({ ok: true });
    }
    if (action === "create_card_purchase") {
      const parsed = z.object({ cardId: id, description: shortText, totalCents: money, purchaseDate: dateSchema, installmentCount: z.number().int().min(1).max(120), categoryId: id, subcategoryId: id.nullable().optional(), notes: z.string().max(500).nullable().optional() }).parse(body);
      const result = await createCardPurchase(parsed, { householdId, userId: user.id, origin: "dashboard" });
      return NextResponse.json({ ok: true, id: result.id, plan: result.plan });
    }
    if (action === "delete_card_purchase") {
      const parsed = z.object({ id }).parse(body);
      await cancelCardPurchase(parsed.id, { d1, householdId, userId: user.id, timestamp });
      return NextResponse.json({ ok: true, cancelled: true }, { headers: privateHeaders });
    }
    if (action === "pay_invoice") {
      const parsed = z.object({ invoiceId: id, accountId: id, paidAt: dateSchema, idempotencyKey: operationKey.optional(), operationId: operationKey.optional(), expectedRemainingCents: z.number().int().safe().min(0) }).refine((value) => Boolean(value.idempotencyKey || value.operationId), "Informe a chave da operação.").parse(body);
      const result = await payInvoiceResidual({ ...parsed, idempotencyKey: parsed.idempotencyKey ?? parsed.operationId! }, { d1, householdId, userId: user.id, timestamp });
      return NextResponse.json({ ok: true, ...result }, { headers: privateHeaders });
    }
    if (action === "reverse_invoice_payment") {
      const parsed = z.object({ paymentId: id, reversedAt: dateSchema, idempotencyKey: operationKey.optional(), operationId: operationKey.optional() }).refine((value) => Boolean(value.idempotencyKey || value.operationId), "Informe a chave da operação.").parse(body);
      const result = await reverseInvoicePayment({ ...parsed, idempotencyKey: parsed.idempotencyKey ?? parsed.operationId! }, { d1, householdId, userId: user.id, timestamp });
      return NextResponse.json({ ok: true, ...result }, { headers: privateHeaders });
    }
    if (action === "get_invoice_payment_history") {
      const parsed = z.object({ invoiceId: id }).parse(body);
      return NextResponse.json(await getInvoicePaymentHistory(parsed.invoiceId, { d1, householdId, userId: user.id, timestamp }), { headers: privateHeaders });
    }
    if (action === "create_bill") {
      if (!env.DB) throw new Error("D1 binding indisponível");
      const parsed = z.object({ description: shortText, amountCents: money, dueDate: dateSchema, categoryId: id, subcategoryId: id.nullable().optional(), accountId: id.nullable().optional(), recurrence: z.enum(["none", "monthly"]).default("none"), recurrenceEndDate: dateSchema.nullable().optional(), notes: z.string().max(500).nullable().optional() }).parse(body);
      const result = await createBill(parsed, { d1: env.DB, householdId, userId: user.id, timestamp });
      return NextResponse.json({ ok: true, ids: result.ids });
    }
    if (action === "update_bill_occurrence") {
      if (!env.DB) throw new Error("D1 binding indisponível");
      const parsed = z.object({ id, description: shortText, amountCents: money, dueDate: dateSchema, categoryId: id, subcategoryId: id.nullable().optional(), accountId: id.nullable().optional(), notes: z.string().max(500).nullable().optional() }).parse(body);
      await updateBillOccurrence(parsed, { d1: env.DB, householdId, userId: user.id, timestamp }); return NextResponse.json({ ok: true });
    }
    if (action === "cancel_bill_occurrence") {
      if (!env.DB) throw new Error("D1 binding indisponível");
      const parsed = z.object({ id }).parse(body); await cancelBillOccurrence(parsed.id, { d1: env.DB, householdId, userId: user.id, timestamp }); return NextResponse.json({ ok: true });
    }
    if (action === "update_recurring_bill_series") {
      if (!env.DB) throw new Error("D1 binding indisponível");
      const parsed = recurringUpdateSchema.parse(body);
      const result = await updateRecurringBillSeries(parsed, { d1: env.DB, householdId, userId: user.id, timestamp }); return NextResponse.json({ ok: true, updatedOccurrences: result.updatedOccurrences });
    }
    if (action === "cancel_recurring_bill_series") {
      if (!env.DB) throw new Error("D1 binding indisponível");
      const parsed = z.object({ id }).parse(body); await cancelRecurringBillSeries(parsed.id, { d1: env.DB, householdId, userId: user.id, timestamp }); return NextResponse.json({ ok: true });
    }
    if (action === "pay_bill") {
      if (!env.DB) throw new Error("D1 binding indisponível");
      const parsed = z.object({ id, accountId: id }).parse(body); const result = await payBill(parsed, { d1: env.DB, householdId, userId: user.id, timestamp }); return NextResponse.json({ ok: true, transactionId: result.transactionId });
    }
    if (action === "undo_bill_payment") {
      if (!env.DB) throw new Error("D1 binding indisponível");
      const parsed = z.object({ id }).parse(body); const result = await undoBillPayment(parsed.id, { d1: env.DB, householdId, userId: user.id, timestamp }); return NextResponse.json({ ok: true, transactionId: result.transactionId });
    }
    if (action === "simulate_purchase") {
      const parsed = z.object({ description: shortText, purchaseCents: money, purchaseDate: dateSchema, paymentMethod: z.enum(["cash", "credit_card"]), installmentCount: z.number().int().min(1).max(120), cardId: id.nullable().optional() }).parse(body);
      let firstImpactMonth = parsed.purchaseDate.slice(0, 7);
      if (parsed.paymentMethod === "credit_card") {
        if (!parsed.cardId) return NextResponse.json({ error: "Selecione o cartão para simular." }, { status: 400 });
        const [card] = await db.select().from(creditCards).where(and(eq(creditCards.id, parsed.cardId), eq(creditCards.householdId, householdId), eq(creditCards.isActive, true))).limit(1);
        if (!card) return NextResponse.json({ error: "Cartão inválido." }, { status: 400 });
        firstImpactMonth = buildInstallmentPlan({ totalCents: parsed.purchaseCents, count: parsed.installmentCount, purchaseDate: parsed.purchaseDate, closingDay: card.closingDay, dueDay: card.dueDay })[0].referenceMonth;
      }
      const today = invoiceCivilDate(timestamp); const currentMonth = today.slice(0, 7);
      const [transactionRows, billRows, invoiceStates, balanceRows] = await Promise.all([
        db.select().from(transactions).where(eq(transactions.householdId, householdId)), db.select().from(bills).where(eq(bills.householdId, householdId)),
        getHouseholdInvoiceStates({ d1, householdId, userId: user.id, timestamp }), getCurrentAccountBalances(householdId, today),
      ]);
      const availableCents = balanceRows.filter((account) => account.isActive).reduce((sum, account) => sum + account.currentBalanceCents, 0);
      const horizon = Math.max(12, parsed.installmentCount); const months = Array.from({ length: horizon }, (_, index) => addMonths(currentMonth, index)).map((month) => {
        const monthTransactions = transactionRows.filter((item) => item.status === "confirmed" && item.transactionDate.startsWith(month) && item.transactionDate > today);
        const incomeCents = monthTransactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amountCents, 0);
        const plannedCashExpenses = monthTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amountCents, 0);
        const billsCents = billRows.filter((item) => item.status === "pending" && item.dueDate.startsWith(month)).reduce((sum, item) => sum + item.amountCents, 0);
        const cardCents = invoiceStates.filter((item) => item.referenceMonth === month).reduce((sum, item) => sum + item.remainingCents, 0);
        return { month, incomeCents, commitmentCents: plannedCashExpenses + billsCents + cardCents };
      });
      const result = simulatePurchase({ startMonth: currentMonth, availableCents, purchaseCents: parsed.purchaseCents, installmentCount: parsed.paymentMethod === "cash" ? 1 : parsed.installmentCount, firstImpactMonth, months });
      return NextResponse.json({ ...result, description: parsed.description, firstImpactMonth });
    }
    return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
  } catch (error) {
    if (error instanceof InvoiceServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: privateHeaders });
    if (error instanceof BillServiceError) return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
    if (error instanceof FinanceValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Dados inválidos.", details: error.flatten() }, { status: 400 });
    console.error("advanced_finance_failed", error); return NextResponse.json({ error: "Não foi possível concluir a operação." }, { status: 500 });
  }
}

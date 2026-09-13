import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getCurrentUser, isSameOriginRequest } from "@/app/auth";
import { getDb } from "@/db";
import { accounts, bills, cardInstallments, cardInvoices, cardPurchases, creditCards, householdMembers, invoicePayments, notificationPreferences, transactions } from "@/db/schema";
import { BillServiceError, cancelBillOccurrence, cancelRecurringBillSeries, createBill, payBill, undoBillPayment, updateBillOccurrence, updateRecurringBillSeries } from "@/lib/bill-service";
import { addMonths, buildInstallmentPlan, simulatePurchase } from "@/lib/finance-rules.mjs";
import { createCardPurchase, FinanceValidationError } from "@/lib/finance-service";

export const dynamic = "force-dynamic";

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const id = z.string().min(1).max(100);
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().int().safe().min(1).max(100_000_000_000);
const shortText = z.string().trim().min(1).max(120);
const occurrenceIds = z.array(id).min(1).max(48).refine((values) => new Set(values).size === values.length, "A seleção contém vencimentos duplicados.");

async function identity() {
  const user = await getCurrentUser();
  if (!user) return null;
  const db = getDb();
  const [membership] = await db.select().from(householdMembers).where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active"))).limit(1);
  return membership ? { db, user, householdId: membership.householdId } : null;
}

export async function GET(request: Request) {
  const current = await identity();
  if (!current) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const selectedMonth = new URL(request.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  if (!monthSchema.safeParse(selectedMonth).success) return NextResponse.json({ error: "Mês inválido." }, { status: 400 });
  const { db, householdId } = current;
  const [cardRows, purchaseRows, invoiceRows, installmentRows, billRows, paymentRows, accountRows, transactionRows, preferenceRows] = await Promise.all([
    db.select().from(creditCards).where(eq(creditCards.householdId, householdId)).orderBy(asc(creditCards.name)),
    db.select().from(cardPurchases).where(eq(cardPurchases.householdId, householdId)),
    db.select().from(cardInvoices).where(eq(cardInvoices.householdId, householdId)),
    db.select().from(cardInstallments).where(eq(cardInstallments.householdId, householdId)),
    db.select().from(bills).where(eq(bills.householdId, householdId)).orderBy(asc(bills.dueDate)),
    db.select().from(invoicePayments).where(eq(invoicePayments.householdId, householdId)),
    db.select().from(accounts).where(eq(accounts.householdId, householdId)),
    db.select().from(transactions).where(eq(transactions.householdId, householdId)),
    db.select().from(notificationPreferences).where(eq(notificationPreferences.householdId, householdId)),
  ]);
  const purchaseById = new Map(purchaseRows.map((item) => [item.id, item]));
  const invoiceById = new Map(invoiceRows.map((item) => [item.id, item]));
  const installments = installmentRows.map((item) => ({ ...item, purchase: purchaseById.get(item.purchaseId), invoice: invoiceById.get(item.invoiceId), card: cardRows.find((card) => card.id === purchaseById.get(item.purchaseId)?.cardId) }));
  const invoices = invoiceRows.map((invoice) => {
    const parts = installments.filter((item) => item.invoiceId === invoice.id && item.status !== "cancelled");
    return { ...invoice, totalCents: parts.reduce((sum, item) => sum + item.amountCents, 0), installments: parts };
  });
  const cards = cardRows.map((card) => {
    const activeParts = installments.filter((item) => item.card?.id === card.id && item.status === "pending" && item.purchase?.status === "active");
    const usedCents = activeParts.reduce((sum, item) => sum + item.amountCents, 0);
    return { ...card, usedCents, availableCents: card.limitCents - usedCents, currentInvoiceCents: invoices.find((item) => item.cardId === card.id && item.referenceMonth === selectedMonth)?.totalCents ?? 0, nextInvoiceCents: invoices.find((item) => item.cardId === card.id && item.referenceMonth === addMonths(selectedMonth, 1))?.totalCents ?? 0, installmentPurchaseCount: new Set(activeParts.filter((item) => item.installmentCount > 1).map((item) => item.purchaseId)).size };
  });
  const accountBalances = new Map(accountRows.map((account) => [account.id, account.initialBalanceCents]));
  for (const item of transactionRows) if (item.status === "confirmed") accountBalances.set(item.accountId, (accountBalances.get(item.accountId) ?? 0) + (item.type === "income" ? item.amountCents : -item.amountCents));
  for (const payment of paymentRows) accountBalances.set(payment.accountId, (accountBalances.get(payment.accountId) ?? 0) - payment.amountCents);
  const availableCents = accountRows.filter((item) => item.isActive).reduce((sum, item) => sum + (accountBalances.get(item.id) ?? 0), 0);
  const monthTransactions = transactionRows.filter((item) => item.status === "confirmed" && item.transactionDate.startsWith(selectedMonth));
  const monthInstallments = installments.filter((item) => item.invoice?.referenceMonth === selectedMonth && item.status !== "cancelled" && item.purchase?.status === "active");
  const monthBills = billRows.filter((item) => item.dueDate.startsWith(selectedMonth) && item.status !== "cancelled");
  const today = new Date().toISOString().slice(0, 10);
  const pendingBillsCents = monthBills.filter((item) => item.status === "pending").reduce((sum, item) => sum + item.amountCents, 0);
  const incomeCents = monthTransactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amountCents, 0);
  const cashExpenseCents = monthTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amountCents, 0);
  const cardExpenseCents = monthInstallments.reduce((sum, item) => sum + item.amountCents, 0);
  const preference = preferenceRows[0]; let notificationOffsets = [7, 3, 1, 0, -1]; try { if (preference) notificationOffsets = JSON.parse(preference.offsetsJson); } catch { /* defaults */ }
  return NextResponse.json({ selectedMonth, cards, purchases: purchaseRows, invoices, installments, bills: billRows.map((bill) => ({ ...bill, displayStatus: bill.status === "pending" && bill.dueDate < today ? "overdue" : bill.status })), notificationSettings: { enabled: preference?.enabled ?? true, offsets: notificationOffsets }, summary: { availableCents, incomeCents, expenseCents: cashExpenseCents + cardExpenseCents, paidBillsCents: monthBills.filter((item) => item.status === "paid").reduce((sum, item) => sum + item.amountCents, 0), pendingBillsCents, cardCents: cardExpenseCents, installmentCents: monthInstallments.filter((item) => item.installmentCount > 1).reduce((sum, item) => sum + item.amountCents, 0), commitmentsCents: pendingBillsCents + cardExpenseCents, projectedCents: availableCents + (selectedMonth > new Date().toISOString().slice(0, 7) ? incomeCents : 0) - pendingBillsCents - cardExpenseCents } });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Origem da solicitação inválida." }, { status: 403 });
  const current = await identity();
  if (!current) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = z.string().parse(body.action);
    const { db, householdId, user } = current;
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
      const parsed = z.object({ cardId: id, description: shortText, totalCents: money, purchaseDate: dateSchema, installmentCount: z.number().int().min(1).max(120), categoryId: id.nullable().optional(), notes: z.string().max(500).nullable().optional() }).parse(body);
      const result = await createCardPurchase(parsed, { householdId, userId: user.id, origin: "dashboard" });
      return NextResponse.json({ ok: true, id: result.id, plan: result.plan });
    }
    if (action === "delete_card_purchase") {
      const parsed = z.object({ id }).parse(body); const [purchase] = await db.select().from(cardPurchases).where(and(eq(cardPurchases.id, parsed.id), eq(cardPurchases.householdId, householdId))).limit(1); if (!purchase) return NextResponse.json({ error: "Compra não encontrada." }, { status: 404 });
      const related = await db.select().from(cardInstallments).where(and(eq(cardInstallments.purchaseId, parsed.id), eq(cardInstallments.householdId, householdId))); const paidInvoiceIds = new Set((await db.select().from(cardInvoices).where(eq(cardInvoices.householdId, householdId))).filter((invoice) => invoice.status === "paid").map((invoice) => invoice.id));
      if (related.some((part) => paidInvoiceIds.has(part.invoiceId))) return NextResponse.json({ error: "A compra possui parcela em fatura paga e não pode ser excluída." }, { status: 409 });
      await db.delete(cardInstallments).where(and(eq(cardInstallments.purchaseId, parsed.id), eq(cardInstallments.householdId, householdId))); await db.delete(cardPurchases).where(and(eq(cardPurchases.id, parsed.id), eq(cardPurchases.householdId, householdId))); return NextResponse.json({ ok: true });
    }
    if (action === "pay_invoice") {
      const parsed = z.object({ invoiceId: id, accountId: id, paidAt: dateSchema }).parse(body); const [invoice] = await db.select().from(cardInvoices).where(and(eq(cardInvoices.id, parsed.invoiceId), eq(cardInvoices.householdId, householdId))).limit(1); const [account] = await db.select().from(accounts).where(and(eq(accounts.id, parsed.accountId), eq(accounts.householdId, householdId))).limit(1); if (!invoice || !account) return NextResponse.json({ error: "Fatura ou conta inválida." }, { status: 400 }); if (invoice.status === "paid") return NextResponse.json({ error: "Esta fatura já foi paga." }, { status: 409 });
      const parts = await db.select().from(cardInstallments).where(and(eq(cardInstallments.invoiceId, invoice.id), eq(cardInstallments.householdId, householdId))); const amountCents = parts.filter((item) => item.status !== "cancelled").reduce((sum, item) => sum + item.amountCents, 0); if (!amountCents) return NextResponse.json({ error: "A fatura não possui valor para pagamento." }, { status: 409 });
      if (!env.DB) throw new Error("D1 binding indisponível");
      await env.DB.batch([
        env.DB.prepare("INSERT INTO invoice_payments (id, household_id, invoice_id, account_id, amount_cents, paid_at, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(uid("invoice_payment"), householdId, invoice.id, account.id, amountCents, parsed.paidAt, user.id, timestamp),
        env.DB.prepare("UPDATE card_invoices SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND household_id = ? AND status <> 'paid'").bind(parsed.paidAt, timestamp, invoice.id, householdId),
        env.DB.prepare("UPDATE card_installments SET status = 'paid', updated_at = ? WHERE invoice_id = ? AND household_id = ? AND status <> 'cancelled'").bind(timestamp, invoice.id, householdId),
      ]);
      return NextResponse.json({ ok: true, amountCents });
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
      const parsed = z.object({ id, anchorBillId: id, scope: z.enum(["future", "selected"]), occurrenceIds, changeDueDate: z.boolean(), description: shortText, amountCents: money, dayOfMonth: z.number().int().min(1).max(31), categoryId: id, subcategoryId: id.nullable().optional(), accountId: id.nullable().optional(), endsOn: dateSchema.nullable().optional(), notes: z.string().max(500).nullable().optional() }).parse(body);
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
      const [accountRows, transactionRows, paymentRows, billRows, invoiceRows, installmentRows] = await Promise.all([
        db.select().from(accounts).where(eq(accounts.householdId, householdId)), db.select().from(transactions).where(eq(transactions.householdId, householdId)), db.select().from(invoicePayments).where(eq(invoicePayments.householdId, householdId)), db.select().from(bills).where(eq(bills.householdId, householdId)), db.select().from(cardInvoices).where(eq(cardInvoices.householdId, householdId)), db.select().from(cardInstallments).where(eq(cardInstallments.householdId, householdId)),
      ]);
      const today = timestamp.slice(0, 10); const currentMonth = today.slice(0, 7); const balances = new Map(accountRows.map((account) => [account.id, account.initialBalanceCents]));
      for (const item of transactionRows) if (item.status === "confirmed" && item.transactionDate <= today) balances.set(item.accountId, (balances.get(item.accountId) ?? 0) + (item.type === "income" ? item.amountCents : -item.amountCents));
      for (const payment of paymentRows) if (payment.paidAt <= today) balances.set(payment.accountId, (balances.get(payment.accountId) ?? 0) - payment.amountCents);
      const availableCents = accountRows.filter((account) => account.isActive).reduce((sum, account) => sum + (balances.get(account.id) ?? 0), 0);
      const invoiceById = new Map(invoiceRows.map((invoice) => [invoice.id, invoice])); const horizon = Math.max(12, parsed.installmentCount); const months = Array.from({ length: horizon }, (_, index) => addMonths(currentMonth, index)).map((month) => {
        const monthTransactions = transactionRows.filter((item) => item.status === "confirmed" && item.transactionDate.startsWith(month) && item.transactionDate > today);
        const incomeCents = monthTransactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amountCents, 0);
        const plannedCashExpenses = monthTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amountCents, 0);
        const billsCents = billRows.filter((item) => item.status === "pending" && item.dueDate.startsWith(month)).reduce((sum, item) => sum + item.amountCents, 0);
        const cardCents = installmentRows.filter((item) => item.status === "pending" && invoiceById.get(item.invoiceId)?.referenceMonth === month).reduce((sum, item) => sum + item.amountCents, 0);
        return { month, incomeCents, commitmentCents: plannedCashExpenses + billsCents + cardCents };
      });
      const result = simulatePurchase({ startMonth: currentMonth, availableCents, purchaseCents: parsed.purchaseCents, installmentCount: parsed.paymentMethod === "cash" ? 1 : parsed.installmentCount, firstImpactMonth, months });
      return NextResponse.json({ ...result, description: parsed.description, firstImpactMonth });
    }
    return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
  } catch (error) {
    if (error instanceof BillServiceError) return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
    if (error instanceof FinanceValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Dados inválidos.", details: error.flatten() }, { status: 400 });
    console.error("advanced_finance_failed", error); return NextResponse.json({ error: "Não foi possível concluir a operação." }, { status: 500 });
  }
}

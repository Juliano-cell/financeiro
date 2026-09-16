import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, cardInvoices, categories, creditCards, householdMembers, subcategories, telegramProcessedUpdates } from "@/db/schema";
import { buildInstallmentPlan } from "@/lib/finance-rules.mjs";
import { canInvoiceReceivePurchase, invoiceCivilDate, invoiceClosesOn } from "./invoice-service";

export class FinanceValidationError extends Error {}
export class DuplicateTelegramUpdateError extends Error {}

export function telegramFinancialOperationUpdateId(operationId: string) {
  return `financial:${operationId}`;
}

type Origin = "dashboard" | "telegram";
type AuditSource = { updateId?: string; operationId?: string; originalUpdateId?: string; originalText?: string; telegramUserId?: string };

type TransactionInput = {
  type: "income" | "expense";
  amountCents: number;
  description: string;
  categoryId?: string | null;
  subcategoryId?: string | null;
  transactionDate: string;
  transactionTime?: string | null;
  accountId: string;
  paymentMethod?: string | null;
  status?: "confirmed" | "pending" | "cancelled";
  notes?: string | null;
};

type CardPurchaseInput = {
  cardId: string;
  description: string;
  totalCents: number;
  purchaseDate: string;
  installmentCount: number;
  categoryId: string;
  subcategoryId?: string | null;
  notes?: string | null;
};

type CreationContext = {
  householdId: string;
  userId: string;
  origin: Origin;
  timestamp?: string;
  source?: AuditSource;
  clearTelegramStateFor?: string;
};

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const timestamp = () => new Date().toISOString();

function database() {
  if (!env.DB) throw new Error("D1 binding indisponível");
  return env.DB;
}

function assertText(value: string, label: string, maximum = 120) {
  if (!value.trim() || value.trim().length > maximum) throw new FinanceValidationError(`${label} inválida.`);
}

function assertMoney(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000_000) throw new FinanceValidationError("Valor inválido.");
}

function assertDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new FinanceValidationError("Data inválida.");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new FinanceValidationError("Data inválida.");
}

async function validateMembership(householdId: string, userId: string) {
  const db = getDb();
  const [membership] = await db.select({ id: householdMembers.id }).from(householdMembers).where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId), eq(householdMembers.status, "active"))).limit(1);
  if (!membership) throw new FinanceValidationError("Usuário não pertence mais a esta família.");
}

async function validateTransactionRelations(householdId: string, input: TransactionInput) {
  const db = getDb();
  const [account] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, input.accountId), eq(accounts.householdId, householdId), eq(accounts.isActive, true))).limit(1);
  if (!account) throw new FinanceValidationError("Conta inválida.");
  let category: typeof categories.$inferSelect | undefined;
  if (input.type === "expense" && !input.categoryId) throw new FinanceValidationError("Selecione uma categoria para a despesa.");
  if (input.categoryId) {
    [category] = await db.select().from(categories).where(and(eq(categories.id, input.categoryId), eq(categories.householdId, householdId), eq(categories.isActive, true))).limit(1);
    if (!category || (category.type !== input.type && category.type !== "both")) throw new FinanceValidationError("Categoria inválida para este lançamento.");
  }
  const categorySubcategories = category
    ? await db.select({ id: subcategories.id }).from(subcategories).where(and(eq(subcategories.householdId, householdId), eq(subcategories.categoryId, category.id), eq(subcategories.isActive, true)))
    : [];
  if (input.type === "expense" && categorySubcategories.length && !input.subcategoryId) throw new FinanceValidationError("Selecione uma subcategoria para esta despesa.");
  if (input.subcategoryId) {
    const [subcategory] = await db.select().from(subcategories).where(and(eq(subcategories.id, input.subcategoryId), eq(subcategories.householdId, householdId), eq(subcategories.isActive, true))).limit(1);
    if (!subcategory || !category || subcategory.categoryId !== category.id) throw new FinanceValidationError("Subcategoria inválida.");
  }
}

function sourcePayload(input: unknown, context: CreationContext) {
  const source = context.source ? {
    telegramUpdateId: context.source.updateId,
    originalTelegramUpdateId: context.source.originalUpdateId,
    telegramUserId: context.source.telegramUserId,
    originalText: context.source.originalText?.slice(0, 1_000),
  } : undefined;
  return JSON.stringify({ input, ...(source ? { source } : {}) });
}

function idempotencyStatements(context: CreationContext, at: string) {
  const d1 = database();
  const statements: D1PreparedStatement[] = [];
  if (context.source?.updateId) statements.push(d1.prepare("INSERT INTO telegram_processed_updates (update_id, received_at) VALUES (?, ?)").bind(context.source.updateId, at));
  if (context.source?.operationId) statements.push(d1.prepare("INSERT INTO telegram_processed_updates (update_id, received_at) VALUES (?, ?)").bind(telegramFinancialOperationUpdateId(context.source.operationId), at));
  return statements;
}

function finalizeStatements(statements: D1PreparedStatement[], context: CreationContext) {
  if (context.clearTelegramStateFor) statements.push(database().prepare("DELETE FROM telegram_conversation_states WHERE telegram_user_id = ? AND household_id = ?").bind(context.clearTelegramStateFor, context.householdId));
  return statements;
}

function telegramCardSessionGuardStatements(context: CreationContext, at: string) {
  if (!context.source?.updateId || !context.source.operationId || !context.clearTelegramStateFor) return [];
  return [database().prepare("INSERT INTO telegram_processed_updates (update_id, received_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM telegram_conversation_states WHERE telegram_user_id = ? AND household_id = ? AND json_extract(payload_json, '$.sessionId') = ?)").bind(context.source.updateId, at, context.clearTelegramStateFor, context.householdId, context.source.operationId)];
}

function finalizeCardStatements(statements: D1PreparedStatement[], context: CreationContext) {
  if (!context.clearTelegramStateFor) return statements;
  const operationId = context.source?.operationId;
  statements.push(operationId
    ? database().prepare("DELETE FROM telegram_conversation_states WHERE telegram_user_id = ? AND household_id = ? AND json_extract(payload_json, '$.sessionId') = ?").bind(context.clearTelegramStateFor, context.householdId, operationId)
    : database().prepare("DELETE FROM telegram_conversation_states WHERE telegram_user_id = ? AND household_id = ?").bind(context.clearTelegramStateFor, context.householdId));
  return statements;
}

async function runCreationBatch(statements: D1PreparedStatement[], updateId?: string) {
  const d1 = database();
  try {
    await d1.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (updateId && /telegram_processed_updates|UNIQUE constraint failed.*update_id/iu.test(message)) throw new DuplicateTelegramUpdateError("Update do Telegram já processado.");
    throw error;
  }
}

export async function isTelegramUpdateProcessed(updateId: string) {
  const db = getDb();
  const [processed] = await db.select({ updateId: telegramProcessedUpdates.updateId }).from(telegramProcessedUpdates).where(eq(telegramProcessedUpdates.updateId, updateId)).limit(1);
  return Boolean(processed);
}

export async function createTransaction(input: TransactionInput, context: CreationContext) {
  assertText(input.description, "Descrição");
  assertMoney(input.amountCents);
  assertDate(input.transactionDate);
  await validateMembership(context.householdId, context.userId);
  await validateTransactionRelations(context.householdId, input);
  const at = timestamp();
  const transactionId = uid("transaction");
  const auditId = uid("audit");
  const d1 = database();
  const statements = idempotencyStatements(context, at);
  statements.push(
    d1.prepare("INSERT INTO transactions (id, household_id, type, amount_cents, description, category_id, subcategory_id, transaction_date, transaction_time, responsible_user_id, account_id, payment_method, status, origin, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(transactionId, context.householdId, input.type, input.amountCents, input.description.trim(), input.categoryId ?? null, input.subcategoryId ?? null, input.transactionDate, input.transactionTime ?? null, context.userId, input.accountId, input.paymentMethod ?? null, input.status ?? "confirmed", context.origin, input.notes ?? null, at, at),
    d1.prepare("INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at) VALUES (?, ?, ?, 'create', 'transaction', ?, NULL, ?, ?)").bind(auditId, context.householdId, context.userId, transactionId, sourcePayload(input, context), at),
  );
  await runCreationBatch(finalizeStatements(statements, context), context.source?.updateId);
  return { id: transactionId };
}

export async function createCardPurchase(input: CardPurchaseInput, context: CreationContext) {
  assertText(input.description, "Descrição");
  assertMoney(input.totalCents);
  assertDate(input.purchaseDate);
  if (!Number.isInteger(input.installmentCount) || input.installmentCount < 1 || input.installmentCount > 120) throw new FinanceValidationError("Número de parcelas inválido.");
  if (input.installmentCount > input.totalCents) throw new FinanceValidationError("O valor é insuficiente para a quantidade de parcelas.");
  await validateMembership(context.householdId, context.userId);
  const db = getDb();
  const [card] = await db.select().from(creditCards).where(and(eq(creditCards.id, input.cardId), eq(creditCards.householdId, context.householdId), eq(creditCards.isActive, true))).limit(1);
  if (!card) throw new FinanceValidationError("Cartão inválido.");
  if (!input.categoryId) throw new FinanceValidationError("Selecione uma categoria para esta compra.");
  const [category] = await db.select().from(categories).where(and(eq(categories.id, input.categoryId), eq(categories.householdId, context.householdId), eq(categories.isActive, true))).limit(1);
  if (!category || (category.type !== "expense" && category.type !== "both")) throw new FinanceValidationError("Categoria inválida para esta compra.");
  const categorySubcategories = await db.select({ id: subcategories.id }).from(subcategories).where(and(eq(subcategories.householdId, context.householdId), eq(subcategories.categoryId, category.id), eq(subcategories.isActive, true)));
  if (categorySubcategories.length && !input.subcategoryId) throw new FinanceValidationError("Selecione uma subcategoria para esta compra.");
  if (input.subcategoryId && !categorySubcategories.some((subcategory) => subcategory.id === input.subcategoryId)) throw new FinanceValidationError("Subcategoria inválida para esta compra.");
  const plan = buildInstallmentPlan({ totalCents: input.totalCents, count: input.installmentCount, purchaseDate: input.purchaseDate, closingDay: card.closingDay, dueDay: card.dueDay });
  const months = [...new Set(plan.map((part: { referenceMonth: string }) => part.referenceMonth))];
  const existing = months.length ? await db.select().from(cardInvoices).where(and(eq(cardInvoices.householdId, context.householdId), eq(cardInvoices.cardId, card.id), inArray(cardInvoices.referenceMonth, months))) : [];
  const at = context.timestamp ?? timestamp();
  const today = invoiceCivilDate(at);
  const blockedInvoice = existing.find((invoice) => !canInvoiceReceivePurchase(invoice, today));
  if (blockedInvoice) throw new FinanceValidationError(`A fatura de ${blockedInvoice.referenceMonth} não está aberta e não pode receber novas parcelas.`);
  const purchaseId = uid("purchase");
  const d1 = database();
  const statements = idempotencyStatements(context, at);
  statements.push(...telegramCardSessionGuardStatements(context, at));
  statements.push(d1.prepare("INSERT INTO card_purchases (id, household_id, card_id, description, total_cents, purchase_date, installment_count, category_id, subcategory_id, notes, status, created_by_user_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)").bind(purchaseId, context.householdId, card.id, input.description.trim(), input.totalCents, input.purchaseDate, input.installmentCount, input.categoryId, input.subcategoryId ?? null, input.notes ?? null, context.userId, context.origin === "telegram" ? "telegram" : "web", at, at));
  for (const referenceMonth of months) {
    const part = plan.find((candidate: { referenceMonth: string }) => candidate.referenceMonth === referenceMonth)!;
    statements.push(d1.prepare("INSERT INTO card_invoices (id, household_id, card_id, reference_month, due_date, closes_on, status, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?) ON CONFLICT(household_id, card_id, reference_month) DO NOTHING").bind(uid("invoice"), context.householdId, card.id, referenceMonth, part.dueDate, invoiceClosesOn(referenceMonth, card.closingDay, card.dueDay), at, at));
  }
  for (const part of plan as Array<{ referenceMonth: string; dueDate: string; installmentNumber: number; installmentCount: number; amountCents: number }>) {
    statements.push(d1.prepare("INSERT INTO card_installments (id, household_id, purchase_id, invoice_id, installment_number, installment_count, amount_cents, status, created_at, updated_at) VALUES (?, ?, ?, (SELECT i.id FROM card_invoices i JOIN credit_cards c ON c.id = i.card_id AND c.household_id = i.household_id WHERE i.household_id = ? AND i.card_id = ? AND i.reference_month = ? AND i.status <> 'closed' AND i.closes_on IS NOT NULL AND i.closes_on >= ? AND c.is_active = 1 AND EXISTS (SELECT 1 FROM household_members m WHERE m.household_id = i.household_id AND m.user_id = ? AND m.status = 'active') LIMIT 1), ?, ?, ?, 'pending', ?, ?)").bind(uid("installment"), context.householdId, purchaseId, context.householdId, card.id, part.referenceMonth, today, context.userId, part.installmentNumber, part.installmentCount, part.amountCents, at, at));
  }
  statements.push(d1.prepare("INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at) VALUES (?, ?, ?, 'create', 'card_purchase', ?, NULL, ?, ?)").bind(uid("audit"), context.householdId, context.userId, purchaseId, sourcePayload(input, context), at));
  try {
    await runCreationBatch(finalizeCardStatements(statements, context), context.source?.updateId);
  } catch (error) {
    if (error instanceof DuplicateTelegramUpdateError) throw error;
    const currentInvoices = months.length ? await db.select().from(cardInvoices).where(and(eq(cardInvoices.householdId, context.householdId), eq(cardInvoices.cardId, card.id), inArray(cardInvoices.referenceMonth, months))) : [];
    const currentBlockedInvoice = currentInvoices.find((invoice) => !canInvoiceReceivePurchase(invoice, today));
    if (currentBlockedInvoice) throw new FinanceValidationError(`A fatura de ${currentBlockedInvoice.referenceMonth} não está aberta e não pode receber novas parcelas.`);
    throw error;
  }
  return { id: purchaseId, plan, cardName: card.name };
}

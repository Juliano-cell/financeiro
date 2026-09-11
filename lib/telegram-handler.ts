import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { accounts, categories, creditCards, householdMembers, invoicePayments, subcategories, telegramConversationStates, telegramLinks, transactions } from "@/db/schema";
import { createCardPurchase, createTransaction, DuplicateTelegramUpdateError, FinanceValidationError, isTelegramUpdateProcessed } from "@/lib/finance-service";
import { digestToken } from "@/lib/auth-crypto.mjs";
import { clearRateLimit, consumeRateLimit, RateLimitError } from "@/lib/rate-limit";
import { connectTelegramWithCode } from "@/lib/telegram-link-service";
import { mergeFinancialIntent, parseTelegramMessage } from "@/lib/telegram-parser.mjs";
import { formatBrl, type TelegramButton } from "@/lib/telegram";

const telegramId = z.union([z.number().int().safe(), z.string().regex(/^-?\d{1,20}$/u)]).transform(String);
const messageSchema = z.object({ text: z.string().trim().min(1).max(1_000), chat: z.object({ id: telegramId, type: z.string().max(30).optional() }).passthrough(), from: z.object({ id: telegramId }).passthrough() }).passthrough();
const callbackSchema = z.object({ id: z.string().min(1).max(200), data: z.enum(["confirmar", "alterar", "cancelar"]), from: z.object({ id: telegramId }).passthrough(), message: z.object({ chat: z.object({ id: telegramId, type: z.string().max(30).optional() }).passthrough() }).passthrough() }).passthrough();
export const telegramUpdateSchema = z.object({ update_id: z.number().int().nonnegative().safe(), message: messageSchema.optional(), callback_query: callbackSchema.optional() }).passthrough().refine((value) => Boolean(value.message || value.callback_query), "Update sem mensagem suportada.");

type FinancialIntent = {
  intent: string;
  type?: "income" | "expense" | null;
  amountCents?: number | null;
  description?: string | null;
  transactionDate?: string;
  installmentCount?: number;
  paymentMethod?: string | null;
  cardId?: string | null;
  accountId?: string | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
  missing?: string[];
  ambiguous?: boolean;
  ambiguity?: string | null;
};

type ConversationState = {
  phase: "collecting" | "confirming" | "altering";
  financialIntent: FinancialIntent;
  originalText: string;
  originalUpdateId: string;
};

export type TelegramHandlerResult = { text?: string; buttons?: TelegramButton[][]; duplicate?: boolean };

const confirmationButtons: TelegramButton[][] = [[
  { text: "✅ Confirmar", callback_data: "confirmar" },
  { text: "✏️ Alterar", callback_data: "alterar" },
  { text: "❌ Cancelar", callback_data: "cancelar" },
]];

function database() {
  if (!env.DB) throw new Error("D1 binding indisponível");
  return env.DB;
}

async function commitUpdate(updateId: string, statements: D1PreparedStatement[] = []) {
  const d1 = database();
  try {
    await d1.batch([d1.prepare("INSERT INTO telegram_processed_updates (update_id, received_at) VALUES (?, ?)").bind(updateId, new Date().toISOString()), ...statements]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/telegram_processed_updates|UNIQUE constraint failed.*update_id/iu.test(message)) throw new DuplicateTelegramUpdateError("Update do Telegram já processado.");
    throw error;
  }
}

async function saveState(updateId: string, telegramUserId: string, householdId: string, state: ConversationState) {
  const d1 = database();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await commitUpdate(updateId, [d1.prepare("INSERT INTO telegram_conversation_states (telegram_user_id, household_id, payload_json, expires_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(telegram_user_id) DO UPDATE SET household_id = excluded.household_id, payload_json = excluded.payload_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at").bind(telegramUserId, householdId, JSON.stringify(state), expiresAt, now)]);
}

async function cancelState(updateId: string, telegramUserId: string, householdId: string) {
  const d1 = database();
  await commitUpdate(updateId, [d1.prepare("DELETE FROM telegram_conversation_states WHERE telegram_user_id = ? AND household_id = ?").bind(telegramUserId, householdId)]);
}

function questionFor(missing: string[]) {
  if (missing.includes("valor")) return "Qual é o valor do lançamento?";
  if (missing.includes("descrição")) return "Em que foi o gasto ou de onde veio a entrada?";
  if (missing.includes("tipo")) return "Isso é uma despesa ou uma entrada?";
  if (missing.includes("cartão")) return "Em qual cartão deseja registrar?";
  if (missing.includes("conta")) return "Em qual conta deseja registrar?";
  return "Preciso de mais uma informação para continuar.";
}

function confirmationText(intent: FinancialIntent, accountName?: string, cardName?: string, categoryName?: string) {
  const kind = intent.type === "income" ? "Entrada" : intent.cardId ? "Compra no cartão" : "Despesa";
  const lines = [`${intent.type === "income" ? "💰" : intent.cardId ? "💳" : "🧾"} ${intent.description}`, `${kind}: ${formatBrl(intent.amountCents!)}`];
  if (categoryName) lines.push(`Categoria: ${categoryName}`);
  if (cardName) lines.push(`Cartão: ${cardName}${(intent.installmentCount ?? 1) > 1 ? ` · ${intent.installmentCount}x` : ""}`);
  else if (accountName) lines.push(`Conta: ${accountName}`);
  lines.push(`Data: ${intent.transactionDate}`, "", "Confirmar lançamento?");
  return lines.join("\n");
}

async function loadHouseholdContext(householdId: string) {
  const db = getDb();
  const [accountRows, cardRows, categoryRows, subcategoryRows] = await Promise.all([
    db.select().from(accounts).where(and(eq(accounts.householdId, householdId), eq(accounts.isActive, true))),
    db.select().from(creditCards).where(and(eq(creditCards.householdId, householdId), eq(creditCards.isActive, true))),
    db.select().from(categories).where(and(eq(categories.householdId, householdId), eq(categories.isActive, true))),
    db.select().from(subcategories).where(and(eq(subcategories.householdId, householdId), eq(subcategories.isActive, true))),
  ]);
  return { accounts: accountRows, cards: cardRows, categories: categoryRows, subcategories: subcategoryRows };
}

function prepareIntent(intent: FinancialIntent, context: Awaited<ReturnType<typeof loadHouseholdContext>>) {
  const prepared = { ...intent };
  const missing = new Set(prepared.missing ?? []);
  if (prepared.paymentMethod === "credit_card") {
    if (!prepared.cardId) {
      if (context.cards.length === 1) prepared.cardId = context.cards[0].id;
      else missing.add("cartão");
    }
    prepared.accountId = null;
  } else if (!prepared.accountId) {
    const candidates = prepared.paymentMethod === "cash" ? context.accounts.filter((account) => account.type === "cash") : prepared.paymentMethod === "debit" ? context.accounts.filter((account) => account.type === "bank") : context.accounts;
    if (candidates.length === 1) prepared.accountId = candidates[0].id;
    else missing.add("conta");
  }
  prepared.missing = [...missing];
  prepared.ambiguous = prepared.missing.length > 0;
  return prepared;
}

async function balanceText(householdId: string) {
  const db = getDb();
  const [accountRows, transactionRows, paymentRows] = await Promise.all([
    db.select().from(accounts).where(and(eq(accounts.householdId, householdId), eq(accounts.isActive, true))),
    db.select().from(transactions).where(and(eq(transactions.householdId, householdId), eq(transactions.status, "confirmed"))),
    db.select().from(invoicePayments).where(eq(invoicePayments.householdId, householdId)),
  ]);
  const balance = accountRows.reduce((sum, account) => sum + account.initialBalanceCents + transactionRows.filter((item) => item.accountId === account.id).reduce((value, item) => value + (item.type === "income" ? item.amountCents : -item.amountCents), 0) - paymentRows.filter((item) => item.accountId === account.id).reduce((value, item) => value + item.amountCents, 0), 0);
  return `Saldo das contas: ${formatBrl(balance)}`;
}

export async function handleTelegramUpdate(rawUpdate: unknown): Promise<TelegramHandlerResult> {
  const update = telegramUpdateSchema.parse(rawUpdate);
  const updateId = String(update.update_id);
  if (await isTelegramUpdateProcessed(updateId)) return { duplicate: true };
  const telegramUserId = update.message?.from.id ?? update.callback_query?.from.id ?? "";
  const chat = update.message?.chat ?? update.callback_query?.message.chat;
  const chatId = chat?.id ?? "";
  const text = update.message?.text ?? update.callback_query?.data ?? "";
  if (!telegramUserId || !chatId) throw new FinanceValidationError("Identificadores Telegram inválidos.");
  if (chat?.type && chat.type !== "private") {
    await commitUpdate(updateId);
    return { text: "Por segurança, use este bot somente em uma conversa privada." };
  }

  const command = parseTelegramMessage(text) as FinancialIntent & { code?: string };
  if (command.intent === "connect") {
    const attemptKey = `telegram-code-connect:${await digestToken(telegramUserId)}`;
    try {
      await consumeRateLimit(attemptKey, 5, 10 * 60_000, 15 * 60_000);
    } catch (error) {
      if (error instanceof RateLimitError) {
        await commitUpdate(updateId);
        return { text: "Muitas tentativas. Aguarde 15 minutos antes de tentar novamente." };
      }
      throw error;
    }
    const result = await connectTelegramWithCode({ code: command.code!, telegramUserId, chatId, updateId });
    if (result.linked) {
      try { await clearRateLimit(attemptKey); } catch { console.error("telegram_rate_limit_cleanup_failed"); }
      return { text: "✅ Telegram conectado com segurança à sua família." };
    }
    if (result.reason === "conflict") return { text: "Esta conta Telegram já está vinculada a outro usuário ou família." };
    if (result.reason === "inactive_member") return { text: "O usuário desse código não é mais membro ativo da família." };
    return { text: "Código inválido, expirado ou já utilizado." };
  }
  if (command.intent === "start" || command.intent === "help") {
    await commitUpdate(updateId);
    return { text: "Olá! Para conectar sua conta, gere um código em Configurações > Telegram e envie /conectar CÓDIGO.\n\nDepois, envie mensagens como:\n• Gastei 85 no mercado\n• Recebi 200 hoje\n\nUse /ajuda sempre que precisar." };
  }

  const db = getDb();
  const [link] = await db.select().from(telegramLinks).where(and(eq(telegramLinks.telegramUserId, telegramUserId), eq(telegramLinks.chatId, chatId), eq(telegramLinks.isActive, true))).limit(1);
  if (!link) {
    await commitUpdate(updateId);
    return { text: "Seu Telegram ainda não está conectado. Gere um código em Configurações > Telegram no site." };
  }
  const [membership] = await db.select({ id: householdMembers.id }).from(householdMembers).where(and(eq(householdMembers.householdId, link.householdId), eq(householdMembers.userId, link.userId), eq(householdMembers.status, "active"))).limit(1);
  if (!membership) {
    await commitUpdate(updateId);
    return { text: "Seu acesso à família não está ativo. Entre no site para verificar a conta." };
  }

  const [stored] = await db.select().from(telegramConversationStates).where(and(eq(telegramConversationStates.telegramUserId, telegramUserId), eq(telegramConversationStates.householdId, link.householdId))).limit(1);
  let state: ConversationState | null = null;
  if (stored && stored.expiresAt > new Date().toISOString()) {
    try { state = JSON.parse(stored.payloadJson) as ConversationState; } catch { state = null; }
  } else if (stored) {
    await db.delete(telegramConversationStates).where(and(eq(telegramConversationStates.telegramUserId, telegramUserId), eq(telegramConversationStates.householdId, link.householdId)));
  }

  if (command.intent === "cancel") {
    await cancelState(updateId, telegramUserId, link.householdId);
    return { text: "Operação cancelada. Nenhum lançamento foi criado." };
  }
  if (command.intent === "alter") {
    if (!state) {
      await commitUpdate(updateId);
      return { text: "Não há lançamento aguardando alteração." };
    }
    await saveState(updateId, telegramUserId, link.householdId, { ...state, phase: "altering" });
    return { text: "Envie novamente o lançamento com os dados corrigidos. Exemplo: “Gastei 85 no mercado ontem”." };
  }
  if (command.intent === "confirm") {
    if (!state || state.phase !== "confirming") {
      await commitUpdate(updateId);
      return { text: "Não há lançamento aguardando confirmação." };
    }
    const intent = state.financialIntent;
    const source = { updateId, originalUpdateId: state.originalUpdateId, originalText: state.originalText, telegramUserId };
    if (intent.cardId) {
      const result = await createCardPurchase({ cardId: intent.cardId, description: intent.description!, totalCents: intent.amountCents!, purchaseDate: intent.transactionDate!, installmentCount: intent.installmentCount ?? 1, categoryId: intent.categoryId }, { householdId: link.householdId, userId: link.userId, origin: "telegram", source, clearTelegramStateFor: telegramUserId });
      return { text: `✅ Compra de ${formatBrl(intent.amountCents!)} registrada no cartão ${result.cardName}.` };
    }
    await createTransaction({ type: intent.type!, amountCents: intent.amountCents!, description: intent.description!, categoryId: intent.categoryId, subcategoryId: intent.subcategoryId, transactionDate: intent.transactionDate!, accountId: intent.accountId!, paymentMethod: intent.paymentMethod, status: "confirmed" }, { householdId: link.householdId, userId: link.userId, origin: "telegram", source, clearTelegramStateFor: telegramUserId });
    return { text: `✅ ${intent.type === "income" ? "Entrada" : "Despesa"} de ${formatBrl(intent.amountCents!)} registrada.` };
  }
  if (/^\/saldo(?:@\w+)?$/iu.test(text) || command.intent === "query" && (command as FinancialIntent & { query?: string }).query === "balance") {
    const reply = await balanceText(link.householdId);
    await commitUpdate(updateId);
    return { text: reply };
  }

  const context = await loadHouseholdContext(link.householdId);
  let parsed = parseTelegramMessage(text, context) as FinancialIntent;
  if (state?.phase === "collecting") parsed = mergeFinancialIntent(state.financialIntent, parsed) as FinancialIntent;
  if (state?.phase === "altering") state = null;
  if (parsed.intent !== "transaction" && !state) {
    await commitUpdate(updateId);
    return { text: "Não entendi com segurança. Envie, por exemplo: “Gastei 85 no mercado” ou use /ajuda." };
  }
  const prepared = prepareIntent(parsed, context);
  const originalText = state?.originalText ?? text;
  const originalUpdateId = state?.originalUpdateId ?? updateId;
  if (prepared.missing?.length) {
    await saveState(updateId, telegramUserId, link.householdId, { phase: "collecting", financialIntent: prepared, originalText, originalUpdateId });
    const choices = prepared.missing.includes("conta") ? `\n\nContas disponíveis:\n${context.accounts.map((item) => `• ${item.name}`).join("\n")}` : prepared.missing.includes("cartão") ? `\n\nCartões disponíveis:\n${context.cards.map((item) => `• ${item.name}`).join("\n")}` : "";
    return { text: `${questionFor(prepared.missing)}${choices}\n\nEnvie “Cancelar” para interromper.` };
  }
  const selectedAccount = context.accounts.find((item) => item.id === prepared.accountId);
  const selectedCard = context.cards.find((item) => item.id === prepared.cardId);
  const selectedSubcategory = context.subcategories.find((item) => item.id === prepared.subcategoryId);
  const selectedCategory = context.categories.find((item) => item.id === prepared.categoryId);
  const reply = confirmationText(prepared, selectedAccount?.name, selectedCard?.name, selectedSubcategory?.name ?? selectedCategory?.name);
  await saveState(updateId, telegramUserId, link.householdId, { phase: "confirming", financialIntent: prepared, originalText, originalUpdateId });
  return { text: reply, buttons: confirmationButtons };
}

export function isTelegramPayloadTooLarge(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  return Number.isFinite(contentLength) && contentLength > 16_384;
}

export function isDuplicateTelegramError(error: unknown) {
  return error instanceof DuplicateTelegramUpdateError;
}

import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { accounts, categories, creditCards, householdMembers, invoicePayments, subcategories, telegramConversationStates, telegramLinks, transactions } from "@/db/schema";
import { createCardPurchase, createTransaction, DuplicateTelegramUpdateError, FinanceValidationError, isTelegramUpdateProcessed } from "@/lib/finance-service";
import { parseBrazilianMoney } from "@/lib/finance-rules.mjs";
import { digestToken } from "@/lib/auth-crypto.mjs";
import { clearRateLimit, consumeRateLimit, RateLimitError } from "@/lib/rate-limit";
import { connectTelegramWithCode } from "@/lib/telegram-link-service";
import { dateInSaoPaulo, parseTelegramMessage } from "@/lib/telegram-parser.mjs";
import { paginateTelegramOptions, parseTelegramCallback, resolveTelegramSelection, telegramConfirmationButtons, telegramEditButtons, telegramSelectionButtons, updateTelegramIntentField } from "@/lib/telegram-conversation.mjs";
import { formatBrl, type TelegramButton } from "@/lib/telegram";

const telegramId = z.union([z.number().int().safe(), z.string().regex(/^-?\d{1,20}$/u)]).transform(String);
const messageSchema = z.object({ text: z.string().trim().min(1).max(1_000), chat: z.object({ id: telegramId, type: z.string().max(30).optional() }).passthrough(), from: z.object({ id: telegramId }).passthrough() }).passthrough();
const callbackSchema = z.object({ id: z.string().min(1).max(200), data: z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/u), from: z.object({ id: telegramId }).passthrough(), message: z.object({ chat: z.object({ id: telegramId, type: z.string().max(30).optional() }).passthrough() }).passthrough() }).passthrough();
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
  subcategorySkipped?: boolean;
  missing?: string[];
  ambiguous?: boolean;
  ambiguity?: string | null;
};

const financialIntentSchema = z.object({
  intent: z.string(), type: z.enum(["income", "expense"]).nullable().optional(), amountCents: z.number().int().positive().nullable().optional(), description: z.string().max(120).nullable().optional(), transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(), installmentCount: z.number().int().min(1).max(120).optional(), paymentMethod: z.string().max(30).nullable().optional(), cardId: z.string().max(80).nullable().optional(), accountId: z.string().max(80).nullable().optional(), categoryId: z.string().max(80).nullable().optional(), subcategoryId: z.string().max(80).nullable().optional(), subcategorySkipped: z.boolean().optional(), missing: z.array(z.string().max(30)).max(10).optional(), ambiguous: z.boolean().optional(), ambiguity: z.string().max(40).nullable().optional(),
}).passthrough();

const conversationStateSchema = z.object({
  phase: z.enum(["collecting", "confirming", "choosing_edit_field", "editing_value", "editing_description", "editing_date", "selecting_account", "selecting_card", "selecting_category", "selecting_subcategory", "altering"]),
  financialIntent: financialIntentSchema,
  originalText: z.string().max(1_000),
  originalUpdateId: z.string().max(30),
  field: z.enum(["tipo", "valor", "descrição", "conta", "cartão", "categoria", "subcategoria"]).optional(),
  page: z.number().int().min(0).max(10_000).optional(),
  mode: z.enum(["create", "edit"]).optional(),
}).passthrough();

type ConversationState = z.infer<typeof conversationStateSchema>;
type HouseholdContext = Awaited<ReturnType<typeof loadHouseholdContext>>;
type ChoiceKind = "account" | "card" | "category" | "subcategory";
type MissingField = "tipo" | "valor" | "descrição" | "conta" | "cartão" | "categoria" | "subcategoria";

export type TelegramHandlerResult = { text?: string; buttons?: TelegramButton[][]; duplicate?: boolean };

const cancelButtons: TelegramButton[][] = [[{ text: "❌ Cancelar", callback_data: "cancel" }]];
const phaseByKind = { account: "selecting_account", card: "selecting_card", category: "selecting_category", subcategory: "selecting_subcategory" } as const;
const kindByPhase: Partial<Record<ConversationState["phase"], ChoiceKind>> = { selecting_account: "account", selecting_card: "card", selecting_category: "category", selecting_subcategory: "subcategory" };

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

function questionFor(field: string, intent: FinancialIntent) {
  if (field === "valor") return intent.type === "income" ? "Qual é o valor dessa entrada?" : intent.type === "expense" ? "Qual é o valor desse gasto?" : "Qual é o valor do lançamento?";
  if (field === "descrição") return intent.type === "income" ? "De onde veio essa entrada?" : intent.type === "expense" ? "Em que foi esse gasto?" : "Qual é a descrição do lançamento?";
  if (field === "tipo") return "Isso é uma despesa ou uma entrada?";
  if (field === "cartão") return "Em qual cartão deseja registrar?";
  if (field === "conta") return "Em qual conta deseja registrar?";
  if (field === "categoria") return "Qual é a categoria desse lançamento?";
  if (field === "subcategoria") return "Qual é a subcategoria desse lançamento?";
  return "Preciso de mais uma informação para continuar.";
}

function confirmationText(intent: FinancialIntent, accountName?: string, cardName?: string, categoryName?: string, subcategoryName?: string) {
  const kind = intent.type === "income" ? "Entrada" : intent.cardId ? "Compra no cartão" : "Despesa";
  const lines = [`${intent.type === "income" ? "💰" : intent.cardId ? "💳" : "🧾"} ${intent.description}`, `${kind}: ${formatBrl(intent.amountCents!)}`];
  if (categoryName) lines.push(`Categoria: ${categoryName}`);
  if (subcategoryName) lines.push(`Subcategoria: ${subcategoryName}`);
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

function eligibleAccounts(intent: FinancialIntent, context: HouseholdContext) {
  if (intent.paymentMethod === "cash") return context.accounts.filter((account) => account.type === "cash");
  if (intent.paymentMethod === "debit") return context.accounts.filter((account) => account.type === "bank");
  return context.accounts;
}

function eligibleCategories(intent: FinancialIntent, context: HouseholdContext) {
  return context.categories.filter((category) => category.type === intent.type || category.type === "both");
}

function eligibleSubcategories(intent: FinancialIntent, context: HouseholdContext) {
  if (!intent.categoryId || intent.cardId) return [];
  return context.subcategories.filter((subcategory) => subcategory.categoryId === intent.categoryId);
}

function selectionItems(kind: ChoiceKind, intent: FinancialIntent, context: HouseholdContext) {
  if (kind === "account") return eligibleAccounts(intent, context);
  if (kind === "card") return context.cards;
  if (kind === "category") return eligibleCategories(intent, context);
  return eligibleSubcategories(intent, context);
}

function prepareIntent(intent: FinancialIntent, context: HouseholdContext) {
  const prepared = { ...intent };
  const missing = new Set<string>();
  if (typeof prepared.amountCents !== "number" || !Number.isSafeInteger(prepared.amountCents) || prepared.amountCents < 1 || prepared.amountCents > 100_000_000_000) prepared.amountCents = null;
  if (prepared.description && prepared.description.trim().length > 120) prepared.description = null;
  if (!prepared.type) missing.add("tipo");
  if (!prepared.amountCents) missing.add("valor");
  if (!prepared.description) missing.add("descrição");

  if (prepared.paymentMethod === "credit_card") {
    if (prepared.cardId && !context.cards.some((card) => card.id === prepared.cardId)) prepared.cardId = null;
    if (!prepared.cardId) {
      if (context.cards.length === 1) prepared.cardId = context.cards[0].id;
      else missing.add("cartão");
    }
    prepared.accountId = null;
  } else {
    const candidates = eligibleAccounts(prepared, context);
    if (prepared.accountId && !candidates.some((account) => account.id === prepared.accountId)) prepared.accountId = null;
    if (!prepared.accountId) {
      if (candidates.length === 1) prepared.accountId = candidates[0].id;
      else missing.add("conta");
    }
    prepared.cardId = null;
  }

  const categoryCandidates = prepared.type ? eligibleCategories(prepared, context) : [];
  if (prepared.categoryId && !categoryCandidates.some((category) => category.id === prepared.categoryId)) {
    prepared.categoryId = null;
    prepared.subcategoryId = null;
    prepared.subcategorySkipped = false;
  }
  if (prepared.type === "expense" && !prepared.categoryId) missing.add("categoria");
  else if (prepared.type && categoryCandidates.length && !prepared.categoryId) missing.add("categoria");
  if (prepared.categoryId && !prepared.cardId) {
    const subcategoryCandidates = eligibleSubcategories(prepared, context);
    if (prepared.subcategoryId && !subcategoryCandidates.some((subcategory) => subcategory.id === prepared.subcategoryId)) prepared.subcategoryId = null;
    if (subcategoryCandidates.length && !prepared.subcategoryId) missing.add("subcategoria");
  }
  prepared.missing = [...missing];
  prepared.ambiguous = missing.size > 0;
  return prepared;
}

function firstMissing(intent: FinancialIntent): MissingField | undefined {
  const order: MissingField[] = ["tipo", "valor", "descrição", "cartão", "conta", "categoria", "subcategoria"];
  return order.find((field) => intent.missing?.includes(field));
}

function selectionResponse(kind: ChoiceKind, state: ConversationState, context: HouseholdContext, prefix?: string): TelegramHandlerResult {
  const items = selectionItems(kind, state.financialIntent, context);
  const page = paginateTelegramOptions(items, state.page ?? 0);
  const field = kind === "account" ? "conta" : kind === "card" ? "cartão" : kind === "category" ? "categoria" : "subcategoria";
  const message = items.length ? `${prefix ? `${prefix}\n\n` : ""}${questionFor(field, state.financialIntent)}${page.totalPages > 1 ? ` Página ${page.page + 1} de ${page.totalPages}.` : ""}` : `Nenhuma ${field} ativa está disponível para este lançamento.`;
  return { text: message, buttons: telegramSelectionButtons(kind, items, page.page, { allowNone: false, allowCategoryBack: kind === "subcategory" }) };
}

async function presentIntent(updateId: string, telegramUserId: string, householdId: string, baseState: ConversationState, context: HouseholdContext, prefix?: string): Promise<TelegramHandlerResult> {
  const intent = prepareIntent(baseState.financialIntent, context);
  const missing = firstMissing(intent);
  if (missing) {
    const kind = missing === "conta" ? "account" : missing === "cartão" ? "card" : missing === "categoria" ? "category" : missing === "subcategoria" ? "subcategory" : null;
    const state: ConversationState = kind
      ? { ...baseState, phase: phaseByKind[kind], financialIntent: intent, field: missing, page: 0 }
      : { ...baseState, phase: "collecting", financialIntent: intent, field: missing, page: 0 };
    const reply = kind ? selectionResponse(kind, state, context, prefix) : { text: `${prefix ? `${prefix}\n\n` : ""}${questionFor(missing, intent)}`, buttons: cancelButtons };
    await saveState(updateId, telegramUserId, householdId, state);
    return reply;
  }

  const selectedAccount = context.accounts.find((item) => item.id === intent.accountId);
  const selectedCard = context.cards.find((item) => item.id === intent.cardId);
  const selectedSubcategory = context.subcategories.find((item) => item.id === intent.subcategoryId);
  const selectedCategory = context.categories.find((item) => item.id === intent.categoryId);
  const reply = confirmationText(intent, selectedAccount?.name, selectedCard?.name, selectedCategory?.name, selectedSubcategory?.name);
  const state: ConversationState = { ...baseState, phase: "confirming", financialIntent: intent, field: undefined, page: 0 };
  await saveState(updateId, telegramUserId, householdId, state);
  return { text: `${prefix ? `${prefix}\n\n` : ""}${reply}`, buttons: telegramConfirmationButtons };
}

function parseEditedDate(text: string) {
  const normalized = text.trim().toLocaleLowerCase("pt-BR");
  if (normalized === "hoje") return dateInSaoPaulo();
  if (normalized === "ontem") return dateInSaoPaulo(new Date(), -1);
  if (normalized === "anteontem") return dateInSaoPaulo(new Date(), -2);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) return null;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized ? null : normalized;
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
  const callback = update.callback_query ? parseTelegramCallback(text) : null;
  const command = update.message ? parseTelegramMessage(text) as FinancialIntent & { code?: string; query?: string } : null;
  if (!telegramUserId || !chatId) throw new FinanceValidationError("Identificadores Telegram inválidos.");
  if (chat?.type && chat.type !== "private") {
    await commitUpdate(updateId);
    return { text: "Por segurança, use este bot somente em uma conversa privada." };
  }

  if (command?.intent === "connect") {
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
  if (command?.intent === "start" || command?.intent === "help") {
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
    try {
      const parsedState = conversationStateSchema.safeParse(JSON.parse(stored.payloadJson));
      if (parsedState.success) state = parsedState.data.phase === "altering" ? { ...parsedState.data, phase: "choosing_edit_field" } : parsedState.data;
    } catch { state = null; }
  } else if (stored) {
    await db.delete(telegramConversationStates).where(and(eq(telegramConversationStates.telegramUserId, telegramUserId), eq(telegramConversationStates.householdId, link.householdId)));
  }

  const context = await loadHouseholdContext(link.householdId);
  const action = callback?.action ?? command?.intent;
  if (action === "cancel") {
    await cancelState(updateId, telegramUserId, link.householdId);
    return { text: "Operação cancelada. Nenhum lançamento foi criado." };
  }
  if (action === "alter") {
    if (!state || state.phase !== "confirming") {
      await commitUpdate(updateId);
      return { text: "Não há lançamento aguardando alteração." };
    }
    const intent = prepareIntent(state.financialIntent, context);
    const hasSubcategories = eligibleSubcategories(intent, context).length > 0;
    const nextState: ConversationState = { ...state, phase: "choosing_edit_field", financialIntent: intent, mode: "edit", page: 0 };
    const buttons = telegramEditButtons({ isCard: Boolean(intent.cardId), hasSubcategories });
    await saveState(updateId, telegramUserId, link.householdId, nextState);
    return { text: "Qual campo deseja alterar?", buttons };
  }
  if (action === "confirm") {
    if (!state || state.phase !== "confirming") {
      await commitUpdate(updateId);
      return { text: "Não há lançamento aguardando confirmação." };
    }
    const intent = prepareIntent(state.financialIntent, context);
    const selectionChanged = intent.accountId !== state.financialIntent.accountId || intent.cardId !== state.financialIntent.cardId || intent.categoryId !== state.financialIntent.categoryId || intent.subcategoryId !== state.financialIntent.subcategoryId;
    if (intent.missing?.length || selectionChanged) return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context, "Alguns dados mudaram; confirme novamente a seleção.");
    const source = { updateId, originalUpdateId: state.originalUpdateId, originalText: state.originalText, telegramUserId };
    if (intent.cardId) {
      const result = await createCardPurchase({ cardId: intent.cardId, description: intent.description!, totalCents: intent.amountCents!, purchaseDate: intent.transactionDate!, installmentCount: intent.installmentCount ?? 1, categoryId: intent.categoryId }, { householdId: link.householdId, userId: link.userId, origin: "telegram", source, clearTelegramStateFor: telegramUserId });
      return { text: `✅ Compra de ${formatBrl(intent.amountCents!)} registrada no cartão ${result.cardName}.` };
    }
    await createTransaction({ type: intent.type!, amountCents: intent.amountCents!, description: intent.description!, categoryId: intent.categoryId, subcategoryId: intent.subcategoryId, transactionDate: intent.transactionDate!, accountId: intent.accountId!, paymentMethod: intent.paymentMethod, status: "confirmed" }, { householdId: link.householdId, userId: link.userId, origin: "telegram", source, clearTelegramStateFor: telegramUserId });
    return { text: `✅ ${intent.type === "income" ? "Entrada" : "Despesa"} de ${formatBrl(intent.amountCents!)} registrada.` };
  }
  if (command?.intent === "query" && command.query === "balance" || /^\/saldo(?:@\w+)?$/iu.test(text)) {
    const reply = await balanceText(link.householdId);
    await commitUpdate(updateId);
    return { text: reply };
  }

  if (callback?.action === "edit-field") {
    if (!state || state.phase !== "choosing_edit_field") {
      await commitUpdate(updateId);
      return { text: "Essa opção de alteração não está mais disponível." };
    }
    const field = callback.field as "value" | "description" | "account" | "card" | "category" | "subcategory" | "date";
    if (field === "value" || field === "description" || field === "date") {
      const phase = field === "value" ? "editing_value" : field === "description" ? "editing_description" : "editing_date";
      const prompt = field === "value" ? "Envie somente o novo valor." : field === "description" ? questionFor("descrição", state.financialIntent) : "Envie a nova data no formato AAAA-MM-DD, ou escreva hoje, ontem ou anteontem.";
      await saveState(updateId, telegramUserId, link.householdId, { ...state, phase, page: 0 });
      return { text: prompt, buttons: cancelButtons };
    }
    const kind = field as ChoiceKind;
    const nextState: ConversationState = { ...state, phase: phaseByKind[kind], page: 0, mode: "edit" };
    const reply = selectionResponse(kind, nextState, context);
    await saveState(updateId, telegramUserId, link.householdId, nextState);
    return reply;
  }

  if (callback?.action === "page") {
    const kind = callback.kind as ChoiceKind;
    if (!state || kindByPhase[state.phase] !== kind) {
      await commitUpdate(updateId);
      return { text: "Essa página de opções não está mais disponível." };
    }
    const items = selectionItems(kind, state.financialIntent, context);
    const page = paginateTelegramOptions(items, callback.page).page;
    const nextState: ConversationState = { ...state, page };
    const reply = selectionResponse(kind, nextState, context);
    await saveState(updateId, telegramUserId, link.householdId, nextState);
    return reply;
  }

  if (callback?.action === "back" && callback.kind === "category") {
    if (!state || state.phase !== "selecting_subcategory") {
      await commitUpdate(updateId);
      return { text: "Não há seleção de categoria ativa." };
    }
    const intent = updateTelegramIntentField(state.financialIntent, "category", null) as FinancialIntent;
    const nextState: ConversationState = { ...state, phase: "selecting_category", financialIntent: intent, field: "categoria", page: 0 };
    const reply = selectionResponse("category", nextState, context);
    await saveState(updateId, telegramUserId, link.householdId, nextState);
    return reply;
  }

  if (callback?.action === "select") {
    const kind = callback.kind as ChoiceKind;
    if (!state || kindByPhase[state.phase] !== kind) {
      await commitUpdate(updateId);
      return { text: "Essa seleção não está mais disponível." };
    }
    const items = selectionItems(kind, state.financialIntent, context);
    const selected = resolveTelegramSelection(items, callback.id);
    if (!selected) {
      const reply = selectionResponse(kind, state, context, "A opção escolhida é inválida ou não pertence mais à sua família.");
      await saveState(updateId, telegramUserId, link.householdId, state);
      return reply;
    }
    const field = kind === "account" ? "account" : kind === "card" ? "card" : kind === "category" ? "category" : "subcategory";
    const intent = updateTelegramIntentField(state.financialIntent, field, selected.id) as FinancialIntent;
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent, page: 0 }, context);
  }

  if (callback) {
    await commitUpdate(updateId);
    return { text: "Essa opção não é válida ou expirou." };
  }

  if (state?.phase === "editing_value") {
    let amountCents: number;
    try { amountCents = parseBrazilianMoney(text); } catch {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: "Não reconheci o valor. Envie, por exemplo, 85 ou 85,50.", buttons: cancelButtons };
    }
    if (amountCents < 1) {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: "O valor deve ser maior que zero.", buttons: cancelButtons };
    }
    const intent = updateTelegramIntentField(state.financialIntent, "value", amountCents) as FinancialIntent;
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context);
  }
  if (state?.phase === "editing_description") {
    const description = text.trim();
    if (!description || description.length > 120) {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: "A descrição deve ter entre 1 e 120 caracteres.", buttons: cancelButtons };
    }
    const intent = updateTelegramIntentField(state.financialIntent, "description", description) as FinancialIntent;
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context);
  }
  if (state?.phase === "editing_date") {
    const date = parseEditedDate(text);
    if (!date) {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: "Data inválida. Use AAAA-MM-DD, hoje, ontem ou anteontem.", buttons: cancelButtons };
    }
    const intent = updateTelegramIntentField(state.financialIntent, "date", date) as FinancialIntent;
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context);
  }
  if (state?.phase === "collecting") {
    let intent = state.financialIntent;
    if (state.field === "valor") {
      try { intent = updateTelegramIntentField(intent, "value", parseBrazilianMoney(text)) as FinancialIntent; } catch {
        await saveState(updateId, telegramUserId, link.householdId, state);
        return { text: "Não reconheci o valor. Envie, por exemplo, 85 ou 85,50.", buttons: cancelButtons };
      }
    } else if (state.field === "descrição") {
      const description = text.trim();
      if (!description || description.length > 120) {
        await saveState(updateId, telegramUserId, link.householdId, state);
        return { text: "A descrição deve ter entre 1 e 120 caracteres.", buttons: cancelButtons };
      }
      intent = updateTelegramIntentField(intent, "description", description) as FinancialIntent;
    } else if (state.field === "tipo") {
      const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("pt-BR");
      if (/\b(receita|entrada)\b/u.test(normalized)) intent = { ...intent, type: "income" };
      else if (/\b(despesa|gasto)\b/u.test(normalized)) intent = { ...intent, type: "expense" };
      else {
        await saveState(updateId, telegramUserId, link.householdId, state);
        return { text: "Responda despesa ou entrada.", buttons: cancelButtons };
      }
    } else {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: "Use os botões para escolher essa opção.", buttons: cancelButtons };
    }
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context);
  }
  if (state && (state.phase === "choosing_edit_field" || Boolean(kindByPhase[state.phase]))) {
    const buttons = state.phase === "choosing_edit_field"
      ? telegramEditButtons({ isCard: Boolean(state.financialIntent.cardId), hasSubcategories: eligibleSubcategories(state.financialIntent, context).length > 0 })
      : telegramSelectionButtons(kindByPhase[state.phase]!, selectionItems(kindByPhase[state.phase]!, state.financialIntent, context), state.page ?? 0, { allowNone: false, allowCategoryBack: state.phase === "selecting_subcategory" });
    await saveState(updateId, telegramUserId, link.householdId, state);
    return { text: "Use os botões da mensagem para continuar ou cancelar.", buttons };
  }
  if (state?.phase === "confirming") return presentIntent(updateId, telegramUserId, link.householdId, state, context, "Use os botões abaixo para confirmar, alterar ou cancelar.");

  const parsed = parseTelegramMessage(text, context) as FinancialIntent;
  if (parsed.intent !== "transaction") {
    await commitUpdate(updateId);
    return { text: "Não entendi com segurança. Envie, por exemplo: “Gastei 85 no mercado” ou use /ajuda." };
  }
  const initialState: ConversationState = { phase: "collecting", financialIntent: parsed, originalText: text, originalUpdateId: updateId, mode: "create", page: 0 };
  return presentIntent(updateId, telegramUserId, link.householdId, initialState, context);
}

export function isTelegramPayloadTooLarge(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  return Number.isFinite(contentLength) && contentLength > 16_384;
}

export function isDuplicateTelegramError(error: unknown) {
  return error instanceof DuplicateTelegramUpdateError;
}

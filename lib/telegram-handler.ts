import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { accounts, categories, creditCards, householdMembers, invoicePayments, subcategories, telegramConversationStates, telegramLinks, transactions } from "@/db/schema";
import { createCardPurchase, createTransaction, DuplicateTelegramUpdateError, FinanceValidationError, isTelegramUpdateProcessed, telegramFinancialOperationUpdateId } from "@/lib/finance-service";
import { parseBrazilianMoney, splitInstallments } from "@/lib/finance-rules.mjs";
import { digestToken } from "@/lib/auth-crypto.mjs";
import { clearRateLimit, consumeRateLimit, RateLimitError } from "@/lib/rate-limit";
import { connectTelegramWithCode } from "@/lib/telegram-link-service";
import { dateInSaoPaulo, parseTelegramMessage } from "@/lib/telegram-parser.mjs";
import { createTelegramFinancialSessionId, isTelegramCallbackForSession, paginateTelegramOptions, parseTelegramCallback, resolveTelegramSelection, telegramCancelButtons, telegramConfirmationButtons, telegramEditButtons, telegramPaymentFlowButtons, telegramSelectionButtons, updateTelegramIntentField } from "@/lib/telegram-conversation.mjs";
import { buildTelegramInstallmentPreview, effectiveTelegramPaymentFlow, isValidTelegramDate, parseTelegramInstallmentCount, resolveTelegramDueDate, telegramFinancialPersistenceTarget, transitionTelegramPaymentFlow } from "@/lib/telegram-payment-flow.mjs";
import { formatBrl, type TelegramButton } from "@/lib/telegram";
import { telegramUpdateSchema } from "@/lib/telegram-update.mjs";

type FinancialIntent = {
  intent: string;
  type?: "income" | "expense" | null;
  amountCents?: number | null;
  description?: string | null;
  purchaseDate?: string;
  transactionDate?: string;
  paymentFlow?: "immediate" | "future_bill" | "credit_card" | "direct_installments" | null;
  legacyCardCompatible?: boolean;
  dueDate?: string | null;
  firstDueDate?: string | null;
  installmentDayOfMonth?: number | null;
  installmentCount?: number | null;
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
  intent: z.string(), type: z.enum(["income", "expense"]).nullable().optional(), amountCents: z.number().int().positive().nullable().optional(), description: z.string().max(120).nullable().optional(), purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(), transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(), paymentFlow: z.enum(["immediate", "future_bill", "credit_card", "direct_installments"]).nullable().optional(), legacyCardCompatible: z.boolean().optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional(), firstDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional(), installmentDayOfMonth: z.number().int().min(1).max(31).nullable().optional(), installmentCount: z.number().int().min(1).max(120).nullable().optional(), paymentMethod: z.string().max(30).nullable().optional(), cardId: z.string().max(80).nullable().optional(), accountId: z.string().max(80).nullable().optional(), categoryId: z.string().max(80).nullable().optional(), subcategoryId: z.string().max(80).nullable().optional(), subcategorySkipped: z.boolean().optional(), missing: z.array(z.string().max(30)).max(10).optional(), ambiguous: z.boolean().optional(), ambiguity: z.string().max(40).nullable().optional(),
}).passthrough();

const conversationStateSchema = z.object({
  phase: z.enum(["collecting", "confirming", "choosing_edit_field", "editing_value", "editing_description", "editing_date", "editing_due_date", "editing_installment_count", "editing_first_due_date", "selecting_payment_flow", "selecting_account", "selecting_card", "selecting_category", "selecting_subcategory", "altering"]),
  financialIntent: financialIntentSchema,
  originalText: z.string().max(1_000),
  originalUpdateId: z.string().max(30),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{10}$/u).optional(),
  field: z.enum(["tipo", "valor", "descrição", "forma_pagamento", "conta", "cartão", "categoria", "subcategoria", "vencimento", "parcelas", "primeiro_vencimento"]).optional(),
  page: z.number().int().min(0).max(10_000).optional(),
  mode: z.enum(["create", "edit"]).optional(),
}).passthrough();

type ConversationState = z.infer<typeof conversationStateSchema>;
type HouseholdContext = Awaited<ReturnType<typeof loadHouseholdContext>>;
type ChoiceKind = "account" | "card" | "category" | "subcategory";
type MissingField = "tipo" | "valor" | "descrição" | "forma_pagamento" | "conta" | "cartão" | "categoria" | "subcategoria" | "vencimento" | "parcelas" | "primeiro_vencimento";

export type TelegramHandlerResult = { text?: string; buttons?: TelegramButton[][]; duplicate?: boolean };

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

async function cancelState(updateId: string, telegramUserId: string, householdId: string, operationId?: string) {
  const d1 = database();
  const statements = operationId
    ? [d1.prepare("INSERT INTO telegram_processed_updates (update_id, received_at) VALUES (?, ?)").bind(telegramFinancialOperationUpdateId(operationId), new Date().toISOString())]
    : [];
  statements.push(d1.prepare("DELETE FROM telegram_conversation_states WHERE telegram_user_id = ? AND household_id = ?").bind(telegramUserId, householdId));
  await commitUpdate(updateId, statements);
}

function questionFor(field: string, intent: FinancialIntent) {
  if (field === "valor") return intent.type === "income" ? "Qual é o valor dessa entrada?" : intent.type === "expense" ? "Qual é o valor desse gasto?" : "Qual é o valor do lançamento?";
  if (field === "descrição") return intent.type === "income" ? "De onde veio essa entrada?" : intent.type === "expense" ? "Em que foi esse gasto?" : "Qual é a descrição do lançamento?";
  if (field === "tipo") return "Isso é uma despesa ou uma entrada?";
  if (field === "forma_pagamento") return "Como essa compra será paga?";
  if (field === "cartão") return "Em qual cartão deseja registrar?";
  if (field === "conta") return "Em qual conta deseja registrar?";
  if (field === "categoria") return "Qual é a categoria desse lançamento?";
  if (field === "subcategoria") return "Qual é a subcategoria desse lançamento?";
  if (field === "vencimento") return "Qual é o vencimento? Envie, por exemplo, dia 20, 15/10 ou 2026-10-15.";
  if (field === "parcelas") return "Em quantas parcelas? Envie, por exemplo, 3x ou 3 parcelas.";
  if (field === "primeiro_vencimento") return "Qual é o primeiro vencimento? Envie, por exemplo, dia 20, 15/10 ou 2026-10-15.";
  return "Preciso de mais uma informação para continuar.";
}

function paymentMethodLabel(value?: string | null) {
  return value === "pix" ? "PIX" : value === "cash" ? "Dinheiro" : value === "debit" ? "Débito" : value === "transfer" ? "Transferência" : "Não informado";
}

function installmentSummary(totalCents: number, count: number) {
  const amounts = splitInstallments(totalCents, count);
  const distinct = [...new Set(amounts)];
  return distinct.length === 1 ? `${count}x de ${formatBrl(distinct[0])}` : `${count} parcelas (${formatBrl(amounts[0])} a ${formatBrl(amounts.at(-1)!)})`;
}

function confirmationText(intent: FinancialIntent, accountName?: string, cardName?: string, categoryName?: string, subcategoryName?: string) {
  const flow = effectiveTelegramPaymentFlow(intent);
  const kind = intent.type === "income" ? "Entrada" : flow === "credit_card" ? "Compra no cartão" : "Despesa";
  const lines = [`${intent.type === "income" ? "💰" : flow === "credit_card" ? "💳" : "🧾"} ${intent.description}`, `${kind}: ${formatBrl(intent.amountCents!)}`];
  if (categoryName) lines.push(`Categoria: ${categoryName}`);
  if (subcategoryName) lines.push(`Subcategoria: ${subcategoryName}`);
  if (flow === "immediate") {
    lines.push("Pagamento: Imediato");
    if (accountName) lines.push(`Conta: ${accountName}`);
    lines.push(`Meio: ${paymentMethodLabel(intent.paymentMethod)}`);
  } else if (flow === "future_bill") {
    lines.push("Pagamento: Pendente", `Vencimento: ${intent.dueDate}`);
  } else if (flow === "credit_card") {
    lines.push("Pagamento: Cartão de crédito");
    if (cardName) lines.push(`Cartão: ${cardName}`);
    lines.push(`Parcelamento: ${installmentSummary(intent.amountCents!, intent.installmentCount ?? 1)}`);
  } else if (flow === "direct_installments") {
    const preview = buildTelegramInstallmentPreview({ totalCents: intent.amountCents!, count: intent.installmentCount!, firstDueDate: intent.firstDueDate!, desiredDay: intent.installmentDayOfMonth ?? undefined });
    const previewText = preview.length <= 4
      ? preview.map((item) => `${item.installmentNumber}/${item.installmentCount} ${formatBrl(item.amountCents)} em ${item.dueDate}`).join(" · ")
      : `${preview[0].installmentNumber}/${preview[0].installmentCount} ${formatBrl(preview[0].amountCents)} em ${preview[0].dueDate} · … · ${preview.at(-1)!.installmentNumber}/${preview.at(-1)!.installmentCount} ${formatBrl(preview.at(-1)!.amountCents)} em ${preview.at(-1)!.dueDate}`;
    lines.push("Pagamento: Parcelado direto", `Parcelamento: ${installmentSummary(intent.amountCents!, intent.installmentCount!)}`, `Primeiro vencimento: ${intent.firstDueDate}`, `Prévia: ${previewText}`);
  }
  lines.push(`Compra: ${intent.purchaseDate}`, "", "Confirmar lançamento?");
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
  if (!intent.categoryId) return [];
  return context.subcategories.filter((subcategory) => subcategory.categoryId === intent.categoryId);
}

function selectionItems(kind: ChoiceKind, intent: FinancialIntent, context: HouseholdContext) {
  if (kind === "account") return eligibleAccounts(intent, context);
  if (kind === "card") return context.cards;
  if (kind === "category") return eligibleCategories(intent, context);
  return eligibleSubcategories(intent, context);
}

function prepareIntent(intent: FinancialIntent, context: HouseholdContext) {
  let prepared = { ...intent };
  const missing = new Set<string>();
  if (typeof prepared.amountCents !== "number" || !Number.isSafeInteger(prepared.amountCents) || prepared.amountCents < 1 || prepared.amountCents > 100_000_000_000) prepared.amountCents = null;
  if (prepared.description && prepared.description.trim().length > 120) prepared.description = null;
  prepared.purchaseDate = prepared.purchaseDate ?? prepared.transactionDate ?? dateInSaoPaulo();
  delete prepared.transactionDate;
  if (!isValidTelegramDate(prepared.purchaseDate)) prepared.purchaseDate = dateInSaoPaulo();
  if (!prepared.type) missing.add("tipo");
  if (!prepared.amountCents) missing.add("valor");
  if (!prepared.description) missing.add("descrição");

  const legacyFlow = prepared.paymentFlow === undefined;
  let paymentFlow = effectiveTelegramPaymentFlow(prepared);
  if (prepared.type === "income") paymentFlow = "immediate";
  if (paymentFlow) {
    prepared = transitionTelegramPaymentFlow(prepared, paymentFlow) as FinancialIntent;
    if (legacyFlow) delete prepared.paymentFlow;
  } else if (prepared.type === "expense") missing.add("forma_pagamento");

  if (paymentFlow === "credit_card") {
    if (prepared.cardId && !context.cards.some((card) => card.id === prepared.cardId)) prepared.cardId = null;
    if (!prepared.cardId) {
      if (context.cards.length === 1) prepared.cardId = context.cards[0].id;
      else missing.add("cartão");
    }
    if (!Number.isInteger(prepared.installmentCount) || prepared.installmentCount! < 1 || prepared.installmentCount! > 120 || Boolean(prepared.amountCents && prepared.installmentCount! > prepared.amountCents)) {
      prepared.installmentCount = null;
      missing.add("parcelas");
    }
  } else if (paymentFlow === "immediate") {
    const candidates = eligibleAccounts(prepared, context);
    if (prepared.accountId && !candidates.some((account) => account.id === prepared.accountId)) prepared.accountId = null;
    if (!prepared.accountId) {
      if (candidates.length === 1) prepared.accountId = candidates[0].id;
      else missing.add("conta");
    }
  } else if (paymentFlow === "future_bill") {
    if (!prepared.dueDate || !isValidTelegramDate(prepared.dueDate) || prepared.dueDate < prepared.purchaseDate!) {
      prepared.dueDate = null;
      missing.add("vencimento");
    }
  } else if (paymentFlow === "direct_installments") {
    if (!Number.isInteger(prepared.installmentCount) || prepared.installmentCount! < 2 || prepared.installmentCount! > 120 || Boolean(prepared.amountCents && prepared.installmentCount! > prepared.amountCents)) {
      prepared.installmentCount = null;
      missing.add("parcelas");
    }
    if (!prepared.firstDueDate || !isValidTelegramDate(prepared.firstDueDate) || prepared.firstDueDate < prepared.purchaseDate!) {
      prepared.firstDueDate = null;
      prepared.installmentDayOfMonth = null;
      missing.add("primeiro_vencimento");
    }
  }

  const categoryCandidates = prepared.type ? eligibleCategories(prepared, context) : [];
  if (prepared.categoryId && !categoryCandidates.some((category) => category.id === prepared.categoryId)) {
    prepared.categoryId = null;
    prepared.subcategoryId = null;
    prepared.subcategorySkipped = false;
  }
  if (prepared.type === "expense" && !prepared.categoryId) missing.add("categoria");
  else if (prepared.type && categoryCandidates.length && !prepared.categoryId) missing.add("categoria");
  const legacyCard = paymentFlow === "credit_card" && (legacyFlow || prepared.legacyCardCompatible === true);
  if (prepared.categoryId && !legacyCard) {
    const subcategoryCandidates = eligibleSubcategories(prepared, context);
    if (prepared.subcategoryId && !subcategoryCandidates.some((subcategory) => subcategory.id === prepared.subcategoryId)) prepared.subcategoryId = null;
    if (subcategoryCandidates.length && !prepared.subcategoryId) missing.add("subcategoria");
  }
  prepared.missing = [...missing];
  prepared.ambiguous = missing.size > 0;
  return prepared;
}

function firstMissing(intent: FinancialIntent): MissingField | undefined {
  const order: MissingField[] = ["tipo", "valor", "descrição", "forma_pagamento", "cartão", "conta", "categoria", "subcategoria", "parcelas", "vencimento", "primeiro_vencimento"];
  return order.find((field) => intent.missing?.includes(field));
}

function selectionResponse(kind: ChoiceKind, state: ConversationState, context: HouseholdContext, prefix?: string): TelegramHandlerResult {
  const items = selectionItems(kind, state.financialIntent, context);
  const page = paginateTelegramOptions(items, state.page ?? 0);
  const field = kind === "account" ? "conta" : kind === "card" ? "cartão" : kind === "category" ? "categoria" : "subcategoria";
  const message = items.length ? `${prefix ? `${prefix}\n\n` : ""}${questionFor(field, state.financialIntent)}${page.totalPages > 1 ? ` Página ${page.page + 1} de ${page.totalPages}.` : ""}` : `Nenhuma ${field} ativa está disponível para este lançamento.`;
  return { text: message, buttons: telegramSelectionButtons(kind, items, page.page, { sessionId: state.sessionId, allowNone: false, allowCategoryBack: kind === "subcategory" }) };
}

async function presentIntent(updateId: string, telegramUserId: string, householdId: string, baseState: ConversationState, context: HouseholdContext, prefix?: string): Promise<TelegramHandlerResult> {
  const sessionId = baseState.sessionId ?? createTelegramFinancialSessionId();
  const scopedState = { ...baseState, sessionId };
  const intent = prepareIntent(scopedState.financialIntent, context);
  const missing = firstMissing(intent);
  if (missing) {
    if (missing === "forma_pagamento") {
      const state: ConversationState = { ...scopedState, phase: "selecting_payment_flow", financialIntent: intent, field: missing, page: 0 };
      await saveState(updateId, telegramUserId, householdId, state);
      return { text: `${prefix ? `${prefix}\n\n` : ""}${questionFor(missing, intent)}`, buttons: telegramPaymentFlowButtons(sessionId) };
    }
    const kind = missing === "conta" ? "account" : missing === "cartão" ? "card" : missing === "categoria" ? "category" : missing === "subcategoria" ? "subcategory" : null;
    const state: ConversationState = kind
      ? { ...scopedState, phase: phaseByKind[kind], financialIntent: intent, field: missing, page: 0 }
      : { ...scopedState, phase: "collecting", financialIntent: intent, field: missing, page: 0 };
    const reply = kind ? selectionResponse(kind, state, context, prefix) : { text: `${prefix ? `${prefix}\n\n` : ""}${questionFor(missing, intent)}`, buttons: telegramCancelButtons(sessionId) };
    await saveState(updateId, telegramUserId, householdId, state);
    return reply;
  }

  const selectedAccount = context.accounts.find((item) => item.id === intent.accountId);
  const selectedCard = context.cards.find((item) => item.id === intent.cardId);
  const selectedSubcategory = context.subcategories.find((item) => item.id === intent.subcategoryId);
  const selectedCategory = context.categories.find((item) => item.id === intent.categoryId);
  const reply = confirmationText(intent, selectedAccount?.name, selectedCard?.name, selectedCategory?.name, selectedSubcategory?.name);
  const state: ConversationState = { ...scopedState, phase: "confirming", financialIntent: intent, field: undefined, page: 0 };
  await saveState(updateId, telegramUserId, householdId, state);
  return { text: `${prefix ? `${prefix}\n\n` : ""}${reply}`, buttons: telegramConfirmationButtons(sessionId) };
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
      if (parsedState.success) {
        const restored = parsedState.data.phase === "altering" ? { ...parsedState.data, phase: "choosing_edit_field" as const } : parsedState.data;
        state = { ...restored, sessionId: restored.sessionId ?? createTelegramFinancialSessionId() };
      }
    } catch { state = null; }
  } else if (stored) {
    await db.delete(telegramConversationStates).where(and(eq(telegramConversationStates.telegramUserId, telegramUserId), eq(telegramConversationStates.householdId, link.householdId)));
  }

  if (update.callback_query && callback?.action === "stale") {
    await commitUpdate(updateId);
    return { text: "Este botão pertence a uma operação antiga. Use os botões da conversa atual." };
  }
  if (update.callback_query && callback?.action !== "invalid" && !isTelegramCallbackForSession(callback, state?.sessionId)) {
    await commitUpdate(updateId);
    return { text: "Este botão pertence a outra operação ou já expirou. A conversa atual não foi alterada." };
  }

  const context = await loadHouseholdContext(link.householdId);
  const action = callback?.action ?? command?.intent;
  if (action === "cancel") {
    try {
      await cancelState(updateId, telegramUserId, link.householdId, state?.sessionId);
    } catch (error) {
      if (!(error instanceof DuplicateTelegramUpdateError)) throw error;
      return { duplicate: true };
    }
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
    const buttons = telegramEditButtons({ sessionId: state.sessionId!, paymentFlow: effectiveTelegramPaymentFlow(intent) ?? "immediate", hasSubcategories });
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
    const source = { updateId, operationId: state.sessionId, originalUpdateId: state.originalUpdateId, originalText: state.originalText, telegramUserId };
    const paymentFlow = effectiveTelegramPaymentFlow(intent);
    const persistenceTarget = telegramFinancialPersistenceTarget(intent, state.financialIntent);
    try {
      if (persistenceTarget === "card_purchase" && intent.cardId) {
        const result = await createCardPurchase({ cardId: intent.cardId, description: intent.description!, totalCents: intent.amountCents!, purchaseDate: intent.purchaseDate!, installmentCount: intent.installmentCount ?? 1, categoryId: intent.categoryId }, { householdId: link.householdId, userId: link.userId, origin: "telegram", source, clearTelegramStateFor: telegramUserId });
        return { text: `✅ Compra de ${formatBrl(intent.amountCents!)} registrada no cartão ${result.cardName}.` };
      }
      if (persistenceTarget === "transaction") {
        await createTransaction({ type: intent.type!, amountCents: intent.amountCents!, description: intent.description!, categoryId: intent.categoryId, subcategoryId: intent.subcategoryId, transactionDate: intent.purchaseDate!, accountId: intent.accountId!, paymentMethod: intent.paymentMethod, status: "confirmed" }, { householdId: link.householdId, userId: link.userId, origin: "telegram", source, clearTelegramStateFor: telegramUserId });
        return { text: `✅ ${intent.type === "income" ? "Entrada" : "Despesa"} de ${formatBrl(intent.amountCents!)} registrada.` };
      }
    } catch (error) {
      if (!(error instanceof DuplicateTelegramUpdateError)) throw error;
      try {
        await commitUpdate(updateId);
      } catch (commitError) {
        if (commitError instanceof DuplicateTelegramUpdateError) return { duplicate: true };
        throw commitError;
      }
      return { text: "Esta operação já foi finalizada. Nenhum lançamento duplicado foi criado." };
    }
    if (paymentFlow !== "immediate") {
      await saveState(updateId, telegramUserId, link.householdId, { ...state, phase: "confirming", financialIntent: intent });
      return { text: "Este tipo de pagamento já foi preparado, mas ainda não está disponível para gravação nesta etapa. Nenhum lançamento foi criado.", buttons: telegramConfirmationButtons(state.sessionId!) };
    }
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
    const field = callback.field as "value" | "description" | "account" | "card" | "category" | "subcategory" | "date" | "paymentFlow" | "dueDate" | "installmentCount" | "firstDueDate";
    if (field === "paymentFlow") {
      const nextState: ConversationState = { ...state, phase: "selecting_payment_flow", field: "forma_pagamento", page: 0, mode: "edit" };
      await saveState(updateId, telegramUserId, link.householdId, nextState);
      return { text: questionFor("forma_pagamento", state.financialIntent), buttons: telegramPaymentFlowButtons(state.sessionId!) };
    }
    if (field === "value" || field === "description" || field === "date" || field === "dueDate" || field === "installmentCount" || field === "firstDueDate") {
      const phase = field === "value" ? "editing_value" : field === "description" ? "editing_description" : field === "date" ? "editing_date" : field === "dueDate" ? "editing_due_date" : field === "installmentCount" ? "editing_installment_count" : "editing_first_due_date";
      const prompt = field === "value" ? "Envie somente o novo valor." : field === "description" ? questionFor("descrição", state.financialIntent) : field === "date" ? "Envie a nova data da compra no formato AAAA-MM-DD, ou escreva hoje, ontem ou anteontem." : field === "dueDate" ? questionFor("vencimento", state.financialIntent) : field === "installmentCount" ? questionFor("parcelas", state.financialIntent) : questionFor("primeiro_vencimento", state.financialIntent);
      await saveState(updateId, telegramUserId, link.householdId, { ...state, phase, page: 0 });
      return { text: prompt, buttons: telegramCancelButtons(state.sessionId!) };
    }
    const kind = field as ChoiceKind;
    const nextState: ConversationState = { ...state, phase: phaseByKind[kind], page: 0, mode: "edit" };
    const reply = selectionResponse(kind, nextState, context);
    await saveState(updateId, telegramUserId, link.householdId, nextState);
    return reply;
  }

  if (callback?.action === "select-flow") {
    if (!state || state.phase !== "selecting_payment_flow") {
      await commitUpdate(updateId);
      return { text: "Essa escolha de pagamento não está mais disponível." };
    }
    const intent = updateTelegramIntentField(state.financialIntent, "paymentFlow", callback.paymentFlow) as FinancialIntent;
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent, page: 0 }, context);
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
      return { text: "Não reconheci o valor. Envie, por exemplo, 85 ou 85,50.", buttons: telegramCancelButtons(state.sessionId!) };
    }
    if (amountCents < 1) {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: "O valor deve ser maior que zero.", buttons: telegramCancelButtons(state.sessionId!) };
    }
    const intent = updateTelegramIntentField(state.financialIntent, "value", amountCents) as FinancialIntent;
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context);
  }
  if (state?.phase === "editing_description") {
    const description = text.trim();
    if (!description || description.length > 120) {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: "A descrição deve ter entre 1 e 120 caracteres.", buttons: telegramCancelButtons(state.sessionId!) };
    }
    const intent = updateTelegramIntentField(state.financialIntent, "description", description) as FinancialIntent;
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context);
  }
  if (state?.phase === "editing_date") {
    const date = parseEditedDate(text);
    if (!date) {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: "Data inválida. Use AAAA-MM-DD, hoje, ontem ou anteontem.", buttons: telegramCancelButtons(state.sessionId!) };
    }
    const intent = updateTelegramIntentField(state.financialIntent, "date", date) as FinancialIntent;
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context);
  }
  if (state?.phase === "editing_due_date" || state?.phase === "editing_first_due_date") {
    const purchaseDate = state.financialIntent.purchaseDate ?? state.financialIntent.transactionDate ?? dateInSaoPaulo();
    const due = resolveTelegramDueDate(text, purchaseDate);
    if (due.status !== "resolved") {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: due.status === "incomplete" ? "Informe também o dia do vencimento." : "Vencimento inválido. Use dia 20, DD/MM ou AAAA-MM-DD.", buttons: telegramCancelButtons(state.sessionId!) };
    }
    const field = state.phase === "editing_due_date" ? "dueDate" : "firstDueDate";
    const value = field === "firstDueDate" ? { date: due.date, desiredDay: due.desiredDay } : due.date;
    const intent = updateTelegramIntentField(state.financialIntent, field, value) as FinancialIntent;
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context);
  }
  if (state?.phase === "editing_installment_count") {
    const installmentCount = parseTelegramInstallmentCount(text);
    if (!installmentCount) {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: "Quantidade inválida. Envie, por exemplo, 3, 3x ou 3 parcelas.", buttons: telegramCancelButtons(state.sessionId!) };
    }
    const intent = updateTelegramIntentField(state.financialIntent, "installmentCount", installmentCount) as FinancialIntent;
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context);
  }
  if (state?.phase === "collecting") {
    let intent = state.financialIntent;
    if (state.field === "valor") {
      try { intent = updateTelegramIntentField(intent, "value", parseBrazilianMoney(text)) as FinancialIntent; } catch {
        await saveState(updateId, telegramUserId, link.householdId, state);
        return { text: "Não reconheci o valor. Envie, por exemplo, 85 ou 85,50.", buttons: telegramCancelButtons(state.sessionId!) };
      }
    } else if (state.field === "descrição") {
      const description = text.trim();
      if (!description || description.length > 120) {
        await saveState(updateId, telegramUserId, link.householdId, state);
        return { text: "A descrição deve ter entre 1 e 120 caracteres.", buttons: telegramCancelButtons(state.sessionId!) };
      }
      intent = updateTelegramIntentField(intent, "description", description) as FinancialIntent;
    } else if (state.field === "tipo") {
      const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("pt-BR");
      if (/\b(receita|entrada)\b/u.test(normalized)) intent = transitionTelegramPaymentFlow({ ...intent, type: "income" }, "immediate") as FinancialIntent;
      else if (/\b(despesa|gasto)\b/u.test(normalized)) intent = { ...intent, type: "expense" };
      else {
        await saveState(updateId, telegramUserId, link.householdId, state);
        return { text: "Responda despesa ou entrada.", buttons: telegramCancelButtons(state.sessionId!) };
      }
    } else if (state.field === "vencimento" || state.field === "primeiro_vencimento") {
      const purchaseDate = intent.purchaseDate ?? intent.transactionDate ?? dateInSaoPaulo();
      const due = resolveTelegramDueDate(text, purchaseDate);
      if (due.status !== "resolved") {
        await saveState(updateId, telegramUserId, link.householdId, state);
        return { text: due.status === "incomplete" ? "Informe também o dia do vencimento." : "Vencimento inválido. Use dia 20, DD/MM ou AAAA-MM-DD.", buttons: telegramCancelButtons(state.sessionId!) };
      }
      intent = updateTelegramIntentField(intent, state.field === "vencimento" ? "dueDate" : "firstDueDate", state.field === "vencimento" ? due.date : { date: due.date, desiredDay: due.desiredDay }) as FinancialIntent;
    } else if (state.field === "parcelas") {
      const installmentCount = parseTelegramInstallmentCount(text);
      if (!installmentCount) {
        await saveState(updateId, telegramUserId, link.householdId, state);
        return { text: "Quantidade inválida. Envie, por exemplo, 3, 3x ou 3 parcelas.", buttons: telegramCancelButtons(state.sessionId!) };
      }
      intent = updateTelegramIntentField(intent, "installmentCount", installmentCount) as FinancialIntent;
    } else {
      await saveState(updateId, telegramUserId, link.householdId, state);
      return { text: "Use os botões para escolher essa opção.", buttons: telegramCancelButtons(state.sessionId!) };
    }
    return presentIntent(updateId, telegramUserId, link.householdId, { ...state, financialIntent: intent }, context);
  }
  if (state && (state.phase === "choosing_edit_field" || Boolean(kindByPhase[state.phase]))) {
    const buttons = state.phase === "choosing_edit_field"
      ? telegramEditButtons({ sessionId: state.sessionId!, paymentFlow: effectiveTelegramPaymentFlow(state.financialIntent) ?? "immediate", hasSubcategories: eligibleSubcategories(state.financialIntent, context).length > 0 })
      : telegramSelectionButtons(kindByPhase[state.phase]!, selectionItems(kindByPhase[state.phase]!, state.financialIntent, context), state.page ?? 0, { sessionId: state.sessionId, allowNone: false, allowCategoryBack: state.phase === "selecting_subcategory" });
    await saveState(updateId, telegramUserId, link.householdId, state);
    return { text: "Use os botões da mensagem para continuar ou cancelar.", buttons };
  }
  if (state?.phase === "selecting_payment_flow") {
    await saveState(updateId, telegramUserId, link.householdId, state);
    return { text: "Use os botões para escolher a forma de pagamento ou cancelar.", buttons: telegramPaymentFlowButtons(state.sessionId!) };
  }
  if (state?.phase === "confirming") return presentIntent(updateId, telegramUserId, link.householdId, state, context, "Use os botões abaixo para confirmar, alterar ou cancelar.");

  const parsed = parseTelegramMessage(text, context) as FinancialIntent;
  if (parsed.intent !== "transaction") {
    await commitUpdate(updateId);
    return { text: "Não entendi com segurança. Envie, por exemplo: “Gastei 85 no mercado” ou use /ajuda." };
  }
  const initialState: ConversationState = { phase: "collecting", financialIntent: parsed, originalText: text, originalUpdateId: updateId, sessionId: createTelegramFinancialSessionId(), mode: "create", page: 0 };
  return presentIntent(updateId, telegramUserId, link.householdId, initialState, context);
}

export function isTelegramPayloadTooLarge(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  return Number.isFinite(contentLength) && contentLength > 16_384;
}

export function isDuplicateTelegramError(error: unknown) {
  return error instanceof DuplicateTelegramUpdateError;
}

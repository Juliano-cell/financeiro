import { NextResponse } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getCurrentUser, isSameOriginRequest } from "@/app/auth";
import { getDb } from "@/db";
import { accounts, auditLogs, bills, categories, householdInviteTokens, householdMembers, households, subcategories, transactions, users } from "@/db/schema";
import { digestToken, generateRecoveryCode, normalizeRecoveryCode } from "@/lib/auth-crypto.mjs";
import { dateInTimeZone } from "@/lib/finance-analytics.mjs";
import { getCurrentAccountBalances } from "@/lib/finance-analytics-service";
import { createTransaction, FinanceValidationError } from "@/lib/finance-service";

export const dynamic = "force-dynamic";

const id = z.string().min(1).max(80);
const text = z.string().trim().min(1).max(120);
const money = z.number().int().safe().min(0).max(1_000_000_000_00);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

async function currentIdentity() {
  const user = await getCurrentUser();
  if (!user) return null;
  const db = getDb();
  const membership = await db.select().from(householdMembers).where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active"))).limit(1);
  return { auth: { userId: user.id, displayName: user.name, email: user.email }, db, membership: membership[0] ?? null };
}

async function logChange(db: ReturnType<typeof getDb>, householdId: string, userId: string, action: string, entityType: string, entityId: string, oldData?: unknown, newData?: unknown) {
  await db.insert(auditLogs).values({ id: uid("audit"), householdId, userId, action, entityType, entityId, oldData: oldData ? JSON.stringify(oldData) : null, newData: newData ? JSON.stringify(newData) : null, createdAt: now() });
}

async function validateTransactionRelations(db: ReturnType<typeof getDb>, householdId: string, values: { type: "income" | "expense"; accountId: string; categoryId?: string | null; subcategoryId?: string | null }) {
  const [account] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, values.accountId), eq(accounts.householdId, householdId))).limit(1);
  if (!account) return "Conta inválida.";
  if (values.type === "expense" && !values.categoryId) return "Selecione uma categoria para a despesa.";
  let category: { id: string; type: "income" | "expense" | "both" } | undefined;
  if (values.categoryId) {
    [category] = await db.select({ id: categories.id, type: categories.type }).from(categories).where(and(eq(categories.id, values.categoryId), eq(categories.householdId, householdId), eq(categories.isActive, true))).limit(1);
    if (!category || (category.type !== values.type && category.type !== "both")) return "Categoria inválida para este lançamento.";
  }
  const categorySubcategories = category
    ? await db.select({ id: subcategories.id }).from(subcategories).where(and(eq(subcategories.householdId, householdId), eq(subcategories.categoryId, category.id), eq(subcategories.isActive, true)))
    : [];
  if (values.type === "expense" && categorySubcategories.length && !values.subcategoryId) return "Selecione uma subcategoria para esta despesa.";
  if (values.subcategoryId) {
    const [subcategory] = await db.select({ id: subcategories.id, categoryId: subcategories.categoryId }).from(subcategories).where(and(eq(subcategories.id, values.subcategoryId), eq(subcategories.householdId, householdId), eq(subcategories.isActive, true))).limit(1);
    if (!subcategory || !values.categoryId || subcategory.categoryId !== values.categoryId) return "Subcategoria inválida para esta família ou categoria.";
  }
  return null;
}

export async function GET() {
  try {
    const identity = await currentIdentity();
    if (!identity) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
    const { auth, db, membership } = identity;
    if (!membership) return NextResponse.json({ setupRequired: true, user: { id: auth.userId, name: auth.displayName, email: auth.email } });
    const householdId = membership.householdId;
    const [family] = await db.select().from(households).where(eq(households.id, householdId)).limit(1);
    const accountRows = await db.select().from(accounts).where(eq(accounts.householdId, householdId)).orderBy(asc(accounts.name));
    const categoryRows = await db.select().from(categories).where(eq(categories.householdId, householdId)).orderBy(asc(categories.name));
    const subcategoryRows = await db.select().from(subcategories).where(eq(subcategories.householdId, householdId)).orderBy(asc(subcategories.name));
    const memberRows = await db.select({ id: householdMembers.id, userId: householdMembers.userId, invitedEmail: householdMembers.invitedEmail, role: householdMembers.role, status: householdMembers.status, name: users.name, email: users.email }).from(householdMembers).leftJoin(users, eq(householdMembers.userId, users.id)).where(eq(householdMembers.householdId, householdId));
    const transactionRows = await db.select({
      id: transactions.id, type: transactions.type, amountCents: transactions.amountCents, description: transactions.description, categoryId: transactions.categoryId, subcategoryId: transactions.subcategoryId,
      transactionDate: transactions.transactionDate, transactionTime: transactions.transactionTime, responsibleUserId: transactions.responsibleUserId, accountId: transactions.accountId,
      paymentMethod: transactions.paymentMethod, status: transactions.status, origin: transactions.origin, notes: transactions.notes, createdAt: transactions.createdAt, updatedAt: transactions.updatedAt,
      accountName: accounts.name, categoryName: categories.name, responsibleName: users.name,
    }).from(transactions).leftJoin(accounts, eq(transactions.accountId, accounts.id)).leftJoin(categories, eq(transactions.categoryId, categories.id)).leftJoin(users, eq(transactions.responsibleUserId, users.id)).where(eq(transactions.householdId, householdId)).orderBy(desc(transactions.transactionDate), desc(transactions.createdAt)).limit(200);
    const balanceRows = await getCurrentAccountBalances(householdId, dateInTimeZone());
    const balances = new Map(balanceRows.map((account) => [account.accountId, account.currentBalanceCents]));
    const accountsWithBalance = accountRows.map((account) => ({ ...account, currentBalanceCents: balances.get(account.id) ?? account.initialBalanceCents }));
    const month = dateInTimeZone().slice(0, 7);
    const confirmedThisMonth = transactionRows.filter((item) => item.status === "confirmed" && item.transactionDate.startsWith(month));
    const incomeCents = confirmedThisMonth.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amountCents, 0);
    const expenseCents = confirmedThisMonth.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amountCents, 0);
    const availableCents = accountsWithBalance.filter((account) => account.isActive).reduce((sum, account) => sum + account.currentBalanceCents, 0);
    const daily = new Map<string, { date: string; income: number; expense: number }>();
    for (const item of confirmedThisMonth) { const point = daily.get(item.transactionDate) ?? { date: item.transactionDate, income: 0, expense: 0 }; point[item.type] += item.amountCents; daily.set(item.transactionDate, point); }
    return NextResponse.json({ setupRequired: false, user: { id: auth.userId, name: auth.displayName, email: auth.email }, household: family, membership, members: memberRows, accounts: accountsWithBalance, categories: categoryRows.map((category) => ({ ...category, subcategories: subcategoryRows.filter((sub) => sub.categoryId === category.id) })), transactions: transactionRows, summary: { availableCents, incomeCents, expenseCents, pendingBillsCents: 0, projectedCents: availableCents }, cashflow: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (error) {
    console.error("finance_snapshot_failed", error);
    return NextResponse.json({ error: "Não foi possível carregar os dados financeiros." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Origem da solicitação inválida." }, { status: 403 });
  try {
    const identity = await currentIdentity();
    if (!identity) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
    const { auth, db, membership } = identity;
    const body = await request.json() as Record<string, unknown>;
    const action = z.string().parse(body.action);

    if (action === "create_household") {
      if (membership) return NextResponse.json({ error: "Você já pertence a uma família." }, { status: 409 });
      const parsed = z.object({ name: text }).parse(body);
      const householdId = uid("household"); const timestamp = now();
      await db.insert(households).values({ id: householdId, name: parsed.name, createdBy: auth.userId, createdAt: timestamp, updatedAt: timestamp });
      await db.insert(householdMembers).values({ id: uid("member"), householdId, userId: auth.userId, invitedEmail: auth.email.toLowerCase(), role: "owner", status: "active", joinedAt: timestamp, createdAt: timestamp });
      const defaults: Array<{ name: string; type: "income" | "expense" | "both"; color: string; subs: string[] }> = [
        { name: "Moradia", type: "expense", color: "#6b7fd7", subs: ["Condomínio", "Energia", "Água", "Internet", "Financiamento", "Aluguel", "Manutenção"] },
        { name: "Transporte", type: "expense", color: "#e28a38", subs: ["Combustível", "Seguro", "IPVA", "Manutenção", "Estacionamento", "Transporte"] },
        { name: "Alimentação", type: "expense", color: "#78ad46", subs: ["Mercado", "Restaurante", "Marmita", "Lanche", "Delivery"] },
        { name: "Pessoal", type: "expense", color: "#a65d9f", subs: ["Roupas", "Calçados", "Beleza", "Lazer", "Compras pessoais"] },
        { name: "Trabalho", type: "both", color: "#397f72", subs: ["MEI", "Equipamentos", "Ferramentas", "Deslocamento", "Outros"] },
        { name: "Dívidas", type: "expense", color: "#d2535d", subs: ["Empréstimo", "Parcelamento", "Cartão", "Financiamento"] },
        { name: "Outros", type: "both", color: "#798582", subs: ["Saúde", "Educação", "Presentes", "Imprevistos", "Outros"] },
        { name: "Renda", type: "income", color: "#2b9a66", subs: ["Diárias", "Salário", "Serviços", "Outros"] },
      ];
      for (const item of defaults) { const categoryId = uid("category"); await db.insert(categories).values({ id: categoryId, householdId, name: item.name, type: item.type, color: item.color, createdAt: timestamp, updatedAt: timestamp }); if (item.subs.length) await db.insert(subcategories).values(item.subs.map((name) => ({ id: uid("subcategory"), householdId, categoryId, name, createdAt: timestamp, updatedAt: timestamp }))); }
      await logChange(db, householdId, auth.userId, "create", "household", householdId, undefined, { name: parsed.name });
      return NextResponse.json({ ok: true, id: householdId });
    }
    if (action === "accept_invite") {
      if (membership) return NextResponse.json({ error: "Você já pertence a uma família." }, { status: 409 });
      const parsed = z.object({ inviteCode: z.string().trim().min(16).max(80) }).parse(body);
      const tokenHash = await digestToken(normalizeRecoveryCode(parsed.inviteCode));
      const [invite] = await db.select().from(householdInviteTokens).where(eq(householdInviteTokens.tokenHash, tokenHash)).limit(1);
      if (!invite || new Date(invite.expiresAt) <= new Date()) return NextResponse.json({ error: "Convite inválido ou expirado." }, { status: 400 });
      const [member] = await db.select().from(householdMembers).where(eq(householdMembers.id, invite.memberId)).limit(1);
      if (!member || member.status !== "invited" || member.invitedEmail?.toLowerCase() !== auth.email.toLowerCase()) return NextResponse.json({ error: "Este convite não pertence ao seu e-mail." }, { status: 403 });
      const joinedAt = now();
      await db.update(householdMembers).set({ userId: auth.userId, status: "active", joinedAt }).where(eq(householdMembers.id, member.id));
      await db.delete(householdInviteTokens).where(eq(householdInviteTokens.memberId, member.id));
      await logChange(db, member.householdId, auth.userId, "accept", "household_member", member.id, undefined, { email: auth.email });
      return NextResponse.json({ ok: true });
    }
    if (!membership) return NextResponse.json({ error: "Crie ou aceite uma família antes de continuar." }, { status: 409 });
    const householdId = membership.householdId;

    if (action === "get_transaction") {
      const parsed = z.object({ action: z.literal("get_transaction"), id }).strict().parse(body);
      const [transaction] = await db.select({
        id: transactions.id, type: transactions.type, amountCents: transactions.amountCents, description: transactions.description,
        categoryId: transactions.categoryId, subcategoryId: transactions.subcategoryId, transactionDate: transactions.transactionDate,
        transactionTime: transactions.transactionTime, responsibleUserId: transactions.responsibleUserId, accountId: transactions.accountId,
        paymentMethod: transactions.paymentMethod, status: transactions.status, origin: transactions.origin, notes: transactions.notes,
      }).from(transactions).where(and(eq(transactions.id, parsed.id), eq(transactions.householdId, householdId))).limit(1);
      if (!transaction) return NextResponse.json({ error: "Movimentação não encontrada." }, { status: 404 });
      const [billPayment] = await db.select({ id: bills.id }).from(bills).where(and(eq(bills.householdId, householdId), eq(bills.paymentTransactionId, transaction.id))).limit(1);
      return NextResponse.json({ transaction, editable: !billPayment });
    }

    if (action === "invite_member") {
      if (membership.role !== "owner") return NextResponse.json({ error: "Apenas o responsável pode convidar membros." }, { status: 403 });
      const parsed = z.object({ email: z.string().email().transform((value) => value.toLowerCase()) }).parse(body);
      const duplicate = await db.select().from(householdMembers).where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.invitedEmail, parsed.email))).limit(1);
      if (duplicate[0]?.status === "active") return NextResponse.json({ error: "Este e-mail já pertence à família." }, { status: 409 });
      const memberId = duplicate[0]?.id ?? uid("member");
      if (!duplicate[0]) await db.insert(householdMembers).values({ id: memberId, householdId, invitedEmail: parsed.email, role: "member", status: "invited", createdAt: now() });
      const inviteCode = generateRecoveryCode();
      const createdAt = now();
      await db.insert(householdInviteTokens).values({ memberId, tokenHash: await digestToken(normalizeRecoveryCode(inviteCode)), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), createdAt }).onConflictDoUpdate({ target: householdInviteTokens.memberId, set: { tokenHash: await digestToken(normalizeRecoveryCode(inviteCode)), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), createdAt } });
      await logChange(db, householdId, auth.userId, "invite", "household_member", memberId, undefined, { email: parsed.email });
      return NextResponse.json({ ok: true, id: memberId, inviteCode });
    }

    if (action === "create_account") {
      const parsed = z.object({ name: text, type: z.enum(["bank", "cash", "savings", "wallet", "other"]), initialBalanceCents: money, isActive: z.boolean().default(true) }).parse(body);
      const entityId = uid("account"), timestamp = now(); await db.insert(accounts).values({ id: entityId, householdId, ...parsed, createdAt: timestamp, updatedAt: timestamp }); await logChange(db, householdId, auth.userId, "create", "account", entityId, undefined, parsed); return NextResponse.json({ ok: true, id: entityId });
    }
    if (action === "update_account") {
      const parsed = z.object({ id, name: text, type: z.enum(["bank", "cash", "savings", "wallet", "other"]), initialBalanceCents: money, isActive: z.boolean() }).parse(body);
      const [before] = await db.select().from(accounts).where(and(eq(accounts.id, parsed.id), eq(accounts.householdId, householdId))).limit(1); if (!before) return NextResponse.json({ error: "Conta não encontrada." }, { status: 404 });
      await db.update(accounts).set({ name: parsed.name, type: parsed.type, initialBalanceCents: parsed.initialBalanceCents, isActive: parsed.isActive, updatedAt: now() }).where(and(eq(accounts.id, parsed.id), eq(accounts.householdId, householdId))); await logChange(db, householdId, auth.userId, "update", "account", parsed.id, before, parsed); return NextResponse.json({ ok: true });
    }
    if (action === "delete_account") {
      const parsed = z.object({ id }).parse(body); const [before] = await db.select().from(accounts).where(and(eq(accounts.id, parsed.id), eq(accounts.householdId, householdId))).limit(1); if (!before) return NextResponse.json({ error: "Conta não encontrada." }, { status: 404 });
      const used = await db.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.accountId, parsed.id), eq(transactions.householdId, householdId))).limit(1); if (used[0]) return NextResponse.json({ error: "Essa conta possui movimentações. Desative-a em vez de excluir." }, { status: 409 });
      await db.delete(accounts).where(and(eq(accounts.id, parsed.id), eq(accounts.householdId, householdId))); await logChange(db, householdId, auth.userId, "delete", "account", parsed.id, before); return NextResponse.json({ ok: true });
    }

    if (action === "create_category") {
      const parsed = z.object({ name: text, type: z.enum(["income", "expense", "both"]), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), subcategories: z.array(text).max(20).default([]) }).parse(body); const entityId = uid("category"), timestamp = now(); await db.insert(categories).values({ id: entityId, householdId, name: parsed.name, type: parsed.type, color: parsed.color, createdAt: timestamp, updatedAt: timestamp }); if (parsed.subcategories.length) await db.insert(subcategories).values(parsed.subcategories.map((name) => ({ id: uid("subcategory"), householdId, categoryId: entityId, name, createdAt: timestamp, updatedAt: timestamp }))); await logChange(db, householdId, auth.userId, "create", "category", entityId, undefined, parsed); return NextResponse.json({ ok: true, id: entityId });
    }
    if (action === "update_category") {
      const parsed = z.object({ id, name: text, type: z.enum(["income", "expense", "both"]), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), isActive: z.boolean() }).parse(body); const [before] = await db.select().from(categories).where(and(eq(categories.id, parsed.id), eq(categories.householdId, householdId))).limit(1); if (!before) return NextResponse.json({ error: "Categoria não encontrada." }, { status: 404 }); await db.update(categories).set({ name: parsed.name, type: parsed.type, color: parsed.color, isActive: parsed.isActive, updatedAt: now() }).where(and(eq(categories.id, parsed.id), eq(categories.householdId, householdId))); await logChange(db, householdId, auth.userId, "update", "category", parsed.id, before, parsed); return NextResponse.json({ ok: true });
    }
    if (action === "delete_category") {
      const parsed = z.object({ id }).parse(body); const [before] = await db.select().from(categories).where(and(eq(categories.id, parsed.id), eq(categories.householdId, householdId))).limit(1); if (!before) return NextResponse.json({ error: "Categoria não encontrada." }, { status: 404 }); const used = await db.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.categoryId, parsed.id), eq(transactions.householdId, householdId))).limit(1); if (used[0]) return NextResponse.json({ error: "Essa categoria possui movimentações. Desative-a em vez de excluir." }, { status: 409 }); await db.delete(categories).where(and(eq(categories.id, parsed.id), eq(categories.householdId, householdId))); await logChange(db, householdId, auth.userId, "delete", "category", parsed.id, before); return NextResponse.json({ ok: true });
    }

    if (body.categoryId === "none") body.categoryId = null;
    if (body.subcategoryId === "none") body.subcategoryId = null;
    const transactionInput = z.object({ type: z.enum(["income", "expense"]), amountCents: money.min(1), description: text, categoryId: id.nullable().optional(), subcategoryId: id.nullable().optional(), transactionDate: date, transactionTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(), accountId: id, paymentMethod: z.string().max(60).nullable().optional(), status: z.enum(["confirmed", "pending", "cancelled"]), notes: z.string().max(500).nullable().optional() });
    if (action === "create_transaction") {
      const parsed = transactionInput.parse(body);
      const result = await createTransaction(parsed, { householdId, userId: auth.userId, origin: "dashboard" });
      return NextResponse.json({ ok: true, id: result.id });
    }
    if (action === "update_transaction") {
      const parsed = transactionInput.extend({ id }).parse(body); const [before] = await db.select().from(transactions).where(and(eq(transactions.id, parsed.id), eq(transactions.householdId, householdId))).limit(1); if (!before) return NextResponse.json({ error: "Movimentação não encontrada." }, { status: 404 }); const [billPayment] = await db.select({ id: bills.id }).from(bills).where(and(eq(bills.householdId, householdId), eq(bills.paymentTransactionId, parsed.id))).limit(1); if (billPayment) return NextResponse.json({ error: "O pagamento de uma conta deve ser alterado pela própria conta." }, { status: 409 }); const relationError = await validateTransactionRelations(db, householdId, parsed); if (relationError) return NextResponse.json({ error: relationError }, { status: 400 }); const { id: transactionId, ...values } = parsed; await db.update(transactions).set({ ...values, updatedAt: now() }).where(and(eq(transactions.id, transactionId), eq(transactions.householdId, householdId))); await logChange(db, householdId, auth.userId, "update", "transaction", transactionId, before, values); return NextResponse.json({ ok: true });
    }
    if (action === "delete_transaction") {
      const parsed = z.object({ id }).parse(body); const [before] = await db.select().from(transactions).where(and(eq(transactions.id, parsed.id), eq(transactions.householdId, householdId))).limit(1); if (!before) return NextResponse.json({ error: "Movimentação não encontrada." }, { status: 404 }); const [billPayment] = await db.select({ id: bills.id }).from(bills).where(and(eq(bills.householdId, householdId), eq(bills.paymentTransactionId, parsed.id))).limit(1); if (billPayment) return NextResponse.json({ error: "O pagamento de uma conta deve ser gerenciado pela própria conta." }, { status: 409 }); await db.delete(transactions).where(and(eq(transactions.id, parsed.id), eq(transactions.householdId, householdId))); await logChange(db, householdId, auth.userId, "delete", "transaction", parsed.id, before); return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
  } catch (error) {
    if (error instanceof FinanceValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Dados inválidos.", details: error.flatten() }, { status: 400 });
    console.error("finance_action_failed", error);
    return NextResponse.json({ error: "Não foi possível concluir a operação." }, { status: 500 });
  }
}

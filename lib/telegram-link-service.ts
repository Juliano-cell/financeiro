import { env } from "cloudflare:workers";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { householdMembers, telegramLinkCodes, telegramLinks } from "@/db/schema";
import { hmacToken } from "@/lib/auth-crypto.mjs";
import { DuplicateTelegramUpdateError, FinanceValidationError } from "@/lib/finance-service";

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

function database() {
  if (!env.DB) throw new Error("D1 binding indisponível");
  return env.DB;
}

async function markProcessed(updateId: string, at: string) {
  try {
    await database().prepare("INSERT INTO telegram_processed_updates (update_id, received_at) VALUES (?, ?)").bind(updateId, at).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/telegram_processed_updates|UNIQUE constraint failed.*update_id/iu.test(message)) throw new DuplicateTelegramUpdateError("Update do Telegram já processado.");
    throw error;
  }
}

function generateSixDigitCode() {
  const range = 1_000_000;
  const ceiling = Math.floor(0x1_0000_0000 / range) * range;
  const random = new Uint32Array(1);
  do crypto.getRandomValues(random); while (random[0] >= ceiling);
  return String(random[0] % range).padStart(6, "0");
}

async function activeMembership(userId: string) {
  const db = getDb();
  const [membership] = await db.select().from(householdMembers).where(and(eq(householdMembers.userId, userId), eq(householdMembers.status, "active"))).limit(1);
  if (!membership) throw new FinanceValidationError("Família não encontrada.");
  return membership;
}

export async function getTelegramLinkStatus(userId: string) {
  const membership = await activeMembership(userId);
  const db = getDb();
  const [linked] = await db.select({ id: telegramLinks.id }).from(telegramLinks).where(and(eq(telegramLinks.userId, userId), eq(telegramLinks.householdId, membership.householdId), eq(telegramLinks.isActive, true))).limit(1);
  return { connected: Boolean(linked) };
}

export async function disconnectTelegram(userId: string) {
  const membership = await activeMembership(userId);
  const d1 = database();
  const at = new Date().toISOString();
  const filters = [membership.householdId, userId] as const;
  const results = await d1.batch([
    d1.prepare("INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at) SELECT ?, ?, ?, 'unlink', 'telegram_link', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM telegram_links WHERE household_id = ? AND user_id = ? AND is_active = 1)").bind(uid("audit"), membership.householdId, userId, userId, JSON.stringify({ connected: true }), JSON.stringify({ connected: false }), at, ...filters),
    d1.prepare("DELETE FROM telegram_conversation_states WHERE household_id = ? AND telegram_user_id IN (SELECT telegram_user_id FROM telegram_links WHERE household_id = ? AND user_id = ? AND is_active = 1)").bind(membership.householdId, ...filters),
    d1.prepare("UPDATE telegram_link_codes SET used_at = ? WHERE household_id = ? AND user_id = ? AND used_at IS NULL").bind(at, ...filters),
    d1.prepare("UPDATE telegram_links SET is_active = 0, updated_at = ? WHERE household_id = ? AND user_id = ? AND is_active = 1").bind(at, ...filters),
  ]);
  return { connected: false as const, changed: (results[3]?.meta.changes ?? 0) > 0 };
}

export async function createTelegramLinkCode(userId: string) {
  if (!env.TELEGRAM_LINK_CODE_SECRET) throw new FinanceValidationError("Vinculação do Telegram não configurada.");
  const db = getDb();
  const membership = await activeMembership(userId);
  const [linked] = await db.select().from(telegramLinks).where(and(eq(telegramLinks.userId, userId), eq(telegramLinks.householdId, membership.householdId), eq(telegramLinks.isActive, true))).limit(1);
  if (linked) throw new FinanceValidationError("Este usuário já possui um Telegram conectado.");
  const createdAt = new Date().toISOString();
  await db.delete(telegramLinkCodes).where(or(isNotNull(telegramLinkCodes.usedAt), lte(telegramLinkCodes.expiresAt, createdAt)));
  await db.update(telegramLinkCodes).set({ usedAt: createdAt }).where(and(eq(telegramLinkCodes.userId, userId), eq(telegramLinkCodes.householdId, membership.householdId), isNull(telegramLinkCodes.usedAt)));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateSixDigitCode();
    const codeHash = await hmacToken(code, env.TELEGRAM_LINK_CODE_SECRET);
    try {
      await db.insert(telegramLinkCodes).values({ id: uid("telegram_code"), householdId: membership.householdId, userId, codeHash, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), createdAt });
      return { code, expiresInSeconds: 600 };
    } catch (error) {
      if (attempt === 9) throw error;
    }
  }
  throw new Error("Não foi possível gerar um código único.");
}

export async function connectTelegramWithCode(input: { code: string; telegramUserId: string; chatId: string; updateId: string }) {
  if (!env.TELEGRAM_LINK_CODE_SECRET) throw new FinanceValidationError("A vinculação está temporariamente indisponível.");
  const db = getDb();
  const now = new Date().toISOString();
  const codeHash = await hmacToken(input.code, env.TELEGRAM_LINK_CODE_SECRET);
  const [record] = await db.select().from(telegramLinkCodes).where(eq(telegramLinkCodes.codeHash, codeHash)).limit(1);
  if (!record || record.usedAt || record.expiresAt <= now) { await markProcessed(input.updateId, now); return { linked: false, reason: "invalid" as const }; }
  const [membership] = await db.select({ id: householdMembers.id }).from(householdMembers).where(and(eq(householdMembers.householdId, record.householdId), eq(householdMembers.userId, record.userId), eq(householdMembers.status, "active"))).limit(1);
  if (!membership) { await markProcessed(input.updateId, now); return { linked: false, reason: "inactive_member" as const }; }
  const [existing] = await db.select().from(telegramLinks).where(eq(telegramLinks.telegramUserId, input.telegramUserId)).limit(1);
  if (existing && (existing.householdId !== record.householdId || existing.userId !== record.userId)) { await markProcessed(input.updateId, now); return { linked: false, reason: "conflict" as const }; }
  const d1 = database();
  const linkId = existing?.id ?? uid("telegram_link");
  const statements: D1PreparedStatement[] = [d1.prepare("INSERT INTO telegram_processed_updates (update_id, received_at) VALUES (?, ?)").bind(input.updateId, now)];
  if (existing) {
    statements.push(d1.prepare("UPDATE telegram_links SET chat_id = ?, is_active = 1, updated_at = ? WHERE id = ? AND household_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM telegram_link_codes WHERE id = ? AND used_at IS NULL AND expires_at > ?) AND EXISTS (SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'active') AND NOT EXISTS (SELECT 1 FROM telegram_links AS active_link WHERE active_link.household_id = ? AND active_link.user_id = ? AND active_link.is_active = 1 AND active_link.id <> ?)").bind(input.chatId, now, existing.id, record.householdId, record.userId, record.id, now, record.householdId, record.userId, record.householdId, record.userId, existing.id));
  } else {
    statements.push(d1.prepare("INSERT INTO telegram_links (id, household_id, user_id, telegram_user_id, chat_id, is_active, linked_at, updated_at) SELECT ?, household_id, user_id, ?, ?, 1, ?, ? FROM telegram_link_codes WHERE id = ? AND used_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM household_members WHERE household_id = telegram_link_codes.household_id AND user_id = telegram_link_codes.user_id AND status = 'active') AND NOT EXISTS (SELECT 1 FROM telegram_links AS active_link WHERE active_link.household_id = telegram_link_codes.household_id AND active_link.user_id = telegram_link_codes.user_id AND active_link.is_active = 1)").bind(linkId, input.telegramUserId, input.chatId, now, now, record.id, now));
  }
  statements.push(d1.prepare("UPDATE telegram_link_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").bind(now, record.id, now));
  try {
    const results = await d1.batch(statements);
    const linkChanges = results[1]?.meta.changes ?? 0;
    const codeChanges = results[2]?.meta.changes ?? 0;
    return linkChanges === 1 && codeChanges === 1 ? { linked: true as const, householdId: record.householdId, userId: record.userId } : { linked: false as const, reason: "invalid" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/telegram_processed_updates|UNIQUE constraint failed.*update_id/iu.test(message)) throw new DuplicateTelegramUpdateError("Update do Telegram já processado.");
    throw error;
  }
}

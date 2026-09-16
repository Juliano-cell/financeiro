import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { bills, cardInvoices, creditCards, householdMembers, notificationLog, notificationPreferences, telegramLinks } from "@/db/schema";
import { formatBrl, sendTelegramMessage } from "@/lib/telegram";
import { getHouseholdInvoiceStates } from "@/lib/invoice-service";

export const dynamic = "force-dynamic";
const dayMs = 86_400_000;
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

export async function POST(request: Request) {
  if (!env.NOTIFICATION_CRON_SECRET || request.headers.get("authorization") !== `Bearer ${env.NOTIFICATION_CRON_SECRET}`) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const d1 = env.DB;
  if (!d1) throw new Error("Binding DB não configurado.");
  const db = getDb(); const today = new Date(`${dateOnly(new Date())}T00:00:00Z`); const preferences = await db.select().from(notificationPreferences); const billRows = await db.select().from(bills).where(eq(bills.status, "pending")); const invoiceRows = await db.select().from(cardInvoices); const cards = await db.select().from(creditCards); let sent = 0;
  const householdIds = new Set([...billRows.map((item) => item.householdId), ...invoiceRows.map((item) => item.householdId)]);
  for (const householdId of householdIds) {
    const preference = preferences.find((item) => item.householdId === householdId); if (preference && !preference.enabled) continue; let offsets = [7, 3, 1, 0, -1]; try { if (preference) offsets = JSON.parse(preference.offsetsJson); } catch { /* defaults */ }
    const links = await db.select({ userId: telegramLinks.userId, chatId: telegramLinks.chatId, telegramUserId: telegramLinks.telegramUserId }).from(telegramLinks).innerJoin(householdMembers, and(eq(householdMembers.userId, telegramLinks.userId), eq(householdMembers.householdId, telegramLinks.householdId), eq(householdMembers.status, "active"))).where(and(eq(telegramLinks.householdId, householdId), eq(telegramLinks.isActive, true)));
    if (!links.length) continue;
    const invoiceStates = await getHouseholdInvoiceStates({ d1, householdId, userId: links[0].userId });
    const candidates = [
      ...billRows.filter((item) => item.householdId === householdId).map((item) => ({ entityType: "bill", entityId: item.id, label: item.description, amountCents: item.amountCents, dueDate: item.dueDate })),
      ...invoiceStates.filter((item) => item.remainingCents > 0).map((item) => ({ entityType: "invoice", entityId: item.invoiceId, label: `Fatura ${cards.find((card) => card.id === item.cardId && card.householdId === householdId)?.name ?? "cartão"}`, amountCents: item.remainingCents, dueDate: item.dueDate })),
    ];
    for (const item of candidates) {
      const days = Math.round((new Date(`${item.dueDate}T00:00:00Z`).getTime() - today.getTime()) / dayMs); if (!offsets.includes(days)) continue; const eventKey = `${item.dueDate}:${days}`;
      for (const link of links) {
        const [logged] = await db.select().from(notificationLog).where(and(eq(notificationLog.householdId, householdId), eq(notificationLog.entityType, item.entityType), eq(notificationLog.entityId, item.entityId), eq(notificationLog.eventKey, eventKey), eq(notificationLog.channel, "telegram"), eq(notificationLog.recipientKey, link.telegramUserId))).limit(1); if (logged) continue;
        const timing = days < 0 ? `venceu há ${Math.abs(days)} dia(s)` : days === 0 ? "vence hoje" : days === 1 ? "vence amanhã" : `vence em ${days} dias`;
        await sendTelegramMessage(link.chatId, `⚠️ ${item.label}\n${formatBrl(item.amountCents)}\n${timing}`); await db.insert(notificationLog).values({ id: `notification_${crypto.randomUUID()}`, householdId, entityType: item.entityType, entityId: item.entityId, eventKey, channel: "telegram", recipientKey: link.telegramUserId, sentAt: new Date().toISOString() }); sent++;
      }
    }
  }
  return NextResponse.json({ ok: true, sent });
}

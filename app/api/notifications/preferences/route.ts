import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getCurrentUser, isSameOriginRequest } from "@/app/auth";
import { getDb } from "@/db";
import { householdMembers } from "@/db/schema";
import {
  NotificationFoundationError,
  getUserNotificationPreference,
  saveUserNotificationPreference,
} from "@/lib/notification-foundation";

export const dynamic = "force-dynamic";

const privateHeaders = { "Cache-Control": "private, no-store" };
const preferenceSchema = z.object({
  channel: z.literal("telegram"),
  enabled: z.boolean(),
  billDueTomorrow: z.boolean(),
  billDueToday: z.boolean(),
  billOverdue: z.boolean(),
  preferredLocalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  timezone: z.literal("America/Sao_Paulo"),
}).strict();

const defaultPreference = {
  exists: false,
  channel: "telegram" as const,
  enabled: false,
  billDueTomorrow: true,
  billDueToday: true,
  billOverdue: true,
  preferredLocalTime: "09:00",
  timezone: "America/Sao_Paulo" as const,
};

async function identity() {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  const db = getDb();
  const [membership] = await db.select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active")))
    .limit(1);
  if (!membership) return { kind: "inactive_membership" as const };
  if (!env.DB) throw new Error("Binding DB não configurado.");
  return { kind: "active" as const, d1: env.DB, householdId: membership.householdId, userId: user.id };
}

function identityError(kind: "unauthenticated" | "inactive_membership") {
  return kind === "unauthenticated"
    ? NextResponse.json({ error: "Não autenticado." }, { status: 401, headers: privateHeaders })
    : NextResponse.json({ error: "Membership ativa necessária." }, { status: 403, headers: privateHeaders });
}

function responsePreference(preference: Awaited<ReturnType<typeof getUserNotificationPreference>>) {
  if (!preference) return defaultPreference;
  return {
    exists: true,
    channel: "telegram" as const,
    enabled: preference.enabled,
    billDueTomorrow: preference.billDueTomorrow,
    billDueToday: preference.billDueToday,
    billOverdue: preference.billOverdue,
    preferredLocalTime: preference.preferredLocalTime,
    timezone: "America/Sao_Paulo" as const,
  };
}

function safeError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return NextResponse.json({ error: "Preferências inválidas." }, { status: 400, headers: privateHeaders });
  }
  if (error instanceof NotificationFoundationError) {
    const status = error.code === "NOTIFICATION_INACTIVE_MEMBERSHIP" ? 403 : 400;
    return NextResponse.json({ error: error.message }, { status, headers: privateHeaders });
  }
  console.error("notification_preferences_failed");
  return NextResponse.json({ error: "Não foi possível atualizar as preferências." }, { status: 500, headers: privateHeaders });
}

export async function GET() {
  try {
    const current = await identity();
    if (current.kind !== "active") return identityError(current.kind);
    const preference = await getUserNotificationPreference({
      d1: current.d1,
      householdId: current.householdId,
      userId: current.userId,
    }, "telegram");
    return NextResponse.json(responsePreference(preference), { headers: privateHeaders });
  } catch (error) {
    return safeError(error);
  }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Origem inválida." }, { status: 403, headers: privateHeaders });
  }
  try {
    const current = await identity();
    if (current.kind !== "active") return identityError(current.kind);
    const input = preferenceSchema.parse(await request.json());
    const preference = await saveUserNotificationPreference({
      d1: current.d1,
      householdId: current.householdId,
      userId: current.userId,
    }, {
      ...input,
      upcomingDigest: false,
    });
    return NextResponse.json(responsePreference(preference), { headers: privateHeaders });
  } catch (error) {
    return safeError(error);
  }
}

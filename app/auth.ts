import { cookies } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { digestToken, generateOpaqueToken } from "@/lib/auth-crypto.mjs";

const SESSION_COOKIE = "finance_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export type AppUser = { id: string; name: string; email: string };

export async function getCurrentUser(): Promise<AppUser | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE)?.value;
  if (!rawToken) return null;

  const sessionId = await digestToken(rawToken);
  const db = getDb();
  const [result] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date().toISOString()), eq(users.status, "active")))
    .limit(1);
  return result ?? null;
}

export async function createSession(userId: string, request: Request) {
  const rawToken = generateOpaqueToken();
  const sessionId = await digestToken(rawToken);
  const timestamp = new Date();
  const expiresAt = new Date(timestamp.getTime() + SESSION_TTL_SECONDS * 1000);
  const db = getDb();
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt: expiresAt.toISOString(),
    createdAt: timestamp.toISOString(),
    lastSeenAt: timestamp.toISOString(),
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function revokeCurrentSession(request: Request) {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE)?.value;
  if (rawToken) {
    const db = getDb();
    await db.update(sessions).set({ revokedAt: new Date().toISOString() }).where(eq(sessions.id, await digestToken(rawToken)));
  }
  cookieStore.set(SESSION_COOKIE, "", { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "lax", path: "/", maxAge: 0 });
}

export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

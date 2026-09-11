import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { createSession, isSameOriginRequest, revokeCurrentSession } from "@/app/auth";
import { getDb } from "@/db";
import { authRateLimits, passwordCredentials, passwordRecoveryCodes, sessions, users } from "@/db/schema";
import { digestToken, generateRecoveryCode, hashPassword, normalizeEmail, normalizeRecoveryCode, verifyPassword } from "@/lib/auth-crypto.mjs";

export const dynamic = "force-dynamic";

const passwordSchema = z.string().min(8, "Use pelo menos 8 caracteres.").max(128, "A senha é muito longa.");
const credentialsSchema = z.object({ email: z.string().email().transform(normalizeEmail), password: passwordSchema });
const DUMMY_PASSWORD_HASH = "pbkdf2-sha256$310000$Qe93BgMITluBPHwUZN5WpQ$0LFKj3CvebZyTC5WH6x2jlBF6WXVdDyN2O7YlDW_wlI";
const timestamp = () => new Date().toISOString();

class AuthFailure extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function consumeAttempt(request: Request, scope: string, identity: string, maximum = 8, windowMinutes = 15) {
  const db = getDb();
  const clientAddress = request.headers.get("cf-connecting-ip") ?? "local";
  const key = `${scope}:${await digestToken(`${identity}:${clientAddress}`)}`;
  const [current] = await db.select().from(authRateLimits).where(eq(authRateLimits.key, key)).limit(1);
  const currentTime = new Date();
  const windowMilliseconds = windowMinutes * 60_000;
  if (current?.blockedUntil && new Date(current.blockedUntil) > currentTime) throw new AuthFailure("Muitas tentativas. Aguarde alguns minutos.", 429);

  if (!current || currentTime.getTime() - new Date(current.windowStartedAt).getTime() >= windowMilliseconds) {
    if (current) await db.update(authRateLimits).set({ attempts: 1, windowStartedAt: currentTime.toISOString(), blockedUntil: null, updatedAt: currentTime.toISOString() }).where(eq(authRateLimits.key, key));
    else await db.insert(authRateLimits).values({ key, attempts: 1, windowStartedAt: currentTime.toISOString(), updatedAt: currentTime.toISOString() });
  } else {
    const attempts = current.attempts + 1;
    await db.update(authRateLimits).set({ attempts, blockedUntil: attempts > maximum ? new Date(currentTime.getTime() + windowMilliseconds).toISOString() : null, updatedAt: currentTime.toISOString() }).where(eq(authRateLimits.key, key));
    if (attempts > maximum) throw new AuthFailure("Muitas tentativas. Aguarde alguns minutos.", 429);
  }
  return key;
}

async function clearAttempts(key: string) {
  await getDb().delete(authRateLimits).where(eq(authRateLimits.key, key));
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Origem da solicitação inválida." }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = z.enum(["register", "login", "logout", "reset_password"]).parse(body.action);
    if (action === "logout") {
      await revokeCurrentSession(request);
      return NextResponse.json({ ok: true });
    }

    if (action === "register") {
      const parsed = credentialsSchema.extend({
        name: z.string().trim().min(2).max(120),
        passwordConfirmation: z.string(),
        legacyClaimCode: z.string().trim().max(160).optional(),
      }).superRefine((value, context) => {
        if (value.password !== value.passwordConfirmation) context.addIssue({ code: "custom", path: ["passwordConfirmation"], message: "As senhas não coincidem." });
      }).parse(body);
      const rateKey = await consumeAttempt(request, "register", parsed.email, 5, 60);
      const db = getDb();
      const [existingUser] = await db.select().from(users).where(eq(users.email, parsed.email)).limit(1);
      const [existingCredential] = existingUser ? await db.select().from(passwordCredentials).where(eq(passwordCredentials.userId, existingUser.id)).limit(1) : [];
      if (existingCredential) throw new AuthFailure("Já existe uma conta com este e-mail.", 409);

      const requestUrl = new URL(request.url);
      const localClaimSecret = requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1" ? "DESENVOLVIMENTO-LOCAL" : "";
      const claimSecret = env.LEGACY_ACCOUNT_CLAIM_SECRET || localClaimSecret;
      if (existingUser && (!claimSecret || parsed.legacyClaimCode !== claimSecret)) {
        throw new AuthFailure("Este e-mail possui dados anteriores. Informe o código de ativação para preservá-los.", 409, "activation_required");
      }

      const userId = existingUser?.id ?? `user_${crypto.randomUUID()}`;
      const createdAt = timestamp();
      const passwordHash = await hashPassword(parsed.password);
      const recoveryCode = generateRecoveryCode();
      const recoveryHash = await digestToken(normalizeRecoveryCode(recoveryCode));
      if (existingUser) {
        await db.update(users).set({ name: parsed.name, status: "active", updatedAt: createdAt }).where(eq(users.id, userId));
      } else {
        await db.insert(users).values({ id: userId, name: parsed.name, email: parsed.email, createdAt, updatedAt: createdAt });
      }
      await db.insert(passwordCredentials).values({ userId, passwordHash, passwordChangedAt: createdAt, createdAt, updatedAt: createdAt });
      await db.insert(passwordRecoveryCodes).values({ userId, codeHash: recoveryHash, createdAt, updatedAt: createdAt });
      await createSession(userId, request);
      await clearAttempts(rateKey);
      return NextResponse.json({ ok: true, recoveryCode });
    }

    if (action === "login") {
      const parsed = credentialsSchema.parse(body);
      const rateKey = await consumeAttempt(request, "login", parsed.email);
      const db = getDb();
      const [user] = await db.select().from(users).where(and(eq(users.email, parsed.email), eq(users.status, "active"))).limit(1);
      const [credential] = user ? await db.select().from(passwordCredentials).where(eq(passwordCredentials.userId, user.id)).limit(1) : [];
      const valid = await verifyPassword(parsed.password, credential?.passwordHash ?? DUMMY_PASSWORD_HASH);
      if (!user || !credential || !valid) throw new AuthFailure("E-mail ou senha inválidos.", 401);
      await createSession(user.id, request);
      await clearAttempts(rateKey);
      return NextResponse.json({ ok: true });
    }

    const parsed = credentialsSchema.extend({
      recoveryCode: z.string().trim().min(16).max(80),
      passwordConfirmation: z.string(),
    }).superRefine((value, context) => {
      if (value.password !== value.passwordConfirmation) context.addIssue({ code: "custom", path: ["passwordConfirmation"], message: "As senhas não coincidem." });
    }).parse(body);
    await consumeAttempt(request, "password-reset", parsed.email, 5, 30);
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.email, parsed.email)).limit(1);
    const [credential] = user ? await db.select().from(passwordCredentials).where(eq(passwordCredentials.userId, user.id)).limit(1) : [];
    const [recovery] = user ? await db.select().from(passwordRecoveryCodes).where(eq(passwordRecoveryCodes.userId, user.id)).limit(1) : [];
    const suppliedHash = await digestToken(normalizeRecoveryCode(parsed.recoveryCode));
    if (!user || !credential || !recovery || suppliedHash !== recovery.codeHash) throw new AuthFailure("Não foi possível validar o e-mail e o código de recuperação.", 401);

    const changedAt = timestamp();
    const newRecoveryCode = generateRecoveryCode();
    await db.update(passwordCredentials).set({ passwordHash: await hashPassword(parsed.password), passwordChangedAt: changedAt, updatedAt: changedAt }).where(eq(passwordCredentials.userId, user.id));
    await db.update(passwordRecoveryCodes).set({ codeHash: await digestToken(normalizeRecoveryCode(newRecoveryCode)), updatedAt: changedAt }).where(eq(passwordRecoveryCodes.userId, user.id));
    await db.update(sessions).set({ revokedAt: changedAt }).where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
    await createSession(user.id, request);
    return NextResponse.json({ ok: true, recoveryCode: newRecoveryCode });
  } catch (error) {
    if (error instanceof AuthFailure) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Dados inválidos.", details: error.flatten() }, { status: 400 });
    console.error("app_auth_failed", error);
    return NextResponse.json({ error: "Não foi possível concluir a autenticação." }, { status: 500 });
  }
}

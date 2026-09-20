import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getCurrentUser } from "@/app/auth";
import { getDb } from "@/db";
import { householdMembers } from "@/db/schema";
import {
  ACCOUNT_STATEMENT_DEFAULT_LIMIT,
  ACCOUNT_STATEMENT_MAX_LIMIT,
  AccountStatementError,
  getAccountStatement,
} from "@/lib/account-statement-service";
import type { AccountStatementInput } from "@/lib/account-statement-types";
import { dateInTimeZone } from "@/lib/finance-analytics.mjs";

export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
};
const allowedParameters = new Set(["accountId", "period", "from", "to", "eventType", "cursor", "limit"]);
const identifier = z.string().min(1).max(100).refine(
  (value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value),
  "Identificador de conta inválido.",
);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Data inválida.").refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}, "Data inválida.");
const limit = z.preprocess(
  (value) => value ?? String(ACCOUNT_STATEMENT_DEFAULT_LIMIT),
  z.string().regex(/^[1-9]\d{0,2}$/u, "Limite inválido.").transform(Number)
    .refine((value) => value <= ACCOUNT_STATEMENT_MAX_LIMIT, "Limite inválido."),
);
const querySchema = z.object({
  accountId: identifier,
  period: z.enum(["last_30_days", "this_month", "custom"]).default("this_month"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  eventType: z.enum(["all", "income", "expense", "invoice_payment", "invoice_payment_reversal"]).default("all"),
  cursor: z.string().min(1).max(4_096).regex(/^[A-Za-z0-9_-]+$/u, "Cursor inválido.").optional(),
  limit,
}).strict().superRefine((value, context) => {
  if (value.period === "custom") {
    if (!value.from) context.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "Período personalizado exige data inicial." });
    if (!value.to) context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Período personalizado exige data final." });
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "A data final deve ser igual ou posterior à inicial." });
    }
  } else if (value.from || value.to) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Datas explícitas só podem ser usadas com period=custom." });
  }
});

class AccountStatementQueryError extends Error {}

function privateJson(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { ...privateHeaders, ...init?.headers } });
}

function uniqueParameters(searchParams: URLSearchParams) {
  const raw: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    if (!allowedParameters.has(key) || Object.hasOwn(raw, key)) {
      throw new AccountStatementQueryError("Parâmetros inválidos ou ambíguos.");
    }
    raw[key] = value;
  }
  return raw;
}

function subtractCivilDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day - days));
  return result.toISOString().slice(0, 10);
}

function resolvePeriod(period: "last_30_days" | "this_month" | "custom", from?: string, to?: string) {
  if (period === "custom") return { from: from!, to: to! };
  const today = dateInTimeZone(new Date());
  return period === "this_month"
    ? { from: `${today.slice(0, 7)}-01`, to: today }
    : { from: subtractCivilDays(today, 29), to: today };
}

async function identity() {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  const d1 = env.DB;
  if (!d1) throw new Error("Binding DB não configurado.");
  const db = getDb();
  const [membership] = await db.select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active")))
    .limit(1);
  if (!membership) return { kind: "forbidden" as const };
  return { kind: "authorized" as const, d1, householdId: membership.householdId };
}

export async function GET(request: Request) {
  try {
    const current = await identity();
    if (current.kind === "unauthenticated") return privateJson({ error: "Não autenticado" }, { status: 401 });
    if (current.kind === "forbidden") return privateJson({ error: "Não autorizado" }, { status: 403 });

    const parsed = querySchema.parse(uniqueParameters(new URL(request.url).searchParams));
    const period = resolvePeriod(parsed.period, parsed.from, parsed.to);
    const input: AccountStatementInput = {
      accountId: parsed.accountId,
      from: period.from,
      to: period.to,
      eventType: parsed.eventType,
      limit: parsed.limit,
      cursor: parsed.cursor,
    };
    return privateJson(await getAccountStatement(input, {
      d1: current.d1,
      householdId: current.householdId,
      now: new Date(),
    }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return privateJson({ error: error.issues[0]?.message ?? "Parâmetros inválidos.", code: "ACCOUNT_STATEMENT_VALIDATION" }, { status: 400 });
    }
    if (error instanceof AccountStatementQueryError) {
      return privateJson({ error: error.message, code: "ACCOUNT_STATEMENT_VALIDATION" }, { status: 400 });
    }
    if (error instanceof AccountStatementError) {
      return privateJson({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("account_statement_failed", error);
    return privateJson({ error: "Não foi possível carregar o extrato da conta." }, { status: 500 });
  }
}

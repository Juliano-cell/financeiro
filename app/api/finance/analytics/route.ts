import { NextResponse } from "next/server";
import { z } from "zod";
import { FinanceAnalyticsValidationError, getFinanceAnalytics, resolveAuthenticatedAnalyticsContext } from "@/lib/finance-analytics-service";
import type { AnalyticsFilters } from "@/lib/finance-analytics-types";

export const dynamic = "force-dynamic";

const identifier = z.string().trim().min(1).max(100);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const querySchema = z.object({
  view: z.enum(["dashboard", "report"]).default("dashboard"),
  period: z.enum(["this_month", "previous_month", "last_3_months", "last_6_months", "last_12_months", "custom"]).default("this_month"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  categoryId: identifier.optional(),
  subcategoryId: identifier.optional(),
  accountId: identifier.optional(),
  type: z.enum(["income", "expense"]).optional(),
  responsibleUserId: identifier.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict().superRefine((value, context) => {
  if (value.period === "custom" && (!value.from || !value.to)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Período personalizado exige data inicial e final." });
  if (value.period !== "custom" && (value.from || value.to)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Datas personalizadas só podem ser usadas com period=custom." });
});

function privateJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Cookie");
  return response;
}

export async function GET(request: Request) {
  try {
    const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
    const parsed = querySchema.parse(raw) as AnalyticsFilters;
    const identity = await resolveAuthenticatedAnalyticsContext();
    if (identity.status === "unauthenticated") return privateJson({ error: "Não autenticado" }, { status: 401 });
    if (identity.status === "no_active_household") return privateJson({ error: "Nenhuma família ativa encontrada." }, { status: 409 });
    return privateJson(await getFinanceAnalytics(identity.context, parsed));
  } catch (error) {
    if (error instanceof z.ZodError) return privateJson({ error: "Filtros inválidos.", details: error.flatten() }, { status: 400 });
    if (error instanceof FinanceAnalyticsValidationError) return privateJson({ error: error.message }, { status: 400 });
    console.error("finance_analytics_failed", error);
    return privateJson({ error: "Não foi possível carregar a análise financeira." }, { status: 500 });
  }
}

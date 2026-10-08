import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { FinanceAnalyticsIntegrityError, resolveAuthenticatedAnalyticsContext } from "@/lib/finance-analytics-service";
import { FinanceForecastIntegrityError } from "@/lib/finance-forecast-service";
import { InvoiceServiceError } from "@/lib/invoice-service";
import {
  ChatGptFinancialSummaryIntegrityError,
  ChatGptFinancialSummaryValidationError,
  getChatGptFinancialSummary,
} from "@/lib/chatgpt-financial-summary-service";

export const dynamic = "force-dynamic";

const monthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u, "Competência inválida.");

function privateJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Cookie");
  return response;
}

function parseMonth(url: string) {
  const parameters = new URL(url).searchParams;
  for (const key of parameters.keys()) {
    if (key !== "month") throw new z.ZodError([{ code: "custom", path: [key], message: "Parâmetro desconhecido." }]);
  }
  if (parameters.getAll("month").length > 1) {
    throw new z.ZodError([{ code: "custom", path: ["month"], message: "Parâmetro repetido." }]);
  }
  const raw = parameters.get("month");
  return raw === null ? undefined : monthSchema.parse(raw);
}

export async function GET(request: Request) {
  const asOf = new Date();
  try {
    const month = parseMonth(request.url);
    const identity = await resolveAuthenticatedAnalyticsContext();
    if (identity.status === "unauthenticated") return privateJson({ error: "Não autenticado" }, { status: 401 });
    if (identity.status === "no_active_household") return privateJson({ error: "Nenhuma família ativa encontrada." }, { status: 409 });
    if (!env.DB) throw new Error("D1 binding indisponível");
    const summary = await getChatGptFinancialSummary({
      d1: env.DB,
      householdId: identity.context.householdId,
      userId: identity.context.userId,
      householdCreatedAt: identity.context.householdCreatedAt,
      now: asOf,
    }, month);
    return privateJson({
      month: summary.month,
      generatedAt: summary.generatedAt,
      asOfDate: summary.asOfDate,
      summaryText: summary.summaryText,
      warnings: summary.warnings,
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof ChatGptFinancialSummaryValidationError) {
      return privateJson({ error: "Parâmetros inválidos." }, { status: 400 });
    }
    if (error instanceof ChatGptFinancialSummaryIntegrityError
      || error instanceof FinanceAnalyticsIntegrityError
      || error instanceof FinanceForecastIntegrityError
      || error instanceof InvoiceServiceError) {
      return privateJson({ error: "Os dados financeiros mudaram ou estão inconsistentes. Atualize e tente novamente." }, { status: 409 });
    }
    console.error("chatgpt_financial_summary_failed");
    return privateJson({ error: "Não foi possível gerar o resumo financeiro." }, { status: 500 });
  }
}

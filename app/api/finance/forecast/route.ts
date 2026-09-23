import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveAuthenticatedAnalyticsContext } from "@/lib/finance-analytics-service";
import {
  FinanceForecastIntegrityError,
  FORECAST_DEFAULT_MONTHS,
  FORECAST_MAX_MONTHS,
  getFinanceForecast,
} from "@/lib/finance-forecast-service";

export const dynamic = "force-dynamic";

const monthsSchema = z.string()
  .regex(/^([1-9]|1[0-9]|2[0-4])$/u, `months deve ser um inteiro entre 1 e ${FORECAST_MAX_MONTHS}.`)
  .transform(Number);

function privateJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Cookie");
  return response;
}

function parseMonths(url: string) {
  const parameters = new URL(url).searchParams;
  for (const key of parameters.keys()) if (key !== "months") throw new z.ZodError([{ code: "custom", path: [key], message: "Parâmetro desconhecido." }]);
  if (parameters.getAll("months").length > 1) throw new z.ZodError([{ code: "custom", path: ["months"], message: "Parâmetro repetido." }]);
  const raw = parameters.get("months");
  return raw === null ? FORECAST_DEFAULT_MONTHS : monthsSchema.parse(raw);
}

export async function GET(request: Request) {
  const asOf = new Date();
  try {
    const months = parseMonths(request.url);
    const identity = await resolveAuthenticatedAnalyticsContext();
    if (identity.status === "unauthenticated") return privateJson({ error: "Não autenticado" }, { status: 401 });
    if (identity.status === "no_active_household") return privateJson({ error: "Nenhuma família ativa encontrada." }, { status: 409 });
    if (!env.DB) throw new Error("D1 binding indisponível");
    return privateJson(await getFinanceForecast({ d1: env.DB, householdId: identity.context.householdId, now: asOf }, months));
  } catch (error) {
    if (error instanceof z.ZodError) return privateJson({ error: "Parâmetros inválidos.", details: error.flatten() }, { status: 400 });
    if (error instanceof FinanceForecastIntegrityError) return privateJson({ error: error.message }, { status: 409 });
    console.error("finance_forecast_failed", error);
    return privateJson({ error: "Não foi possível carregar a previsão financeira." }, { status: 500 });
  }
}

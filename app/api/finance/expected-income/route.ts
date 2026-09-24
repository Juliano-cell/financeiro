import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getCurrentUser, isSameOriginRequest } from "@/app/auth";
import { getDb } from "@/db";
import { householdMembers } from "@/db/schema";
import { dateInTimeZone } from "@/lib/finance-analytics.mjs";
import { expectedIncomeTiming } from "@/lib/expected-income-rules.mjs";
import {
  cancelExpectedIncome,
  createExpectedIncome,
  createRecurringExpectedIncome,
  ExpectedIncomeServiceError,
  materializeExpectedIncomeSeries,
  receiveExpectedIncome,
  reverseExpectedIncomeReceipt,
  updateExpectedIncome,
} from "@/lib/expected-income-service";

export const dynamic = "force-dynamic";

const MAX_PAYLOAD_BYTES = 32 * 1024;
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Vary: "Cookie" };
const identifier = z.string().trim().min(1, "Identificador obrigatório.").max(100);
const operationId = z.string().trim().min(1, "Identificação da operação obrigatória.").max(200);
const civilDate = z.string().date("Data inválida.");
const money = z.number().int().safe().min(1, "Informe um valor válido.").max(100_000_000_000);
const optionalId = identifier.nullable().optional();
const fields = {
  description: z.string().trim().min(1, "Informe a descrição.").max(120),
  expectedAmountCents: money,
  plannedAccountId: optionalId,
  categoryId: optionalId,
  subcategoryId: optionalId,
  notes: z.string().max(500).nullable().optional(),
};
const classified = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict().superRefine((value, context) => {
  if (value.subcategoryId && !value.categoryId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["subcategoryId"], message: "A subcategoria exige uma categoria." });
});
const actionSchema = z.union([
  classified({ action: z.literal("create_occurrence"), operationId, ...fields, expectedDate: civilDate }),
  classified({ action: z.literal("create_recurring_series"), operationId, ...fields, configuredDay: z.number().int().min(1).max(31), startsOn: civilDate, endsOn: civilDate.nullable().optional() }),
  classified({ action: z.literal("update_occurrence"), operationId, occurrenceId: identifier, ...fields, expectedDate: civilDate }),
  z.object({ action: z.literal("receive_occurrence"), operationId, occurrenceId: identifier, receivedAmountCents: money, receivedDate: civilDate, actualAccountId: identifier }).strict(),
  z.object({ action: z.literal("reverse_receipt"), operationId, occurrenceId: identifier, reversalDate: civilDate }).strict(),
  z.object({ action: z.literal("cancel_occurrence"), operationId, occurrenceId: identifier }).strict(),
  z.object({ action: z.literal("materialize_series"), operationId, seriesId: identifier, throughMonth: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u, "Mês final inválido.") }).strict(),
]);

type ExpectedIncomeRow = {
  id: string;
  series_id: string | null;
  occurrence_month: string | null;
  description: string;
  expected_amount_cents: number;
  expected_date: string;
  planned_account_id: string | null;
  planned_account_name: string | null;
  category_id: string | null;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  notes: string | null;
  status: "pending" | "received" | "cancelled";
  received_transaction_id: string | null;
  received_amount_cents: number | null;
  received_date: string | null;
  actual_account_id: string | null;
  actual_account_name: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  configured_day: number | null;
  starts_on: string | null;
  ends_on: string | null;
  materialized_through_month: string | null;
  series_is_active: number | null;
};

async function identity() {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  if (!env.DB) throw new Error("Binding DB não configurado.");
  const db = getDb();
  const [membership] = await db.select({ householdId: householdMembers.householdId }).from(householdMembers)
    .where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active"))).limit(1);
  if (!membership) return { kind: "forbidden" as const };
  return { kind: "authorized" as const, d1: env.DB, userId: user.id, householdId: membership.householdId };
}

function privateJson(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { ...privateHeaders, ...init?.headers } });
}

async function readJson(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAYLOAD_BYTES) throw new ExpectedIncomeServiceError("Payload muito grande.");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ExpectedIncomeServiceError("O corpo deve ser JSON.");
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > MAX_PAYLOAD_BYTES) throw new ExpectedIncomeServiceError("Payload muito grande.");
  try { return JSON.parse(source) as unknown; }
  catch { throw new ExpectedIncomeServiceError("JSON inválido."); }
}

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError) return privateJson({ error: error.issues[0]?.message ?? "Dados inválidos.", code: "EXPECTED_INCOME_VALIDATION" }, { status: 400 });
  if (error instanceof ExpectedIncomeServiceError) {
    const message = error.status === 403 ? "Não autorizado." : error.message;
    return privateJson({ error: message, code: error.code ?? "EXPECTED_INCOME_VALIDATION" }, { status: error.status });
  }
  console.error("expected_income_failed");
  return privateJson({ error: "Não foi possível concluir a operação com a entrada prevista.", code: "EXPECTED_INCOME_INTERNAL" }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    if (new URL(request.url).searchParams.size) throw new z.ZodError([{ code: "custom", path: ["query"], message: "Parâmetros não são aceitos." }]);
    const current = await identity();
    if (current.kind === "unauthenticated") return privateJson({ error: "Não autenticado" }, { status: 401 });
    if (current.kind === "forbidden") return privateJson({ error: "Não autorizado" }, { status: 403 });
    const rows = await current.d1.prepare(`SELECT
      o.id, o.series_id, o.occurrence_month, o.description, o.expected_amount_cents, o.expected_date,
      o.planned_account_id, pa.name AS planned_account_name, o.category_id, c.name AS category_name,
      o.subcategory_id, sc.name AS subcategory_name, o.notes, o.status, o.received_transaction_id,
      t.amount_cents AS received_amount_cents, t.transaction_date AS received_date,
      t.account_id AS actual_account_id, aa.name AS actual_account_name, o.received_at, o.cancelled_at,
      o.created_at, o.updated_at, s.configured_day, s.starts_on, s.ends_on,
      s.materialized_through_month, s.is_active AS series_is_active
    FROM expected_income_occurrences o
    LEFT JOIN expected_income_series s ON s.household_id = o.household_id AND s.id = o.series_id
    LEFT JOIN accounts pa ON pa.household_id = o.household_id AND pa.id = o.planned_account_id
    LEFT JOIN categories c ON c.household_id = o.household_id AND c.id = o.category_id
    LEFT JOIN subcategories sc ON sc.household_id = o.household_id AND sc.id = o.subcategory_id
    LEFT JOIN transactions t ON t.household_id = o.household_id AND t.id = o.received_transaction_id
    LEFT JOIN accounts aa ON aa.household_id = o.household_id AND aa.id = t.account_id
    WHERE o.household_id = ?
    ORDER BY o.expected_date DESC, o.created_at DESC, o.id DESC`).bind(current.householdId).all<ExpectedIncomeRow>();
    const today = dateInTimeZone(new Date(), "America/Sao_Paulo");
    return privateJson({
      today,
      occurrences: rows.results.map((row) => ({
        id: row.id,
        seriesId: row.series_id,
        occurrenceMonth: row.occurrence_month,
        description: row.description,
        expectedAmountCents: row.expected_amount_cents,
        expectedDate: row.expected_date,
        plannedAccount: row.planned_account_id ? { id: row.planned_account_id, name: row.planned_account_name ?? "Conta indisponível" } : null,
        category: row.category_id ? { id: row.category_id, name: row.category_name ?? "Categoria indisponível" } : null,
        subcategory: row.subcategory_id ? { id: row.subcategory_id, name: row.subcategory_name ?? "Subcategoria indisponível" } : null,
        notes: row.notes,
        status: row.status,
        timing: expectedIncomeTiming(row.status, row.expected_date, today),
        receivedTransaction: row.received_transaction_id ? {
          id: row.received_transaction_id,
          amountCents: row.received_amount_cents,
          receivedDate: row.received_date,
          actualAccount: row.actual_account_id ? { id: row.actual_account_id, name: row.actual_account_name ?? "Conta indisponível" } : null,
        } : null,
        receivedAt: row.received_at,
        cancelledAt: row.cancelled_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        recurrence: row.series_id ? {
          type: "monthly",
          configuredDay: row.configured_day,
          startsOn: row.starts_on,
          endsOn: row.ends_on,
          materializedThroughMonth: row.materialized_through_month,
          isActive: row.series_is_active === 1,
        } : null,
      })),
    });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return privateJson({ error: "Origem da solicitação inválida." }, { status: 403 });
  try {
    const current = await identity();
    if (current.kind === "unauthenticated") return privateJson({ error: "Não autenticado" }, { status: 401 });
    if (current.kind === "forbidden") return privateJson({ error: "Não autorizado" }, { status: 403 });
    const input = actionSchema.parse(await readJson(request));
    let result: unknown;
    switch (input.action) {
      case "create_occurrence": result = await createExpectedIncome(input, current); break;
      case "create_recurring_series": result = await createRecurringExpectedIncome(input, current); break;
      case "update_occurrence": result = await updateExpectedIncome(input, current); break;
      case "receive_occurrence": result = await receiveExpectedIncome(input, current); break;
      case "reverse_receipt": result = await reverseExpectedIncomeReceipt(input, current); break;
      case "cancel_occurrence": result = await cancelExpectedIncome(input, current); break;
      case "materialize_series": result = await materializeExpectedIncomeSeries(input, current); break;
    }
    const created = input.action === "create_occurrence" || input.action === "create_recurring_series";
    const replayed = Boolean(result && typeof result === "object" && "replayed" in result && result.replayed);
    return privateJson(result, { status: created && !replayed ? 201 : 200 });
  } catch (error) { return errorResponse(error); }
}

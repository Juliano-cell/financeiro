import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getCurrentUser, isSameOriginRequest } from "@/app/auth";
import { getDb } from "@/db";
import { householdMembers } from "@/db/schema";
import { addExistingCardInstallment, CardOnboardingError } from "@/lib/card-onboarding-service";

export const dynamic = "force-dynamic";

const privateHeaders = { "Cache-Control": "private, no-store" };
const MAX_PAYLOAD_BYTES = 32 * 1024;
const identifier = z.string().min(1).max(100);
const money = z.number().int().safe().min(1).max(100_000_000_000);
const optionalId = identifier.nullable().optional();
const payloadSchema = z.object({
  cardId: identifier,
  firstReferenceMonth: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u, "Competência inválida."),
  idempotencyKey: z.string().min(1).max(200),
  description: z.string().trim().min(1).max(120),
  installmentAmountCents: money,
  originalInstallmentCount: z.number().int().min(1).max(120),
  firstOriginalInstallmentNumber: z.number().int().min(1).max(120),
  originalTotalCents: money.nullable().optional(),
  originalPurchaseDate: z.string().date().nullable().optional(),
  categoryId: optionalId,
  subcategoryId: optionalId,
  notes: z.string().trim().max(500).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.firstOriginalInstallmentNumber > value.originalInstallmentCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["firstOriginalInstallmentNumber"], message: "A primeira parcela não pode ser maior que o total." });
  }
  if (value.subcategoryId && !value.categoryId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subcategoryId"], message: "A subcategoria exige uma categoria." });
  }
});

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
  return { kind: "authorized" as const, d1, userId: user.id, householdId: membership.householdId };
}

async function readJson(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAYLOAD_BYTES) throw new CardOnboardingError("Payload muito grande.");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new CardOnboardingError("O corpo deve ser JSON.");
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > MAX_PAYLOAD_BYTES) throw new CardOnboardingError("Payload muito grande.");
  try { return JSON.parse(source) as unknown; }
  catch { throw new CardOnboardingError("JSON inválido."); }
}

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Dados inválidos.", code: "CARD_IMPORT_VALIDATION" }, { status: 400, headers: privateHeaders });
  if (error instanceof CardOnboardingError) {
    return NextResponse.json({ error: error.status === 403 ? "Não autorizado." : error.message, code: error.code }, { status: error.status, headers: privateHeaders });
  }
  console.error("card_existing_installment_failed", error);
  return NextResponse.json({ error: "Não foi possível adicionar o parcelamento existente.", code: "CARD_IMPORT_INTERNAL" }, { status: 500, headers: privateHeaders });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Origem da solicitação inválida." }, { status: 403, headers: privateHeaders });
  try {
    const current = await identity();
    if (current.kind === "unauthenticated") return NextResponse.json({ error: "Não autenticado" }, { status: 401, headers: privateHeaders });
    if (current.kind === "forbidden") return NextResponse.json({ error: "Não autorizado" }, { status: 403, headers: privateHeaders });
    const parsed = payloadSchema.parse(await readJson(request));
    const result = await addExistingCardInstallment({
      cardId: parsed.cardId,
      firstReferenceMonth: parsed.firstReferenceMonth,
      idempotencyKey: parsed.idempotencyKey,
      commitment: {
        description: parsed.description,
        installmentAmountCents: parsed.installmentAmountCents,
        originalInstallmentCount: parsed.originalInstallmentCount,
        firstOriginalInstallmentNumber: parsed.firstOriginalInstallmentNumber,
        originalTotalCents: parsed.originalTotalCents,
        originalPurchaseDate: parsed.originalPurchaseDate,
        categoryId: parsed.categoryId,
        subcategoryId: parsed.subcategoryId,
        notes: parsed.notes,
      },
    }, current);
    return NextResponse.json({
      cardId: result.cardId,
      batchId: result.batchId,
      invoiceId: result.invoiceId,
      firstReferenceMonth: result.initialReferenceMonth,
      importedPurchaseCount: result.importedPurchaseCount,
      importedInstallmentCount: result.importedInstallmentCount,
      status: "completed",
      replayed: result.replayed,
    }, { status: 201, headers: privateHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

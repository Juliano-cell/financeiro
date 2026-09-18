import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getCurrentUser, isSameOriginRequest } from "@/app/auth";
import { getDb } from "@/db";
import { householdMembers } from "@/db/schema";
import {
  CardOnboardingError,
  configureCardCurrentState,
  getCardOnboardingEligibility,
} from "@/lib/card-onboarding-service";

export const dynamic = "force-dynamic";

const privateHeaders = { "Cache-Control": "private, no-store" };
const MAX_PAYLOAD_BYTES = 128 * 1024;
const identifier = z.string().min(1).max(100);
const operationKey = z.string().min(1).max(200);
const referenceMonth = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u, "Competência inválida.");
const money = z.number().int().safe().min(1).max(100_000_000_000);
const optionalId = identifier.nullable().optional();

const existingInstallmentSchema = z.object({
  description: z.string().trim().min(1).max(120),
  originalTotalCents: money,
  originalInstallmentCount: z.number().int().min(1).max(120),
  currentInstallmentNumber: z.number().int().min(1).max(120),
  installmentAmountCents: money,
  originalPurchaseDate: z.string().date().nullable().optional(),
  categoryId: optionalId,
  subcategoryId: optionalId,
  notes: z.string().trim().max(500).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.currentInstallmentNumber > value.originalInstallmentCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currentInstallmentNumber"],
      message: "A parcela atual não pode ser maior que o total de parcelas.",
    });
  }
  if (value.subcategoryId && !value.categoryId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subcategoryId"],
      message: "A subcategoria exige uma categoria.",
    });
  }
});

const onboardingSchema = z.object({
  cardId: identifier,
  referenceMonth,
  declaredCurrentInvoiceTotalCents: z.number().int().safe().min(0).max(100_000_000_000),
  idempotencyKey: operationKey,
  existingInstallments: z.array(existingInstallmentSchema).max(50).default([]),
}).strict();

const eligibilityQuerySchema = z.object({ cardId: identifier }).strict();

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

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: error.issues[0]?.message ?? "Dados inválidos.", code: "CARD_ONBOARDING_VALIDATION" },
      { status: 400, headers: privateHeaders },
    );
  }
  if (error instanceof CardOnboardingError) {
    const message = error.status === 403 ? "Não autorizado." : error.message;
    return NextResponse.json({ error: message, code: error.code }, { status: error.status, headers: privateHeaders });
  }
  console.error("card_onboarding_failed", error);
  return NextResponse.json(
    { error: "Não foi possível configurar a situação atual do cartão.", code: "CARD_ONBOARDING_INTERNAL" },
    { status: 500, headers: privateHeaders },
  );
}

async function readJson(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAYLOAD_BYTES) {
    throw new CardOnboardingError("Payload muito grande.", 400, "CARD_ONBOARDING_PAYLOAD_TOO_LARGE");
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new CardOnboardingError("O corpo deve ser JSON.", 400, "CARD_ONBOARDING_CONTENT_TYPE");
  }
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > MAX_PAYLOAD_BYTES) {
    throw new CardOnboardingError("Payload muito grande.", 400, "CARD_ONBOARDING_PAYLOAD_TOO_LARGE");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new CardOnboardingError("JSON inválido.", 400, "CARD_ONBOARDING_INVALID_JSON");
  }
}

export async function GET(request: Request) {
  try {
    const current = await identity();
    if (current.kind === "unauthenticated") return NextResponse.json({ error: "Não autenticado" }, { status: 401, headers: privateHeaders });
    if (current.kind === "forbidden") return NextResponse.json({ error: "Não autorizado" }, { status: 403, headers: privateHeaders });
    const url = new URL(request.url);
    const raw = Object.fromEntries(url.searchParams);
    const parsed = eligibilityQuerySchema.parse(raw);
    const result = await getCardOnboardingEligibility(parsed.cardId, current);
    if (!result.eligible && result.reason === "not_found") {
      return NextResponse.json({ error: "Cartão não encontrado.", code: "CARD_ONBOARDING_CARD_NOT_FOUND" }, { status: 404, headers: privateHeaders });
    }
    return NextResponse.json(
      result.eligible
        ? { cardId: parsed.cardId, eligible: true }
        : { cardId: parsed.cardId, eligible: false, reasonCode: result.reason },
      { headers: privateHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Origem da solicitação inválida." }, { status: 403, headers: privateHeaders });
  }
  try {
    const current = await identity();
    if (current.kind === "unauthenticated") return NextResponse.json({ error: "Não autenticado" }, { status: 401, headers: privateHeaders });
    if (current.kind === "forbidden") return NextResponse.json({ error: "Não autorizado" }, { status: 403, headers: privateHeaders });
    const parsed = onboardingSchema.parse(await readJson(request));
    const result = await configureCardCurrentState({
      cardId: parsed.cardId,
      initialReferenceMonth: parsed.referenceMonth,
      declaredCurrentInvoiceTotalCents: parsed.declaredCurrentInvoiceTotalCents,
      idempotencyKey: parsed.idempotencyKey,
      commitments: parsed.existingInstallments.map((installment) => ({
        description: installment.description,
        originalTotalCents: installment.originalTotalCents,
        originalInstallmentCount: installment.originalInstallmentCount,
        firstOriginalInstallmentNumber: installment.currentInstallmentNumber,
        installmentAmountCents: installment.installmentAmountCents,
        firstReferenceMonth: parsed.referenceMonth,
        originalPurchaseDate: installment.originalPurchaseDate,
        categoryId: installment.categoryId,
        subcategoryId: installment.subcategoryId,
        notes: installment.notes,
      })),
    }, current);
    return NextResponse.json({
      cardId: result.cardId,
      batchId: result.batchId,
      invoiceId: result.invoiceId,
      referenceMonth: result.initialReferenceMonth,
      declaredCurrentInvoiceTotalCents: result.declaredCurrentInvoiceTotalCents,
      openingBalanceCents: result.openingBalanceCents,
      importedPurchaseCount: result.importedPurchaseCount,
      importedInstallmentCount: result.importedInstallmentCount,
      status: "completed",
      replayed: result.replayed,
    }, { status: 201, headers: privateHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

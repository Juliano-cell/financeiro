import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getCurrentUser } from "@/app/auth";
import { getDb } from "@/db";
import { householdMembers } from "@/db/schema";
import { getInvoiceDetail, INVOICE_DETAIL_DEFAULT_PAGE_SIZE, INVOICE_DETAIL_MAX_PAGE_SIZE } from "@/lib/invoice-detail-service";
import { InvoiceServiceError } from "@/lib/invoice-service";

export const dynamic = "force-dynamic";
const privateHeaders = { "Cache-Control": "private, no-store" };
const querySchema = z.object({
  invoiceId: z.string().min(1).max(100),
  activePage: z.coerce.number().int().min(1).max(10_000).default(1),
  cancelledPage: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(INVOICE_DETAIL_MAX_PAGE_SIZE).default(INVOICE_DETAIL_DEFAULT_PAGE_SIZE),
});

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Não autenticado" }, { status: 401, headers: privateHeaders });
  const d1 = env.DB;
  if (!d1) throw new Error("Binding DB não configurado.");
  const db = getDb();
  const [membership] = await db.select({ householdId: householdMembers.householdId }).from(householdMembers)
    .where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active"))).limit(1);
  if (!membership) return NextResponse.json({ error: "Não autorizado" }, { status: 403, headers: privateHeaders });

  try {
    const url = new URL(request.url);
    const parsed = querySchema.parse({
      invoiceId: url.searchParams.get("invoiceId") ?? undefined,
      activePage: url.searchParams.get("activePage") ?? undefined,
      cancelledPage: url.searchParams.get("cancelledPage") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });
    const detail = await getInvoiceDetail(parsed, { d1, householdId: membership.householdId, userId: user.id });
    return NextResponse.json(detail, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof InvoiceServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: privateHeaders });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Parâmetros inválidos.", details: error.flatten() }, { status: 400, headers: privateHeaders });
    console.error("invoice_detail_failed", error);
    return NextResponse.json({ error: "Não foi possível carregar a fatura." }, { status: 500, headers: privateHeaders });
  }
}

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const privateHeaders = { "Cache-Control": "private, no-store" };

/**
 * Compatibilidade temporária para chamadores legados. O motor antigo está
 * desativado: esta rota não consulta finanças, não planeja e não envia.
 */
export async function POST() {
  return NextResponse.json({
    ok: false,
    disabled: true,
    code: "LEGACY_NOTIFICATION_ENGINE_DISABLED",
  }, { status: 410, headers: privateHeaders });
}

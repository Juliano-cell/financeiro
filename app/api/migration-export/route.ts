import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getCurrentUser } from "@/app/auth";
import { getDb } from "@/db";
import { accounts, auditLogs, categories, householdMembers, households, subcategories, transactions, users } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
    const db = getDb();
    const [membership] = await db.select().from(householdMembers).where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active"))).limit(1);
    if (!membership || membership.role !== "owner") return NextResponse.json({ error: "Apenas o responsável da família pode exportar o backup." }, { status: 403 });

    const householdId = membership.householdId;
    const [familyRows, memberRows, accountRows, categoryRows, subcategoryRows, transactionRows, auditRows] = await Promise.all([
      db.select().from(households).where(eq(households.id, householdId)),
      db.select().from(householdMembers).where(eq(householdMembers.householdId, householdId)),
      db.select().from(accounts).where(eq(accounts.householdId, householdId)),
      db.select().from(categories).where(eq(categories.householdId, householdId)),
      db.select().from(subcategories).where(eq(subcategories.householdId, householdId)),
      db.select().from(transactions).where(eq(transactions.householdId, householdId)),
      db.select().from(auditLogs).where(eq(auditLogs.householdId, householdId)),
    ]);
    const relatedUserIds = [...new Set([
      user.id,
      ...familyRows.map((row) => row.createdBy),
      ...memberRows.flatMap((row) => row.userId ? [row.userId] : []),
      ...transactionRows.map((row) => row.responsibleUserId),
      ...auditRows.map((row) => row.userId),
    ])];
    const userRows = relatedUserIds.length ? await db.select().from(users).where(inArray(users.id, relatedUserIds)) : [];
    const backup = {
      format: "nossa-casa-family-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      householdId,
      security: { credentialsIncluded: false, sessionsIncluded: false },
      tables: {
        users: userRows,
        households: familyRows,
        household_members: memberRows,
        accounts: accountRows,
        categories: categoryRows,
        subcategories: subcategoryRows,
        transactions: transactionRows,
        audit_logs: auditRows,
      },
    };
    const date = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(backup, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="nossa-casa-backup-${date}.json"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("migration_export_failed", error);
    return NextResponse.json({ error: "Não foi possível gerar o backup." }, { status: 500 });
  }
}

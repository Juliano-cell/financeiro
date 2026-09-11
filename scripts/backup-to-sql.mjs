import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const tableMappings = [
  ["users", { id: "id", name: "name", email: "email", avatarUrl: "avatar_url", status: "status", createdAt: "created_at", updatedAt: "updated_at" }],
  ["households", { id: "id", name: "name", createdBy: "created_by", createdAt: "created_at", updatedAt: "updated_at" }],
  ["household_members", { id: "id", householdId: "household_id", userId: "user_id", invitedEmail: "invited_email", role: "role", status: "status", joinedAt: "joined_at", createdAt: "created_at" }],
  ["accounts", { id: "id", householdId: "household_id", name: "name", type: "type", initialBalanceCents: "initial_balance_cents", isActive: "is_active", createdAt: "created_at", updatedAt: "updated_at" }],
  ["categories", { id: "id", householdId: "household_id", name: "name", type: "type", color: "color", isActive: "is_active", createdAt: "created_at", updatedAt: "updated_at" }],
  ["subcategories", { id: "id", householdId: "household_id", categoryId: "category_id", name: "name", isActive: "is_active", createdAt: "created_at", updatedAt: "updated_at" }],
  ["transactions", { id: "id", householdId: "household_id", type: "type", amountCents: "amount_cents", description: "description", categoryId: "category_id", subcategoryId: "subcategory_id", transactionDate: "transaction_date", transactionTime: "transaction_time", responsibleUserId: "responsible_user_id", accountId: "account_id", paymentMethod: "payment_method", status: "status", origin: "origin", notes: "notes", createdAt: "created_at", updatedAt: "updated_at" }],
  ["audit_logs", { id: "id", householdId: "household_id", userId: "user_id", action: "action", entityType: "entity_type", entityId: "entity_id", oldData: "old_data", newData: "new_data", createdAt: "created_at" }],
];

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("O backup contém um número inválido.");
    return String(value);
  }
  if (typeof value !== "string") throw new Error("O backup contém um valor não suportado.");
  return `'${value.replaceAll("'", "''")}'`;
}

export function backupToSql(backup) {
  if (!backup || backup.format !== "nossa-casa-family-backup" || backup.version !== 1 || typeof backup.tables !== "object") throw new Error("Formato de backup incompatível.");
  const statements = [
    "-- Importação gerada para um banco D1 novo e já migrado.",
    `-- Família: ${String(backup.householdId ?? "desconhecida").replaceAll("\n", " ")}`,
    "PRAGMA foreign_keys=ON;",
  ];
  for (const [table, mapping] of tableMappings) {
    const rows = backup.tables[table];
    if (!Array.isArray(rows)) throw new Error(`Tabela ausente no backup: ${table}`);
    for (const row of rows) {
      if (!row || typeof row !== "object") throw new Error(`Linha inválida em ${table}.`);
      const entries = Object.entries(mapping).filter(([property]) => Object.hasOwn(row, property));
      if (!entries.length) throw new Error(`Linha sem colunas reconhecidas em ${table}.`);
      const columns = entries.map(([, column]) => `\`${column}\``).join(",");
      const values = entries.map(([property]) => sqlValue(row[property])).join(",");
      const conflictPolicy = table === "users" ? " OR IGNORE" : "";
      statements.push(`INSERT${conflictPolicy} INTO \`${table}\` (${columns}) VALUES (${values});`);
    }
  }
  statements.push("PRAGMA optimize;");
  return `${statements.join("\n")}\n`;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error("Uso: node scripts/backup-to-sql.mjs BACKUP.json migration-import.sql");
  const backup = JSON.parse(readFileSync(inputPath, "utf8"));
  writeFileSync(outputPath, backupToSql(backup), { encoding: "utf8", flag: "wx" });
  console.log(`Arquivo SQL criado em ${outputPath}.`);
}

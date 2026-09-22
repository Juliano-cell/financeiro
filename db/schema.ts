import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, check, foreignKey, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull(), avatarUrl: text("avatar_url"),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const passwordCredentials = sqliteTable("password_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  passwordChangedAt: text("password_changed_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [index("idx_sessions_user").on(table.userId), index("idx_sessions_expires").on(table.expiresAt)]);

export const passwordRecoveryCodes = sqliteTable("password_recovery_codes", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const authRateLimits = sqliteTable("auth_rate_limits", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  windowStartedAt: text("window_started_at").notNull(),
  blockedUntil: text("blocked_until"),
  updatedAt: text("updated_at").notNull(),
});

export const households = sqliteTable("households", {
  id: text("id").primaryKey(), name: text("name").notNull(), createdBy: text("created_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});

export const householdMembers = sqliteTable("household_members", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), userId: text("user_id").references(() => users.id), invitedEmail: text("invited_email"),
  role: text("role", { enum: ["owner", "member"] }).notNull().default("member"), status: text("status", { enum: ["active", "invited", "inactive"] }).notNull().default("invited"), joinedAt: text("joined_at"), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_household_members_household").on(table.householdId), index("idx_household_members_user").on(table.userId), index("idx_household_members_invited_email").on(table.invitedEmail), uniqueIndex("household_members_household_user_unique").on(table.householdId, table.userId)]);

export const householdInviteTokens = sqliteTable("household_invite_tokens", {
  memberId: text("member_id").primaryKey().references(() => householdMembers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("household_invite_tokens_hash_unique").on(table.tokenHash), index("idx_household_invite_tokens_expires").on(table.expiresAt)]);

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), name: text("name").notNull(),
  type: text("type", { enum: ["bank", "cash", "savings", "wallet", "other"] }).notNull(), initialBalanceCents: integer("initial_balance_cents").notNull().default(0), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_accounts_household_active").on(table.householdId, table.isActive), uniqueIndex("accounts_household_name_unique").on(table.householdId, table.name), uniqueIndex("accounts_household_id_unique").on(table.householdId, table.id)]);

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), name: text("name").notNull(),
  type: text("type", { enum: ["income", "expense", "both"] }).notNull().default("expense"), color: text("color").notNull().default("#397f72"), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_categories_household_active").on(table.householdId, table.isActive), uniqueIndex("categories_household_name_unique").on(table.householdId, table.name), uniqueIndex("categories_household_id_unique").on(table.householdId, table.id)]);

export const subcategories = sqliteTable("subcategories", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), categoryId: text("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }), name: text("name").notNull(), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_subcategories_category").on(table.categoryId), uniqueIndex("subcategories_household_category_name_unique").on(table.householdId, table.categoryId, sql`${table.name} collate nocase`)]);

export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), type: text("type", { enum: ["income", "expense"] }).notNull(), amountCents: integer("amount_cents").notNull(), description: text("description").notNull(), categoryId: text("category_id").references(() => categories.id), subcategoryId: text("subcategory_id").references(() => subcategories.id), transactionDate: text("transaction_date").notNull(), transactionTime: text("transaction_time"), responsibleUserId: text("responsible_user_id").notNull().references(() => users.id), accountId: text("account_id").notNull().references(() => accounts.id), paymentMethod: text("payment_method"), status: text("status", { enum: ["confirmed", "pending", "cancelled"] }).notNull().default("confirmed"), origin: text("origin", { enum: ["dashboard", "telegram"] }).notNull().default("dashboard"), notes: text("notes"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_transactions_household_date").on(table.householdId, table.transactionDate), index("idx_transactions_household_status").on(table.householdId, table.status), index("idx_transactions_account").on(table.accountId), index("idx_transactions_category").on(table.categoryId), index("idx_transactions_responsible").on(table.responsibleUserId), uniqueIndex("transactions_household_id_unique").on(table.householdId, table.id)]);

export const creditCards = sqliteTable("credit_cards", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), name: text("name").notNull(), institution: text("institution").notNull(), holder: text("holder").notNull(), limitCents: integer("limit_cents").notNull(), closingDay: integer("closing_day").notNull(), dueDay: integer("due_day").notNull(), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), notes: text("notes"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_credit_cards_household_active").on(table.householdId, table.isActive), uniqueIndex("credit_cards_household_name_unique").on(table.householdId, table.name), unique("credit_cards_household_id_unique").on(table.householdId, table.id), check("credit_cards_limit_check", sql`${table.limitCents} >= 0`), check("credit_cards_closing_day_check", sql`${table.closingDay} between 1 and 31`), check("credit_cards_due_day_check", sql`${table.dueDay} between 1 and 31`), check("credit_cards_active_check", sql`${table.isActive} in (0,1)`)]);

export const cardPurchases = sqliteTable("card_purchases", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), cardId: text("card_id").notNull(), description: text("description").notNull(), totalCents: integer("total_cents").notNull(), purchaseDate: text("purchase_date").notNull(), installmentCount: integer("installment_count").notNull().default(1), categoryId: text("category_id"), subcategoryId: text("subcategory_id").references(() => subcategories.id), notes: text("notes"), status: text("status", { enum: ["active", "cancelled"] }).notNull().default("active"), createdByUserId: text("created_by_user_id").notNull(), origin: text("origin", { enum: ["web", "telegram", "system"] }).notNull().default("web"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_card_purchases_household_date").on(table.householdId, table.purchaseDate), index("idx_card_purchases_card").on(table.cardId), index("idx_card_purchases_household_subcategory").on(table.householdId, table.subcategoryId), unique("card_purchases_household_id_unique").on(table.householdId, table.id), check("card_purchases_total_check", sql`${table.totalCents} > 0`), check("card_purchases_count_check", sql`${table.installmentCount} between 1 and 120`), check("card_purchases_status_check", sql`${table.status} in ('active','cancelled')`), check("card_purchases_origin_check", sql`${table.origin} in ('web','telegram','system')`), foreignKey({ columns: [table.householdId, table.cardId], foreignColumns: [creditCards.householdId, creditCards.id], name: "card_purchases_household_card_fk" }), foreignKey({ columns: [table.householdId, table.categoryId], foreignColumns: [categories.householdId, categories.id], name: "card_purchases_household_category_fk" }), foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "card_purchases_household_creator_fk" })]);

export const cardInvoices = sqliteTable("card_invoices", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), cardId: text("card_id").notNull(), referenceMonth: text("reference_month").notNull(), dueDate: text("due_date").notNull(), closesOn: text("closes_on"), status: text("status", { enum: ["open", "closed", "paid"] }).notNull().default("open"), paidAt: text("paid_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("card_invoices_card_month_unique").on(table.householdId, table.cardId, table.referenceMonth), index("idx_card_invoices_household_due").on(table.householdId, table.dueDate), unique("card_invoices_household_id_unique").on(table.householdId, table.id), check("card_invoices_status_check", sql`${table.status} in ('open','closed','paid')`), check("card_invoices_closes_on_check", sql`${table.closesOn} is null or (length(${table.closesOn}) = 10 and ${table.closesOn} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' and ${table.closesOn} >= '0001-01-01' and date(${table.closesOn}, '+0 days') is not null and date(${table.closesOn}, '+0 days') = ${table.closesOn})`), foreignKey({ columns: [table.householdId, table.cardId], foreignColumns: [creditCards.householdId, creditCards.id], name: "card_invoices_household_card_fk" })]);

export const cardInstallments = sqliteTable("card_installments", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), purchaseId: text("purchase_id").notNull(), invoiceId: text("invoice_id").notNull(), installmentNumber: integer("installment_number").notNull(), installmentCount: integer("installment_count").notNull(), amountCents: integer("amount_cents").notNull(), status: text("status", { enum: ["pending", "paid", "cancelled"] }).notNull().default("pending"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("card_installments_purchase_number_unique").on(table.purchaseId, table.installmentNumber), index("idx_card_installments_household_invoice").on(table.householdId, table.invoiceId), check("card_installments_count_check", sql`${table.installmentCount} between 1 and 120`), check("card_installments_number_check", sql`${table.installmentNumber} between 1 and ${table.installmentCount}`), check("card_installments_amount_check", sql`${table.amountCents} > 0`), check("card_installments_status_check", sql`${table.status} in ('pending','paid','cancelled')`), foreignKey({ columns: [table.householdId, table.purchaseId], foreignColumns: [cardPurchases.householdId, cardPurchases.id], name: "card_installments_household_purchase_fk" }).onDelete("cascade"), foreignKey({ columns: [table.householdId, table.invoiceId], foreignColumns: [cardInvoices.householdId, cardInvoices.id], name: "card_installments_household_invoice_fk" })]);

export const cardImportBatches = sqliteTable("card_import_batches", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  cardId: text("card_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  importKind: text("import_kind", { enum: ["initial_state", "existing_installments"] }).notNull().default("initial_state"),
  initialReferenceMonth: text("initial_reference_month").notNull(),
  declaredInvoiceTotalCents: integer("declared_invoice_total_cents").notNull(),
  openingBalanceCents: integer("opening_balance_cents").notNull(),
  importedPurchaseCount: integer("imported_purchase_count").notNull(),
  importedInstallmentCount: integer("imported_installment_count").notNull(),
  status: text("status", { enum: ["pending", "completed", "voided"] }).notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
  voidedAt: text("voided_at"),
}, (table) => [
  unique("card_import_batches_household_id_unique").on(table.householdId, table.id),
  uniqueIndex("card_import_batches_household_key_unique").on(table.householdId, table.idempotencyKey),
  uniqueIndex("card_import_batches_initial_card_unique").on(table.householdId, table.cardId).where(sql`${table.importKind} = 'initial_state' and ${table.status} in ('pending','completed')`),
  uniqueIndex("card_import_batches_pending_card_unique").on(table.householdId, table.cardId).where(sql`${table.status} = 'pending'`),
  index("idx_card_import_batches_household_created").on(table.householdId, table.createdAt),
  check("card_import_batches_identifiers_check", sql`length(trim(${table.id})) > 0 and length(trim(${table.householdId})) > 0 and length(trim(${table.cardId})) > 0 and length(trim(${table.createdByUserId})) > 0 and length(trim(${table.idempotencyKey})) > 0 and length(trim(${table.requestFingerprint})) > 0`),
  check("card_import_batches_kind_check", sql`${table.importKind} in ('initial_state','existing_installments')`),
  check("card_import_batches_reference_month_check", sql`length(${table.initialReferenceMonth}) = 7 and ${table.initialReferenceMonth} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]' and date(${table.initialReferenceMonth} || '-01', '+0 days') = ${table.initialReferenceMonth} || '-01'`),
  check("card_import_batches_amounts_check", sql`typeof(${table.declaredInvoiceTotalCents}) = 'integer' and typeof(${table.openingBalanceCents}) = 'integer' and ${table.declaredInvoiceTotalCents} between 0 and 9007199254740991 and ${table.openingBalanceCents} between 0 and ${table.declaredInvoiceTotalCents}`),
  check("card_import_batches_counts_check", sql`typeof(${table.importedPurchaseCount}) = 'integer' and ${table.importedPurchaseCount} between 0 and 50 and typeof(${table.importedInstallmentCount}) = 'integer' and ${table.importedInstallmentCount} between 0 and 120`),
  check("card_import_batches_status_check", sql`${table.status} in ('pending','completed','voided')`),
  check("card_import_batches_lifecycle_check", sql`(${table.status} = 'pending' and ${table.completedAt} is null and ${table.voidedAt} is null) or (${table.status} = 'completed' and ${table.completedAt} is not null and ${table.voidedAt} is null) or (${table.status} = 'voided' and ${table.completedAt} is not null and ${table.voidedAt} is not null)`),
  foreignKey({ columns: [table.householdId, table.cardId], foreignColumns: [creditCards.householdId, creditCards.id], name: "card_import_batches_household_card_fk" }),
  foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "card_import_batches_household_creator_fk" }),
]);

export const cardPurchaseImportMetadata = sqliteTable("card_purchase_import_metadata", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  purchaseId: text("purchase_id").notNull(),
  importBatchId: text("import_batch_id").notNull(),
  firstOriginalInstallmentNumber: integer("first_original_installment_number").notNull(),
  originalInstallmentCount: integer("original_installment_count").notNull(),
  originalTotalCents: integer("original_total_cents"),
  originalPurchaseDate: text("original_purchase_date"),
  importedAt: text("imported_at").notNull(),
}, (table) => [
  unique("card_purchase_import_metadata_household_id_unique").on(table.householdId, table.id),
  unique("card_purchase_import_metadata_purchase_unique").on(table.householdId, table.purchaseId),
  index("idx_card_purchase_import_metadata_batch").on(table.householdId, table.importBatchId),
  check("card_purchase_import_metadata_numbers_check", sql`typeof(${table.firstOriginalInstallmentNumber}) = 'integer' and typeof(${table.originalInstallmentCount}) = 'integer' and ${table.firstOriginalInstallmentNumber} between 1 and ${table.originalInstallmentCount} and ${table.originalInstallmentCount} between 1 and 120`),
  check("card_purchase_import_metadata_total_check", sql`${table.originalTotalCents} is null or (typeof(${table.originalTotalCents}) = 'integer' and ${table.originalTotalCents} between 1 and 9007199254740991)`),
  check("card_purchase_import_metadata_date_check", sql`${table.originalPurchaseDate} is null or (length(${table.originalPurchaseDate}) = 10 and ${table.originalPurchaseDate} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' and ${table.originalPurchaseDate} >= '0001-01-01' and date(${table.originalPurchaseDate}, '+0 days') = ${table.originalPurchaseDate})`),
  foreignKey({ columns: [table.householdId, table.purchaseId], foreignColumns: [cardPurchases.householdId, cardPurchases.id], name: "card_purchase_import_metadata_household_purchase_fk" }),
  foreignKey({ columns: [table.householdId, table.importBatchId], foreignColumns: [cardImportBatches.householdId, cardImportBatches.id], name: "card_purchase_import_metadata_household_batch_fk" }),
]);

export const cardInvoiceAdjustments = sqliteTable("card_invoice_adjustments", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  invoiceId: text("invoice_id").notNull(),
  importBatchId: text("import_batch_id").notNull(),
  kind: text("kind", { enum: ["opening_balance"] }).notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status", { enum: ["active", "voided"] }).notNull().default("active"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  voidedAt: text("voided_at"),
}, (table) => [
  unique("card_invoice_adjustments_household_id_unique").on(table.householdId, table.id),
  uniqueIndex("card_invoice_adjustments_active_opening_unique").on(table.householdId, table.invoiceId, table.kind).where(sql`${table.status} = 'active'`),
  index("idx_card_invoice_adjustments_household_invoice").on(table.householdId, table.invoiceId, table.status),
  index("idx_card_invoice_adjustments_batch").on(table.householdId, table.importBatchId),
  check("card_invoice_adjustments_kind_check", sql`${table.kind} = 'opening_balance'`),
  check("card_invoice_adjustments_amount_check", sql`typeof(${table.amountCents}) = 'integer' and ${table.amountCents} between 1 and 9007199254740991`),
  check("card_invoice_adjustments_status_check", sql`${table.status} in ('active','voided')`),
  check("card_invoice_adjustments_void_check", sql`(${table.status} = 'active' and ${table.voidedAt} is null) or (${table.status} = 'voided' and ${table.voidedAt} is not null)`),
  foreignKey({ columns: [table.householdId, table.invoiceId], foreignColumns: [cardInvoices.householdId, cardInvoices.id], name: "card_invoice_adjustments_household_invoice_fk" }),
  foreignKey({ columns: [table.householdId, table.importBatchId], foreignColumns: [cardImportBatches.householdId, cardImportBatches.id], name: "card_invoice_adjustments_household_batch_fk" }),
  foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "card_invoice_adjustments_household_creator_fk" }),
]);

// Unicode White_Space, Cc and Cf characters; char() chunks stay below 127 arguments.
// NUL-only values also fail length(); do not put NUL in SQLite's trim character set.
const invoiceLifecycleBlankCharacters = sql`char(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,173,1536,1537,1538,1539,1540,1541,1564,1757,1807,2192,2193,2274,5760,6158,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8203,8204,8205,8206) || char(8207,8232,8233,8234,8235,8236,8237,8238,8239,8287,8288,8289,8290,8291,8292,8294,8295,8296,8297,8298,8299,8300,8301,8302,8303,12288,65279,65529,65530,65531,69821,69837,78896,78897,78898,78899,78900,78901,78902,78903,78904,78905,78906,78907,78908,78909,78910,78911,113824,113825,113826,113827,119155,119156,119157,119158,119159,119160,119161,119162,917505,917536,917537,917538,917539,917540,917541,917542,917543,917544,917545,917546,917547,917548,917549,917550,917551,917552,917553,917554,917555,917556,917557,917558,917559,917560,917561,917562,917563,917564,917565,917566,917567,917568,917569,917570) || char(917571,917572,917573,917574,917575,917576,917577,917578,917579,917580,917581,917582,917583,917584,917585,917586,917587,917588,917589,917590,917591,917592,917593,917594,917595,917596,917597,917598,917599,917600,917601,917602,917603,917604,917605,917606,917607,917608,917609,917610,917611,917612,917613,917614,917615,917616,917617,917618,917619,917620,917621,917622,917623,917624,917625,917626,917627,917628,917629,917630,917631)`;

// Operations are receipts, not invoice totals. Execution/append-only policy belongs to the future service.
export const invoicePaymentOperations = sqliteTable("invoice_payment_operations", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), idempotencyKey: text("idempotency_key").notNull(), kind: text("kind", { enum: ["payment", "no_payment", "reversal"] }).notNull(), invoiceId: text("invoice_id").notNull(), accountId: text("account_id").notNull(), createdByUserId: text("created_by_user_id").notNull(), amountCents: integer("amount_cents").notNull(), occurredOn: text("occurred_on").notNull(), reversedPaymentId: text("reversed_payment_id"), requestFingerprint: text("request_fingerprint").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("invoice_payment_operations_household_key_unique").on(table.householdId, table.idempotencyKey),
  uniqueIndex("invoice_payment_operations_reversal_unique").on(table.householdId, table.reversedPaymentId).where(sql`${table.kind} = 'reversal'`),
  index("idx_invoice_payment_operations_household_invoice").on(table.householdId, table.invoiceId),
  check("invoice_payment_operations_identifiers_check", sql`length(trim(${table.id}, ${invoiceLifecycleBlankCharacters})) > 0 and length(trim(${table.householdId}, ${invoiceLifecycleBlankCharacters})) > 0 and length(trim(${table.invoiceId}, ${invoiceLifecycleBlankCharacters})) > 0 and length(trim(${table.accountId}, ${invoiceLifecycleBlankCharacters})) > 0 and length(trim(${table.createdByUserId}, ${invoiceLifecycleBlankCharacters})) > 0 and (${table.reversedPaymentId} is null or length(trim(${table.reversedPaymentId}, ${invoiceLifecycleBlankCharacters})) > 0)`),
  check("invoice_payment_operations_key_check", sql`length(trim(${table.idempotencyKey}, ${invoiceLifecycleBlankCharacters})) > 0`),
  check("invoice_payment_operations_fingerprint_check", sql`length(trim(${table.requestFingerprint}, ${invoiceLifecycleBlankCharacters})) > 0`),
  check("invoice_payment_operations_kind_check", sql`${table.kind} in ('payment','no_payment','reversal')`),
  check("invoice_payment_operations_amount_check", sql`typeof(${table.amountCents}) = 'integer' and ${table.amountCents} between 0 and 9007199254740991 and ((${table.kind} = 'no_payment' and ${table.amountCents} = 0) or (${table.kind} in ('payment','reversal') and ${table.amountCents} > 0))`),
  check("invoice_payment_operations_reversal_check", sql`(${table.kind} = 'reversal' and ${table.reversedPaymentId} is not null) or (${table.kind} in ('payment','no_payment') and ${table.reversedPaymentId} is null)`),
  check("invoice_payment_operations_date_check", sql`length(${table.occurredOn}) = 10 and ${table.occurredOn} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' and ${table.occurredOn} >= '0001-01-01' and date(${table.occurredOn}, '+0 days') is not null and date(${table.occurredOn}, '+0 days') = ${table.occurredOn}`),
  foreignKey({ columns: [table.householdId, table.invoiceId], foreignColumns: [cardInvoices.householdId, cardInvoices.id], name: "invoice_payment_operations_household_invoice_fk" }),
  foreignKey({ columns: [table.householdId, table.accountId], foreignColumns: [accounts.householdId, accounts.id], name: "invoice_payment_operations_household_account_fk" }),
  foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "invoice_payment_operations_household_creator_fk" }),
  foreignKey({ columns: [table.householdId, table.reversedPaymentId], foreignColumns: [invoicePayments.householdId, invoicePayments.id], name: "invoice_payment_operations_household_reversed_payment_fk" }),
]);

export const invoicePayments = sqliteTable("invoice_payments", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), invoiceId: text("invoice_id").notNull(), accountId: text("account_id").notNull(), amountCents: integer("amount_cents").notNull(), paidAt: text("paid_at").notNull(), createdByUserId: text("created_by_user_id").notNull(), createdAt: text("created_at").notNull(), operationId: text("operation_id").references((): AnySQLiteColumn => invoicePaymentOperations.id),
}, (table) => [uniqueIndex("invoice_payments_household_id_unique").on(table.householdId, table.id), uniqueIndex("invoice_payments_operation_unique").on(table.operationId).where(sql`${table.operationId} is not null`), uniqueIndex("invoice_payments_legacy_invoice_unique").on(table.invoiceId).where(sql`${table.operationId} is null`), index("idx_invoice_payments_household_invoice").on(table.householdId, table.invoiceId), index("idx_invoice_payments_household_account").on(table.householdId, table.accountId), check("invoice_payments_amount_check", sql`${table.amountCents} > 0`), check("invoice_payments_operation_id_check", sql`${table.operationId} is null or length(trim(${table.operationId}, ${invoiceLifecycleBlankCharacters})) > 0`), foreignKey({ columns: [table.householdId, table.invoiceId], foreignColumns: [cardInvoices.householdId, cardInvoices.id], name: "invoice_payments_household_invoice_fk" }), foreignKey({ columns: [table.householdId, table.accountId], foreignColumns: [accounts.householdId, accounts.id], name: "invoice_payments_household_account_fk" }), foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "invoice_payments_household_creator_fk" })]);

export const recurringBillSeries = sqliteTable("recurring_bill_series", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), description: text("description").notNull(), amountCents: integer("amount_cents").notNull(), categoryId: text("category_id"), subcategoryId: text("subcategory_id").references(() => subcategories.id), accountId: text("account_id"), dayOfMonth: integer("day_of_month").notNull(), startsOn: text("starts_on").notNull(), endsOn: text("ends_on"), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), notes: text("notes"), createdByUserId: text("created_by_user_id").notNull(), origin: text("origin", { enum: ["web", "telegram", "system"] }).notNull().default("web"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_recurring_bill_series_household_active").on(table.householdId, table.isActive), index("idx_recurring_bill_series_household_subcategory").on(table.householdId, table.subcategoryId), unique("recurring_bill_series_household_id_unique").on(table.householdId, table.id), check("recurring_bill_series_amount_check", sql`${table.amountCents} > 0`), check("recurring_bill_series_day_check", sql`${table.dayOfMonth} between 1 and 31`), check("recurring_bill_series_dates_check", sql`${table.endsOn} is null or ${table.endsOn} >= ${table.startsOn}`), check("recurring_bill_series_active_check", sql`${table.isActive} in (0, 1)`), check("recurring_bill_series_origin_check", sql`${table.origin} in ('web','telegram','system')`), foreignKey({ columns: [table.householdId, table.categoryId], foreignColumns: [categories.householdId, categories.id], name: "recurring_bill_series_household_category_fk" }), foreignKey({ columns: [table.householdId, table.accountId], foreignColumns: [accounts.householdId, accounts.id], name: "recurring_bill_series_household_account_fk" }), foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "recurring_bill_series_household_creator_fk" })]);

export const bills = sqliteTable("bills", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), description: text("description").notNull(), amountCents: integer("amount_cents").notNull(), categoryId: text("category_id"), subcategoryId: text("subcategory_id").references(() => subcategories.id), dueDate: text("due_date").notNull(), accountId: text("account_id"), recurrence: text("recurrence", { enum: ["none", "monthly"] }).notNull().default("none"), recurrenceSeriesId: text("recurrence_series_id"), recurrenceEndDate: text("recurrence_end_date"), notes: text("notes"), status: text("status", { enum: ["pending", "paid", "cancelled"] }).notNull().default("pending"), paidAt: text("paid_at"), paymentTransactionId: text("payment_transaction_id"), createdByUserId: text("created_by_user_id").notNull(), origin: text("origin", { enum: ["web", "telegram", "system"] }).notNull().default("web"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("bills_series_due_unique").on(table.recurrenceSeriesId, table.dueDate), uniqueIndex("bills_payment_transaction_unique").on(table.paymentTransactionId), index("idx_bills_household_due_status").on(table.householdId, table.dueDate, table.status), index("idx_bills_household_subcategory_status").on(table.householdId, table.subcategoryId, table.status), index("idx_bills_recurrence_series").on(table.recurrenceSeriesId), check("bills_amount_check", sql`${table.amountCents} > 0`), check("bills_recurrence_check", sql`${table.recurrence} in ('none','monthly')`), check("bills_status_check", sql`${table.status} in ('pending','paid','cancelled')`), check("bills_origin_check", sql`${table.origin} in ('web','telegram','system')`), check("bills_recurrence_link_check", sql`(${table.recurrence} = 'none' and ${table.recurrenceSeriesId} is null and ${table.recurrenceEndDate} is null) or (${table.recurrence} = 'monthly' and ${table.recurrenceSeriesId} is not null)`), foreignKey({ columns: [table.householdId, table.categoryId], foreignColumns: [categories.householdId, categories.id], name: "bills_household_category_fk" }), foreignKey({ columns: [table.householdId, table.accountId], foreignColumns: [accounts.householdId, accounts.id], name: "bills_household_account_fk" }), foreignKey({ columns: [table.householdId, table.recurrenceSeriesId], foreignColumns: [recurringBillSeries.householdId, recurringBillSeries.id], name: "bills_household_series_fk" }), foreignKey({ columns: [table.householdId, table.paymentTransactionId], foreignColumns: [transactions.householdId, transactions.id], name: "bills_household_transaction_fk" }), foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "bills_household_creator_fk" })]);

export const notificationPreferences = sqliteTable("notification_preferences", {
  householdId: text("household_id").primaryKey().references(() => households.id, { onDelete: "cascade" }), enabled: integer("enabled", { mode: "boolean" }).notNull().default(true), offsetsJson: text("offsets_json").notNull().default("[7,3,1,0,-1]"), updatedAt: text("updated_at").notNull(),
}, (table) => [check("notification_preferences_enabled_check", sql`${table.enabled} in (0, 1)`)]);

export const notificationLog = sqliteTable("notification_log", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), eventKey: text("event_key").notNull(), channel: text("channel").notNull(), recipientKey: text("recipient_key").notNull(), sentAt: text("sent_at").notNull(),
}, (table) => [uniqueIndex("notification_log_idempotency_unique").on(table.householdId, table.entityType, table.entityId, table.eventKey, table.channel, table.recipientKey), index("idx_notification_log_household_sent").on(table.householdId, table.sentAt)]);

export const userNotificationPreferences = sqliteTable("user_notification_preferences", {
  householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  channel: text("channel", { enum: ["telegram", "push"] }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  billDueTomorrow: integer("bill_due_tomorrow", { mode: "boolean" }).notNull().default(true),
  billDueToday: integer("bill_due_today", { mode: "boolean" }).notNull().default(true),
  billOverdue: integer("bill_overdue", { mode: "boolean" }).notNull().default(true),
  upcomingDigest: integer("upcoming_digest", { mode: "boolean" }).notNull().default(false),
  preferredLocalTime: text("preferred_local_time").notNull().default("09:00"),
  timezone: text("timezone").notNull().default("America/Sao_Paulo"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.userId, table.channel] }),
  index("idx_user_notification_preferences_user").on(table.userId, table.householdId),
  index("idx_user_notification_preferences_enabled_channel").on(table.enabled, table.channel, table.householdId),
  check("user_notification_preferences_channel_check", sql`${table.channel} in ('telegram','push')`),
  check("user_notification_preferences_flags_check", sql`${table.enabled} in (0,1) and ${table.billDueTomorrow} in (0,1) and ${table.billDueToday} in (0,1) and ${table.billOverdue} in (0,1) and ${table.upcomingDigest} in (0,1)`),
  check("user_notification_preferences_time_check", sql`length(${table.preferredLocalTime}) = 5 and ${table.preferredLocalTime} glob '[0-2][0-9]:[0-5][0-9]' and substr(${table.preferredLocalTime},1,2) between '00' and '23'`),
  check("user_notification_preferences_timezone_check", sql`length(trim(${table.timezone})) between 1 and 100`),
  foreignKey({ columns: [table.householdId, table.userId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "user_notification_preferences_household_user_fk" }),
]);

export const notificationScheduleState = sqliteTable("notification_schedule_state", {
  householdId: text("household_id").notNull(),
  userId: text("user_id").notNull(),
  channel: text("channel", { enum: ["telegram", "push"] }).notNull(),
  preferredLocalTime: text("preferred_local_time").notNull(),
  timezone: text("timezone").notNull(),
  preferenceUpdatedAt: text("preference_updated_at").notNull(),
  nextRunAt: text("next_run_at"),
  scheduledLocalDate: text("scheduled_local_date"),
  leaseUntil: text("lease_until"),
  leaseToken: text("lease_token"),
  lastCompletedLocalDate: text("last_completed_local_date"),
  lastResult: text("last_result", { enum: ["completed", "missed"] }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.userId, table.channel] }),
  index("idx_notification_schedule_state_due").on(table.nextRunAt, table.leaseUntil).where(sql`${table.nextRunAt} is not null`),
  index("idx_notification_schedule_state_lease").on(table.leaseUntil, table.nextRunAt).where(sql`${table.leaseUntil} is not null`),
  check("notification_schedule_state_channel_check", sql`${table.channel} in ('telegram','push')`),
  check("notification_schedule_state_time_check", sql`length(${table.preferredLocalTime}) = 5 and ${table.preferredLocalTime} glob '[0-2][0-9]:[0-5][0-9]' and substr(${table.preferredLocalTime},1,2) between '00' and '23'`),
  check("notification_schedule_state_timezone_check", sql`length(trim(${table.timezone})) between 1 and 100`),
  check("notification_schedule_state_slot_check", sql`(${table.nextRunAt} is null and ${table.scheduledLocalDate} is null) or (${table.nextRunAt} is not null and ${table.scheduledLocalDate} is not null)`),
  check("notification_schedule_state_utc_check", sql`length(${table.preferenceUpdatedAt}) = 24 and substr(${table.preferenceUpdatedAt},11,1) = 'T' and substr(${table.preferenceUpdatedAt},24,1) = 'Z' and julianday(${table.preferenceUpdatedAt}) is not null and length(${table.createdAt}) = 24 and substr(${table.createdAt},11,1) = 'T' and substr(${table.createdAt},24,1) = 'Z' and julianday(${table.createdAt}) is not null and length(${table.updatedAt}) = 24 and substr(${table.updatedAt},11,1) = 'T' and substr(${table.updatedAt},24,1) = 'Z' and julianday(${table.updatedAt}) is not null and (${table.nextRunAt} is null or (length(${table.nextRunAt}) = 24 and substr(${table.nextRunAt},11,1) = 'T' and substr(${table.nextRunAt},24,1) = 'Z' and julianday(${table.nextRunAt}) is not null)) and (${table.leaseUntil} is null or (length(${table.leaseUntil}) = 24 and substr(${table.leaseUntil},11,1) = 'T' and substr(${table.leaseUntil},24,1) = 'Z' and julianday(${table.leaseUntil}) is not null))`),
  check("notification_schedule_state_lease_check", sql`(${table.leaseUntil} is null and ${table.leaseToken} is null) or (${table.leaseUntil} is not null and ${table.leaseToken} is not null and ${table.nextRunAt} is not null and length(trim(${table.leaseToken})) between 1 and 200)`),
  check("notification_schedule_state_result_check", sql`(${table.lastCompletedLocalDate} is null and ${table.lastResult} is null) or (${table.lastCompletedLocalDate} is not null and ${table.lastResult} in ('completed','missed'))`),
  foreignKey({ columns: [table.householdId, table.userId, table.channel], foreignColumns: [userNotificationPreferences.householdId, userNotificationPreferences.userId, userNotificationPreferences.channel], name: "notification_schedule_state_preference_fk" }).onDelete("cascade"),
]);

export const notificationTransportState = sqliteTable("notification_transport_state", {
  channel: text("channel", { enum: ["telegram", "push"] }).primaryKey(),
  pausedUntil: text("paused_until"),
  leaseUntil: text("lease_until"),
  leaseToken: text("lease_token"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("notification_transport_state_channel_check", sql`${table.channel} in ('telegram','push')`),
  check("notification_transport_state_utc_check", sql`(${table.pausedUntil} is null or (length(${table.pausedUntil}) = 24 and substr(${table.pausedUntil},11,1) = 'T' and substr(${table.pausedUntil},24,1) = 'Z' and julianday(${table.pausedUntil}) is not null)) and (${table.leaseUntil} is null or (length(${table.leaseUntil}) = 24 and substr(${table.leaseUntil},11,1) = 'T' and substr(${table.leaseUntil},24,1) = 'Z' and julianday(${table.leaseUntil}) is not null)) and length(${table.createdAt}) = 24 and substr(${table.createdAt},11,1) = 'T' and substr(${table.createdAt},24,1) = 'Z' and julianday(${table.createdAt}) is not null and length(${table.updatedAt}) = 24 and substr(${table.updatedAt},11,1) = 'T' and substr(${table.updatedAt},24,1) = 'Z' and julianday(${table.updatedAt}) is not null`),
  check("notification_transport_state_lease_check", sql`(${table.leaseUntil} is null and ${table.leaseToken} is null) or (${table.leaseUntil} is not null and ${table.leaseToken} is not null and length(trim(${table.leaseToken})) between 1 and 200)`),
]);

export const notificationOutbox = sqliteTable("notification_outbox", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  recipientUserId: text("recipient_user_id").notNull(),
  channel: text("channel", { enum: ["telegram", "push"] }).notNull(),
  entityType: text("entity_type", { enum: ["bill", "household"] }).notNull(),
  entityId: text("entity_id").notNull(),
  eventType: text("event_type", { enum: ["bill_due_tomorrow", "bill_due_today", "bill_overdue", "upcoming_digest"] }).notNull(),
  referenceDate: text("reference_date").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status", { enum: ["pending", "processing", "sent", "failed", "uncertain", "cancelled"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: text("next_attempt_at"),
  leaseUntil: text("lease_until"),
  providerMessageId: text("provider_message_id"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  sentAt: text("sent_at"),
}, (table) => [
  uniqueIndex("notification_outbox_dedupe_key_unique").on(table.dedupeKey),
  uniqueIndex("notification_outbox_logical_event_unique").on(table.householdId, table.recipientUserId, table.channel, table.entityType, table.entityId, table.eventType, table.referenceDate),
  index("idx_notification_outbox_dispatch").on(table.status, table.nextAttemptAt, table.leaseUntil),
  index("idx_notification_outbox_household_recipient").on(table.householdId, table.recipientUserId, table.createdAt),
  index("idx_notification_outbox_entity").on(table.householdId, table.entityType, table.entityId),
  check("notification_outbox_channel_check", sql`${table.channel} in ('telegram','push')`),
  check("notification_outbox_entity_check", sql`(${table.eventType} in ('bill_due_tomorrow','bill_due_today','bill_overdue') and ${table.entityType} = 'bill') or (${table.eventType} = 'upcoming_digest' and ${table.entityType} = 'household')`),
  check("notification_outbox_event_check", sql`${table.eventType} in ('bill_due_tomorrow','bill_due_today','bill_overdue','upcoming_digest')`),
  check("notification_outbox_status_check", sql`${table.status} in ('pending','processing','sent','failed','uncertain','cancelled')`),
  check("notification_outbox_attempts_check", sql`typeof(${table.attempts}) = 'integer' and ${table.attempts} between 0 and 1000`),
  check("notification_outbox_error_check", sql`${table.lastError} is null or length(${table.lastError}) <= 1000`),
  foreignKey({ columns: [table.householdId, table.recipientUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "notification_outbox_household_recipient_fk" }),
  foreignKey({ columns: [table.householdId, table.recipientUserId, table.channel], foreignColumns: [userNotificationPreferences.householdId, userNotificationPreferences.userId, userNotificationPreferences.channel], name: "notification_outbox_preference_fk" }),
]);

export const telegramLinks = sqliteTable("telegram_links", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), userId: text("user_id").notNull(), telegramUserId: text("telegram_user_id").notNull(), chatId: text("chat_id").notNull(), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), linkedAt: text("linked_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("telegram_links_user_unique").on(table.telegramUserId), index("idx_telegram_links_household_active").on(table.householdId, table.isActive), check("telegram_links_active_check", sql`${table.isActive} in (0, 1)`), foreignKey({ columns: [table.householdId, table.userId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "telegram_links_household_user_fk" })]);

export const telegramLinkCodes = sqliteTable("telegram_link_codes", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), userId: text("user_id").notNull(), codeHash: text("code_hash").notNull(), expiresAt: text("expires_at").notNull(), usedAt: text("used_at"), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("telegram_link_codes_hash_unique").on(table.codeHash), index("idx_telegram_link_codes_expiry").on(table.expiresAt), foreignKey({ columns: [table.householdId, table.userId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "telegram_link_codes_household_user_fk" })]);

export const telegramConversationStates = sqliteTable("telegram_conversation_states", {
  telegramUserId: text("telegram_user_id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), payloadJson: text("payload_json").notNull(), expiresAt: text("expires_at").notNull(), updatedAt: text("updated_at").notNull(),
});

export const telegramProcessedUpdates = sqliteTable("telegram_processed_updates", {
  updateId: text("update_id").primaryKey(), receivedAt: text("received_at").notNull(),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), userId: text("user_id").notNull().references(() => users.id), action: text("action").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), oldData: text("old_data"), newData: text("new_data"), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_audit_logs_household_created").on(table.householdId, table.createdAt)]);

import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

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
}, (table) => [index("idx_subcategories_category").on(table.categoryId)]);

export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), type: text("type", { enum: ["income", "expense"] }).notNull(), amountCents: integer("amount_cents").notNull(), description: text("description").notNull(), categoryId: text("category_id").references(() => categories.id), subcategoryId: text("subcategory_id").references(() => subcategories.id), transactionDate: text("transaction_date").notNull(), transactionTime: text("transaction_time"), responsibleUserId: text("responsible_user_id").notNull().references(() => users.id), accountId: text("account_id").notNull().references(() => accounts.id), paymentMethod: text("payment_method"), status: text("status", { enum: ["confirmed", "pending", "cancelled"] }).notNull().default("confirmed"), origin: text("origin", { enum: ["dashboard", "telegram"] }).notNull().default("dashboard"), notes: text("notes"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_transactions_household_date").on(table.householdId, table.transactionDate), index("idx_transactions_household_status").on(table.householdId, table.status), index("idx_transactions_account").on(table.accountId), index("idx_transactions_category").on(table.categoryId), index("idx_transactions_responsible").on(table.responsibleUserId), uniqueIndex("transactions_household_id_unique").on(table.householdId, table.id)]);

export const creditCards = sqliteTable("credit_cards", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), name: text("name").notNull(), institution: text("institution").notNull(), holder: text("holder").notNull(), limitCents: integer("limit_cents").notNull(), closingDay: integer("closing_day").notNull(), dueDay: integer("due_day").notNull(), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), notes: text("notes"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_credit_cards_household_active").on(table.householdId, table.isActive), uniqueIndex("credit_cards_household_name_unique").on(table.householdId, table.name), unique("credit_cards_household_id_unique").on(table.householdId, table.id), check("credit_cards_limit_check", sql`${table.limitCents} >= 0`), check("credit_cards_closing_day_check", sql`${table.closingDay} between 1 and 31`), check("credit_cards_due_day_check", sql`${table.dueDay} between 1 and 31`), check("credit_cards_active_check", sql`${table.isActive} in (0,1)`)]);

export const cardPurchases = sqliteTable("card_purchases", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), cardId: text("card_id").notNull(), description: text("description").notNull(), totalCents: integer("total_cents").notNull(), purchaseDate: text("purchase_date").notNull(), installmentCount: integer("installment_count").notNull().default(1), categoryId: text("category_id"), notes: text("notes"), status: text("status", { enum: ["active", "cancelled"] }).notNull().default("active"), createdByUserId: text("created_by_user_id").notNull(), origin: text("origin", { enum: ["web", "telegram", "system"] }).notNull().default("web"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_card_purchases_household_date").on(table.householdId, table.purchaseDate), index("idx_card_purchases_card").on(table.cardId), unique("card_purchases_household_id_unique").on(table.householdId, table.id), check("card_purchases_total_check", sql`${table.totalCents} > 0`), check("card_purchases_count_check", sql`${table.installmentCount} between 1 and 120`), check("card_purchases_status_check", sql`${table.status} in ('active','cancelled')`), check("card_purchases_origin_check", sql`${table.origin} in ('web','telegram','system')`), foreignKey({ columns: [table.householdId, table.cardId], foreignColumns: [creditCards.householdId, creditCards.id], name: "card_purchases_household_card_fk" }), foreignKey({ columns: [table.householdId, table.categoryId], foreignColumns: [categories.householdId, categories.id], name: "card_purchases_household_category_fk" }), foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "card_purchases_household_creator_fk" })]);

export const cardInvoices = sqliteTable("card_invoices", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), cardId: text("card_id").notNull(), referenceMonth: text("reference_month").notNull(), dueDate: text("due_date").notNull(), status: text("status", { enum: ["open", "closed", "paid"] }).notNull().default("open"), paidAt: text("paid_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("card_invoices_card_month_unique").on(table.householdId, table.cardId, table.referenceMonth), index("idx_card_invoices_household_due").on(table.householdId, table.dueDate), unique("card_invoices_household_id_unique").on(table.householdId, table.id), check("card_invoices_status_check", sql`${table.status} in ('open','closed','paid')`), foreignKey({ columns: [table.householdId, table.cardId], foreignColumns: [creditCards.householdId, creditCards.id], name: "card_invoices_household_card_fk" })]);

export const cardInstallments = sqliteTable("card_installments", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), purchaseId: text("purchase_id").notNull(), invoiceId: text("invoice_id").notNull(), installmentNumber: integer("installment_number").notNull(), installmentCount: integer("installment_count").notNull(), amountCents: integer("amount_cents").notNull(), status: text("status", { enum: ["pending", "paid", "cancelled"] }).notNull().default("pending"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("card_installments_purchase_number_unique").on(table.purchaseId, table.installmentNumber), index("idx_card_installments_household_invoice").on(table.householdId, table.invoiceId), check("card_installments_count_check", sql`${table.installmentCount} between 1 and 120`), check("card_installments_number_check", sql`${table.installmentNumber} between 1 and ${table.installmentCount}`), check("card_installments_amount_check", sql`${table.amountCents} > 0`), check("card_installments_status_check", sql`${table.status} in ('pending','paid','cancelled')`), foreignKey({ columns: [table.householdId, table.purchaseId], foreignColumns: [cardPurchases.householdId, cardPurchases.id], name: "card_installments_household_purchase_fk" }).onDelete("cascade"), foreignKey({ columns: [table.householdId, table.invoiceId], foreignColumns: [cardInvoices.householdId, cardInvoices.id], name: "card_installments_household_invoice_fk" })]);

export const invoicePayments = sqliteTable("invoice_payments", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), invoiceId: text("invoice_id").notNull(), accountId: text("account_id").notNull(), amountCents: integer("amount_cents").notNull(), paidAt: text("paid_at").notNull(), createdByUserId: text("created_by_user_id").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("invoice_payments_invoice_unique").on(table.invoiceId), index("idx_invoice_payments_household_account").on(table.householdId, table.accountId), check("invoice_payments_amount_check", sql`${table.amountCents} > 0`), foreignKey({ columns: [table.householdId, table.invoiceId], foreignColumns: [cardInvoices.householdId, cardInvoices.id], name: "invoice_payments_household_invoice_fk" }), foreignKey({ columns: [table.householdId, table.accountId], foreignColumns: [accounts.householdId, accounts.id], name: "invoice_payments_household_account_fk" }), foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "invoice_payments_household_creator_fk" })]);

export const recurringBillSeries = sqliteTable("recurring_bill_series", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), description: text("description").notNull(), amountCents: integer("amount_cents").notNull(), categoryId: text("category_id"), accountId: text("account_id"), dayOfMonth: integer("day_of_month").notNull(), startsOn: text("starts_on").notNull(), endsOn: text("ends_on"), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), notes: text("notes"), createdByUserId: text("created_by_user_id").notNull(), origin: text("origin", { enum: ["web", "telegram", "system"] }).notNull().default("web"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_recurring_bill_series_household_active").on(table.householdId, table.isActive), unique("recurring_bill_series_household_id_unique").on(table.householdId, table.id), check("recurring_bill_series_amount_check", sql`${table.amountCents} > 0`), check("recurring_bill_series_day_check", sql`${table.dayOfMonth} between 1 and 31`), check("recurring_bill_series_dates_check", sql`${table.endsOn} is null or ${table.endsOn} >= ${table.startsOn}`), check("recurring_bill_series_active_check", sql`${table.isActive} in (0, 1)`), check("recurring_bill_series_origin_check", sql`${table.origin} in ('web','telegram','system')`), foreignKey({ columns: [table.householdId, table.categoryId], foreignColumns: [categories.householdId, categories.id], name: "recurring_bill_series_household_category_fk" }), foreignKey({ columns: [table.householdId, table.accountId], foreignColumns: [accounts.householdId, accounts.id], name: "recurring_bill_series_household_account_fk" }), foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "recurring_bill_series_household_creator_fk" })]);

export const bills = sqliteTable("bills", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), description: text("description").notNull(), amountCents: integer("amount_cents").notNull(), categoryId: text("category_id"), dueDate: text("due_date").notNull(), accountId: text("account_id"), recurrence: text("recurrence", { enum: ["none", "monthly"] }).notNull().default("none"), recurrenceSeriesId: text("recurrence_series_id"), recurrenceEndDate: text("recurrence_end_date"), notes: text("notes"), status: text("status", { enum: ["pending", "paid", "cancelled"] }).notNull().default("pending"), paidAt: text("paid_at"), paymentTransactionId: text("payment_transaction_id"), createdByUserId: text("created_by_user_id").notNull(), origin: text("origin", { enum: ["web", "telegram", "system"] }).notNull().default("web"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("bills_series_due_unique").on(table.recurrenceSeriesId, table.dueDate), index("idx_bills_household_due_status").on(table.householdId, table.dueDate, table.status), index("idx_bills_recurrence_series").on(table.recurrenceSeriesId), check("bills_amount_check", sql`${table.amountCents} > 0`), check("bills_recurrence_check", sql`${table.recurrence} in ('none','monthly')`), check("bills_status_check", sql`${table.status} in ('pending','paid','cancelled')`), check("bills_origin_check", sql`${table.origin} in ('web','telegram','system')`), check("bills_recurrence_link_check", sql`(${table.recurrence} = 'none' and ${table.recurrenceSeriesId} is null and ${table.recurrenceEndDate} is null) or (${table.recurrence} = 'monthly' and ${table.recurrenceSeriesId} is not null)`), foreignKey({ columns: [table.householdId, table.categoryId], foreignColumns: [categories.householdId, categories.id], name: "bills_household_category_fk" }), foreignKey({ columns: [table.householdId, table.accountId], foreignColumns: [accounts.householdId, accounts.id], name: "bills_household_account_fk" }), foreignKey({ columns: [table.householdId, table.recurrenceSeriesId], foreignColumns: [recurringBillSeries.householdId, recurringBillSeries.id], name: "bills_household_series_fk" }), foreignKey({ columns: [table.householdId, table.paymentTransactionId], foreignColumns: [transactions.householdId, transactions.id], name: "bills_household_transaction_fk" }), foreignKey({ columns: [table.householdId, table.createdByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId], name: "bills_household_creator_fk" })]);

export const notificationPreferences = sqliteTable("notification_preferences", {
  householdId: text("household_id").primaryKey().references(() => households.id, { onDelete: "cascade" }), enabled: integer("enabled", { mode: "boolean" }).notNull().default(true), offsetsJson: text("offsets_json").notNull().default("[7,3,1,0,-1]"), updatedAt: text("updated_at").notNull(),
}, (table) => [check("notification_preferences_enabled_check", sql`${table.enabled} in (0, 1)`)]);

export const notificationLog = sqliteTable("notification_log", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), eventKey: text("event_key").notNull(), channel: text("channel").notNull(), recipientKey: text("recipient_key").notNull(), sentAt: text("sent_at").notNull(),
}, (table) => [uniqueIndex("notification_log_idempotency_unique").on(table.householdId, table.entityType, table.entityId, table.eventKey, table.channel, table.recipientKey), index("idx_notification_log_household_sent").on(table.householdId, table.sentAt)]);

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

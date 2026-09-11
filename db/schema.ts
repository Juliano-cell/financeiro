import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
}, (table) => [index("idx_household_members_household").on(table.householdId), index("idx_household_members_user").on(table.userId), index("idx_household_members_invited_email").on(table.invitedEmail)]);

export const householdInviteTokens = sqliteTable("household_invite_tokens", {
  memberId: text("member_id").primaryKey().references(() => householdMembers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("household_invite_tokens_hash_unique").on(table.tokenHash), index("idx_household_invite_tokens_expires").on(table.expiresAt)]);

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), name: text("name").notNull(),
  type: text("type", { enum: ["bank", "cash", "savings", "wallet", "other"] }).notNull(), initialBalanceCents: integer("initial_balance_cents").notNull().default(0), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_accounts_household_active").on(table.householdId, table.isActive), uniqueIndex("accounts_household_name_unique").on(table.householdId, table.name)]);

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), name: text("name").notNull(),
  type: text("type", { enum: ["income", "expense", "both"] }).notNull().default("expense"), color: text("color").notNull().default("#397f72"), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_categories_household_active").on(table.householdId, table.isActive), uniqueIndex("categories_household_name_unique").on(table.householdId, table.name)]);

export const subcategories = sqliteTable("subcategories", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), categoryId: text("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }), name: text("name").notNull(), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_subcategories_category").on(table.categoryId)]);

export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), type: text("type", { enum: ["income", "expense"] }).notNull(), amountCents: integer("amount_cents").notNull(), description: text("description").notNull(), categoryId: text("category_id").references(() => categories.id), subcategoryId: text("subcategory_id").references(() => subcategories.id), transactionDate: text("transaction_date").notNull(), transactionTime: text("transaction_time"), responsibleUserId: text("responsible_user_id").notNull().references(() => users.id), accountId: text("account_id").notNull().references(() => accounts.id), paymentMethod: text("payment_method"), status: text("status", { enum: ["confirmed", "pending", "cancelled"] }).notNull().default("confirmed"), origin: text("origin", { enum: ["dashboard", "telegram"] }).notNull().default("dashboard"), notes: text("notes"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_transactions_household_date").on(table.householdId, table.transactionDate), index("idx_transactions_household_status").on(table.householdId, table.status), index("idx_transactions_account").on(table.accountId), index("idx_transactions_category").on(table.categoryId), index("idx_transactions_responsible").on(table.responsibleUserId)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), userId: text("user_id").notNull().references(() => users.id), action: text("action").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), oldData: text("old_data"), newData: text("new_data"), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_audit_logs_household_created").on(table.householdId, table.createdAt)]);

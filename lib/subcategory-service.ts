export class SubcategoryServiceError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "SubcategoryServiceError";
    this.status = status;
    this.code = code;
  }
}

type SubcategoryContext = {
  d1: D1Database;
  householdId: string;
  userId: string;
  timestamp?: string;
};

type SubcategoryRow = {
  id: string;
  household_id: string;
  category_id: string;
  name: string;
  is_active: number;
};

const duplicateMessage = "Já existe uma subcategoria com esse nome nesta categoria.";
const timestamp = (context: SubcategoryContext) => context.timestamp ?? new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

function normalizeName(value: string) {
  const name = value.trim();
  if (!name) throw new SubcategoryServiceError("Informe o nome da subcategoria.");
  if (name.length > 120) throw new SubcategoryServiceError("O nome da subcategoria deve ter no máximo 120 caracteres.");
  return name;
}

function isDuplicateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("subcategories_household_category_name_unique") || message.includes("UNIQUE constraint failed: subcategories.household_id, subcategories.category_id, subcategories.name");
}

async function assertActiveMembership(context: SubcategoryContext) {
  const member = await context.d1.prepare("SELECT id FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'active' LIMIT 1").bind(context.householdId, context.userId).first<{ id: string }>();
  if (!member) throw new SubcategoryServiceError("Usuário não pertence mais a esta família.", 403);
}

async function getCategory(context: SubcategoryContext, categoryId: string, requireActive: boolean) {
  const category = await context.d1.prepare(`SELECT id, is_active FROM categories WHERE id = ? AND household_id = ?${requireActive ? " AND is_active = 1" : ""} LIMIT 1`).bind(categoryId, context.householdId).first<{ id: string; is_active: number }>();
  if (!category) throw new SubcategoryServiceError(requireActive ? "Selecione uma categoria ativa desta família." : "Categoria não encontrada.", 400, "SUBCATEGORY_CATEGORY_INVALID");
  return category;
}

async function getSubcategory(context: SubcategoryContext, subcategoryId: string) {
  const subcategory = await context.d1.prepare("SELECT id, household_id, category_id, name, is_active FROM subcategories WHERE id = ? AND household_id = ? LIMIT 1").bind(subcategoryId, context.householdId).first<SubcategoryRow>();
  if (!subcategory) throw new SubcategoryServiceError("Subcategoria não encontrada.", 404);
  return subcategory;
}

async function assertNoDuplicate(context: SubcategoryContext, categoryId: string, name: string, excludedId?: string) {
  const duplicate = await context.d1.prepare("SELECT id FROM subcategories WHERE household_id = ? AND category_id = ? AND name = ? COLLATE NOCASE AND (? IS NULL OR id <> ?) LIMIT 1").bind(context.householdId, categoryId, name, excludedId ?? null, excludedId ?? null).first<{ id: string }>();
  if (duplicate) throw new SubcategoryServiceError(duplicateMessage, 409, "SUBCATEGORY_DUPLICATE");
}

export async function subcategoryIsInUse(context: SubcategoryContext, subcategoryId: string) {
  const usage = await context.d1.prepare(`SELECT CASE WHEN
    EXISTS (SELECT 1 FROM transactions WHERE household_id = ? AND subcategory_id = ?)
    OR EXISTS (SELECT 1 FROM bills WHERE household_id = ? AND subcategory_id = ?)
    OR EXISTS (SELECT 1 FROM recurring_bill_series WHERE household_id = ? AND subcategory_id = ?)
    OR EXISTS (SELECT 1 FROM card_purchases WHERE household_id = ? AND subcategory_id = ?)
    THEN 1 ELSE 0 END AS is_in_use`).bind(context.householdId, subcategoryId, context.householdId, subcategoryId, context.householdId, subcategoryId, context.householdId, subcategoryId).first<{ is_in_use: number }>();
  return Boolean(usage?.is_in_use);
}

async function writeAudit(context: SubcategoryContext, action: string, entityId: string, oldData: unknown, newData: unknown) {
  await context.d1.prepare("INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at) VALUES (?, ?, ?, ?, 'subcategory', ?, ?, ?, ?)").bind(uid("audit"), context.householdId, context.userId, action, entityId, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null, timestamp(context)).run();
}

export async function createSubcategory(input: { name: string; categoryId: string }, context: SubcategoryContext) {
  await assertActiveMembership(context);
  const name = normalizeName(input.name);
  await getCategory(context, input.categoryId, true);
  await assertNoDuplicate(context, input.categoryId, name);
  const id = uid("subcategory");
  const createdAt = timestamp(context);
  try {
    await context.d1.batch([
      context.d1.prepare("INSERT INTO subcategories (id, household_id, category_id, name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)").bind(id, context.householdId, input.categoryId, name, createdAt, createdAt),
      context.d1.prepare("INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at) VALUES (?, ?, ?, 'create', 'subcategory', ?, NULL, ?, ?)").bind(uid("audit"), context.householdId, context.userId, id, JSON.stringify({ name, categoryId: input.categoryId, isActive: true }), createdAt),
    ]);
  } catch (error) {
    if (isDuplicateError(error)) throw new SubcategoryServiceError(duplicateMessage, 409, "SUBCATEGORY_DUPLICATE");
    throw error;
  }
  return { id, name, categoryId: input.categoryId, isActive: true, isInUse: false };
}

export async function updateSubcategory(input: { id: string; name: string; categoryId: string }, context: SubcategoryContext) {
  await assertActiveMembership(context);
  const name = normalizeName(input.name);
  const before = await getSubcategory(context, input.id);
  const moving = before.category_id !== input.categoryId;
  await getCategory(context, input.categoryId, moving);
  if (moving && await subcategoryIsInUse(context, input.id)) throw new SubcategoryServiceError("Esta subcategoria já possui lançamentos e não pode ser movida para outra categoria. Você pode renomeá-la ou criar uma nova subcategoria.", 409, "SUBCATEGORY_IN_USE");
  await assertNoDuplicate(context, input.categoryId, name, input.id);
  try {
    const result = await context.d1.prepare(`UPDATE subcategories SET name = ?, category_id = ?, updated_at = ?
      WHERE id = ? AND household_id = ?
        AND EXISTS (SELECT 1 FROM categories c WHERE c.id = ? AND c.household_id = ? AND (? = category_id OR c.is_active = 1))
        AND (? = category_id OR (
          NOT EXISTS (SELECT 1 FROM transactions WHERE household_id = ? AND subcategory_id = ?)
          AND NOT EXISTS (SELECT 1 FROM bills WHERE household_id = ? AND subcategory_id = ?)
          AND NOT EXISTS (SELECT 1 FROM recurring_bill_series WHERE household_id = ? AND subcategory_id = ?)
          AND NOT EXISTS (SELECT 1 FROM card_purchases WHERE household_id = ? AND subcategory_id = ?)
        ))`).bind(name, input.categoryId, timestamp(context), input.id, context.householdId, input.categoryId, context.householdId, input.categoryId, input.categoryId, context.householdId, input.id, context.householdId, input.id, context.householdId, input.id, context.householdId, input.id).run();
    if ((result.meta.changes ?? 0) !== 1) throw new SubcategoryServiceError("A subcategoria passou a ter histórico ou a categoria deixou de estar disponível. Atualize a tela e tente novamente.", 409, "SUBCATEGORY_CHANGED");
  } catch (error) {
    if (isDuplicateError(error)) throw new SubcategoryServiceError(duplicateMessage, 409, "SUBCATEGORY_DUPLICATE");
    throw error;
  }
  const after = { id: input.id, name, categoryId: input.categoryId, isActive: Boolean(before.is_active) };
  await writeAudit(context, "update", input.id, { name: before.name, categoryId: before.category_id, isActive: Boolean(before.is_active) }, after);
  return { ...after, isInUse: await subcategoryIsInUse(context, input.id) };
}

export async function setSubcategoryActive(input: { id: string; isActive: boolean }, context: SubcategoryContext) {
  await assertActiveMembership(context);
  const before = await getSubcategory(context, input.id);
  if (input.isActive) await getCategory(context, before.category_id, true);
  if (Boolean(before.is_active) === input.isActive) return { id: before.id, isActive: input.isActive };
  const result = await context.d1.prepare("UPDATE subcategories SET is_active = ?, updated_at = ? WHERE id = ? AND household_id = ?").bind(input.isActive ? 1 : 0, timestamp(context), before.id, context.householdId).run();
  if ((result.meta.changes ?? 0) !== 1) throw new SubcategoryServiceError("A subcategoria foi alterada por outra operação.", 409, "SUBCATEGORY_CHANGED");
  await writeAudit(context, input.isActive ? "reactivate" : "deactivate", before.id, { isActive: Boolean(before.is_active) }, { isActive: input.isActive });
  return { id: before.id, isActive: input.isActive };
}

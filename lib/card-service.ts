import type { InvoiceContext } from "./invoice-service";

export class CardServiceError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "CARD_INVALID") {
    super(message);
    this.name = "CardServiceError";
    this.status = status;
    this.code = code;
  }
}

function assertIdentifier(value: string) {
  if (typeof value !== "string" || value.length > 100 || !value.replace(/[\p{White_Space}\p{Cc}\p{Cf}]/gu, "")) {
    throw new CardServiceError("Identificador inválido.");
  }
}

async function hasActiveMembership(context: InvoiceContext) {
  return Boolean(await context.d1.prepare(
    "SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
  ).bind(context.householdId, context.userId).first());
}

export async function reactivateCard(cardId: string, context: InvoiceContext) {
  assertIdentifier(cardId);
  if (!await hasActiveMembership(context)) {
    throw new CardServiceError("Usuário não pertence mais a esta família.", 403, "CARD_MEMBERSHIP");
  }
  const card = await context.d1.prepare(
    "SELECT id, is_active FROM credit_cards WHERE id = ? AND household_id = ? LIMIT 1",
  ).bind(cardId, context.householdId).first<{ id: string; is_active: number }>();
  if (!card) throw new CardServiceError("Cartão não encontrado.", 404, "CARD_NOT_FOUND");
  if (card.is_active) return { cardId, reactivated: false, replayed: true };

  const timestamp = context.timestamp ?? new Date().toISOString();
  const auditId = `card_reactivation_audit_${crypto.randomUUID()}`;
  const results = await context.d1.batch([
    context.d1.prepare(`UPDATE credit_cards
      SET is_active = 1, updated_at = ?
      WHERE id = ? AND household_id = ? AND is_active = 0
        AND EXISTS (SELECT 1 FROM household_members m
          WHERE m.household_id = credit_cards.household_id AND m.user_id = ? AND m.status = 'active')`)
      .bind(timestamp, cardId, context.householdId, context.userId),
    context.d1.prepare(`INSERT INTO audit_logs
        (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at)
      SELECT ?, ?, ?, 'reactivate', 'credit_card', ?, json_object('isActive', 0), json_object('isActive', 1), ?
      WHERE changes() = 1`)
      .bind(auditId, context.householdId, context.userId, cardId, timestamp),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 1) return { cardId, reactivated: true, replayed: false };

  if (!await hasActiveMembership(context)) {
    throw new CardServiceError("Usuário não pertence mais a esta família.", 403, "CARD_MEMBERSHIP");
  }
  const current = await context.d1.prepare(
    "SELECT is_active FROM credit_cards WHERE id = ? AND household_id = ? LIMIT 1",
  ).bind(cardId, context.householdId).first<{ is_active: number }>();
  if (!current) throw new CardServiceError("Cartão não encontrado.", 404, "CARD_NOT_FOUND");
  if (current.is_active) return { cardId, reactivated: false, replayed: true };
  throw new CardServiceError("O cartão mudou durante a reativação. Atualize e tente novamente.", 409, "CARD_CONFLICT");
}

export async function deactivateCard(cardId: string, context: InvoiceContext) {
  assertIdentifier(cardId);
  if (!await hasActiveMembership(context)) throw new CardServiceError("Usuário não pertence mais a esta família.", 403, "CARD_MEMBERSHIP");
  const card = await context.d1.prepare("SELECT id, is_active FROM credit_cards WHERE id = ? AND household_id = ? LIMIT 1")
    .bind(cardId, context.householdId).first<{ id: string; is_active: number }>();
  if (!card) throw new CardServiceError("Cartão não encontrado.", 404, "CARD_NOT_FOUND");
  if (!card.is_active) return { cardId, inactivated: false, replayed: true };
  const timestamp = context.timestamp ?? new Date().toISOString();
  const results = await context.d1.batch([
    context.d1.prepare(`UPDATE credit_cards SET is_active = 0, updated_at = ?
      WHERE id = ? AND household_id = ? AND is_active = 1
        AND EXISTS (SELECT 1 FROM household_members m
          WHERE m.household_id = credit_cards.household_id AND m.user_id = ? AND m.status = 'active')`)
      .bind(timestamp, cardId, context.householdId, context.userId),
    context.d1.prepare(`INSERT INTO audit_logs
        (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at)
      SELECT ?, ?, ?, 'deactivate', 'credit_card', ?, json_object('isActive', 1), json_object('isActive', 0), ?
      WHERE changes() = 1`)
      .bind(`card_deactivation_audit_${crypto.randomUUID()}`, context.householdId, context.userId, cardId, timestamp),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 1) return { cardId, inactivated: true, replayed: false };
  throw new CardServiceError("O cartão mudou durante a inativação. Atualize e tente novamente.", 409, "CARD_CONFLICT");
}

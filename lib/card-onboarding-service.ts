import { addMonths, daysInMonth } from "./finance-rules.mjs";
import { invoiceCivilDate, invoiceClosesOn, type InvoiceContext } from "./invoice-service";

export type ImportedCardCommitmentInput = {
  description: string;
  installmentAmountCents: number;
  firstOriginalInstallmentNumber: number;
  originalInstallmentCount: number;
  firstReferenceMonth?: string;
  originalTotalCents?: number | null;
  originalPurchaseDate?: string | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
  notes?: string | null;
};

export type ConfigureCardCurrentStateInput = {
  cardId: string;
  initialReferenceMonth: string;
  declaredCurrentInvoiceTotalCents: number;
  idempotencyKey: string;
  operationId?: string;
  commitments?: ImportedCardCommitmentInput[];
};

type CardSnapshot = {
  id: string;
  closing_day: number;
  due_day: number;
  updated_at: string;
  is_active: number;
  has_activity: number;
};

type BatchReceipt = {
  id: string;
  card_id: string;
  request_fingerprint: string;
  initial_reference_month: string;
  declared_invoice_total_cents: number;
  opening_balance_cents: number;
  imported_purchase_count: number;
  imported_installment_count: number;
  status: "pending" | "completed" | "voided";
};

type NormalizedCommitment = ImportedCardCommitmentInput & {
  description: string;
  firstReferenceMonth: string;
  originalTotalCents: number | null;
  originalPurchaseDate: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  notes: string | null;
  remainingInstallmentCount: number;
  remainingTotalCents: number;
};

export class CardOnboardingError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "CARD_ONBOARDING_INVALID") {
    super(message);
    this.name = "CardOnboardingError";
    this.status = status;
    this.code = code;
  }
}

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const at = (context: InvoiceContext) => context.timestamp ?? new Date().toISOString();
const MAX_MONEY_CENTS = 100_000_000_000;

function assertIdentifier(value: string) {
  if (typeof value !== "string" || value.length > 200 || !value.replace(/[\p{White_Space}\p{Cc}\p{Cf}]/gu, "")) {
    throw new CardOnboardingError("Identificador inválido.");
  }
}

function assertText(value: string, label: string, maximum = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new CardOnboardingError(`${label} inválida.`);
}

function isCivilDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value < "0001-01-01") return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= lengths[month - 1];
}

function assertReferenceMonth(value: string) {
  if (!/^\d{4}-\d{2}$/u.test(value) || !isCivilDate(`${value}-01`)) throw new CardOnboardingError("Competência inválida.");
}

function assertMoney(value: number, { zero = false }: { zero?: boolean } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > MAX_MONEY_CENTS) throw new CardOnboardingError("Valor inválido.");
}

function dueDate(referenceMonth: string, dueDay: number) {
  return `${referenceMonth}-${String(Math.min(dueDay, daysInMonth(referenceMonth))).padStart(2, "0")}`;
}

async function sha256(value: unknown) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorize(context: InvoiceContext) {
  const membership = await context.d1.prepare("SELECT id FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'active' LIMIT 1")
    .bind(context.householdId, context.userId).first();
  if (!membership) throw new CardOnboardingError("Usuário não pertence mais a esta família.", 403, "CARD_ONBOARDING_MEMBERSHIP");
}

async function findReceipt(idempotencyKey: string, context: InvoiceContext) {
  return context.d1.prepare(`SELECT id, card_id, request_fingerprint, initial_reference_month,
      declared_invoice_total_cents, opening_balance_cents, imported_purchase_count,
      imported_installment_count, status
    FROM card_import_batches
    WHERE household_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(context.householdId, idempotencyKey).first<BatchReceipt>();
}

function assertReceipt(receipt: BatchReceipt, fingerprint: string) {
  if (receipt.request_fingerprint !== fingerprint) {
    throw new CardOnboardingError("Esta chave de operação já foi usada com outros dados.", 409, "CARD_ONBOARDING_IDEMPOTENCY_CONFLICT");
  }
  if (receipt.status !== "completed") {
    throw new CardOnboardingError("A configuração inicial do cartão ainda não foi concluída.", 409, "CARD_ONBOARDING_INCOMPLETE");
  }
}

async function resultFromReceipt(receipt: BatchReceipt, context: InvoiceContext, replayed: boolean) {
  const invoice = await context.d1.prepare(`SELECT id FROM card_invoices
    WHERE household_id = ? AND card_id = ? AND reference_month = ? LIMIT 1`)
    .bind(context.householdId, receipt.card_id, receipt.initial_reference_month).first<{ id: string }>();
  if (!invoice) throw new CardOnboardingError("A configuração inicial está inconsistente.", 409, "CARD_ONBOARDING_INCONSISTENT");
  return {
    batchId: receipt.id,
    cardId: receipt.card_id,
    invoiceId: invoice.id,
    initialReferenceMonth: receipt.initial_reference_month,
    declaredCurrentInvoiceTotalCents: receipt.declared_invoice_total_cents,
    openingBalanceCents: receipt.opening_balance_cents,
    importedPurchaseCount: receipt.imported_purchase_count,
    importedInstallmentCount: receipt.imported_installment_count,
    replayed,
  };
}

function normalizeCommitments(input: ConfigureCardCurrentStateInput, today: string) {
  const commitments = input.commitments ?? [];
  if (commitments.length > 50) throw new CardOnboardingError("A importação aceita no máximo 50 parcelamentos.");
  let installmentCount = 0;
  const normalized: NormalizedCommitment[] = commitments.map((commitment) => {
    assertText(commitment.description, "Descrição");
    assertMoney(commitment.installmentAmountCents);
    if (!Number.isInteger(commitment.originalInstallmentCount) || commitment.originalInstallmentCount < 1 || commitment.originalInstallmentCount > 120) {
      throw new CardOnboardingError("Quantidade original de parcelas inválida.");
    }
    if (!Number.isInteger(commitment.firstOriginalInstallmentNumber)
      || commitment.firstOriginalInstallmentNumber < 1
      || commitment.firstOriginalInstallmentNumber > commitment.originalInstallmentCount) {
      throw new CardOnboardingError("Número da primeira parcela remanescente inválido.");
    }
    const firstReferenceMonth = commitment.firstReferenceMonth ?? input.initialReferenceMonth;
    assertReferenceMonth(firstReferenceMonth);
    if (firstReferenceMonth < input.initialReferenceMonth) throw new CardOnboardingError("Parcelas anteriores à implantação não podem ser importadas.");
    const remainingInstallmentCount = commitment.originalInstallmentCount - commitment.firstOriginalInstallmentNumber + 1;
    installmentCount += remainingInstallmentCount;
    const remainingTotalCents = commitment.installmentAmountCents * remainingInstallmentCount;
    if (!Number.isSafeInteger(remainingTotalCents) || remainingTotalCents > MAX_MONEY_CENTS) throw new CardOnboardingError("Valor remanescente inválido.");
    const originalTotalCents = commitment.originalTotalCents ?? null;
    if (originalTotalCents !== null) assertMoney(originalTotalCents);
    const originalPurchaseDate = commitment.originalPurchaseDate ?? null;
    if (originalPurchaseDate !== null && (!isCivilDate(originalPurchaseDate) || originalPurchaseDate > today)) {
      throw new CardOnboardingError("Data original da compra inválida.");
    }
    const categoryId = commitment.categoryId ?? null;
    const subcategoryId = commitment.subcategoryId ?? null;
    if (categoryId !== null) assertIdentifier(categoryId);
    if (subcategoryId !== null) assertIdentifier(subcategoryId);
    if (subcategoryId !== null && categoryId === null) throw new CardOnboardingError("A subcategoria exige uma categoria.");
    const notes = commitment.notes?.trim() || null;
    if (notes !== null && notes.length > 500) throw new CardOnboardingError("Observações inválidas.");
    return {
      ...commitment,
      description: commitment.description.trim(),
      firstReferenceMonth,
      originalTotalCents,
      originalPurchaseDate,
      categoryId,
      subcategoryId,
      notes,
      remainingInstallmentCount,
      remainingTotalCents,
    };
  });
  if (installmentCount > 120) throw new CardOnboardingError("A importação aceita no máximo 120 parcelas remanescentes.");
  return { commitments: normalized, installmentCount };
}

async function validateClassifications(commitments: NormalizedCommitment[], context: InvoiceContext) {
  for (const commitment of commitments) {
    if (commitment.categoryId === null) continue;
    const category = await context.d1.prepare(`SELECT id FROM categories
      WHERE id = ? AND household_id = ? AND is_active = 1 AND type IN ('expense','both') LIMIT 1`)
      .bind(commitment.categoryId, context.householdId).first();
    if (!category) throw new CardOnboardingError("Categoria inválida para este parcelamento.");
    if (commitment.subcategoryId !== null) {
      const subcategory = await context.d1.prepare(`SELECT id FROM subcategories
        WHERE id = ? AND household_id = ? AND category_id = ? AND is_active = 1 LIMIT 1`)
        .bind(commitment.subcategoryId, context.householdId, commitment.categoryId).first();
      if (!subcategory) throw new CardOnboardingError("Subcategoria inválida para este parcelamento.");
    }
  }
}

async function cardSnapshot(cardId: string, context: InvoiceContext) {
  return context.d1.prepare(`SELECT c.id, c.closing_day, c.due_day, c.updated_at, c.is_active,
      CASE WHEN
        EXISTS (SELECT 1 FROM card_purchases p WHERE p.household_id = c.household_id AND p.card_id = c.id)
        OR EXISTS (SELECT 1 FROM card_invoices i WHERE i.household_id = c.household_id AND i.card_id = c.id)
        OR EXISTS (SELECT 1 FROM card_import_batches b WHERE b.household_id = c.household_id AND b.card_id = c.id)
        OR EXISTS (SELECT 1 FROM card_invoice_adjustments a INNER JOIN card_invoices i
          ON i.household_id = a.household_id AND i.id = a.invoice_id
          WHERE i.household_id = c.household_id AND i.card_id = c.id)
        OR EXISTS (SELECT 1 FROM invoice_payments p INNER JOIN card_invoices i
          ON i.household_id = p.household_id AND i.id = p.invoice_id
          WHERE i.household_id = c.household_id AND i.card_id = c.id)
      THEN 1 ELSE 0 END AS has_activity
    FROM credit_cards c WHERE c.id = ? AND c.household_id = ? LIMIT 1`)
    .bind(cardId, context.householdId).first<CardSnapshot>();
}

/**
 * Eligibility is intentionally conservative: an active household card is eligible only
 * before any purchase, invoice, payment, adjustment or previous import exists. Empty
 * pre-created invoices are blocked too; onboarding is not a reconciliation tool.
 */
export async function getCardOnboardingEligibility(cardId: string, context: InvoiceContext) {
  assertIdentifier(cardId);
  await authorize(context);
  const card = await cardSnapshot(cardId, context);
  if (!card) return { eligible: false as const, reason: "not_found" as const };
  if (!card.is_active) return { eligible: false as const, reason: "inactive" as const };
  if (card.has_activity) return { eligible: false as const, reason: "existing_activity" as const };
  return { eligible: true as const };
}

export async function configureCardCurrentState(input: ConfigureCardCurrentStateInput, context: InvoiceContext) {
  assertIdentifier(input.cardId);
  assertIdentifier(input.idempotencyKey);
  if (input.operationId !== undefined) assertIdentifier(input.operationId);
  assertReferenceMonth(input.initialReferenceMonth);
  assertMoney(input.declaredCurrentInvoiceTotalCents, { zero: true });
  const timestamp = at(context);
  const today = invoiceCivilDate(timestamp);
  const currentMonth = today.slice(0, 7);
  if (input.initialReferenceMonth < currentMonth || input.initialReferenceMonth > addMonths(currentMonth, 1)) {
    throw new CardOnboardingError("A competência inicial deve ser a atual ou a próxima.");
  }
  await authorize(context);
  const normalized = normalizeCommitments(input, today);
  await validateClassifications(normalized.commitments, context);

  const fingerprint = await sha256({
    cardId: input.cardId,
    initialReferenceMonth: input.initialReferenceMonth,
    declaredCurrentInvoiceTotalCents: input.declaredCurrentInvoiceTotalCents,
    operationId: input.operationId ?? null,
    commitments: normalized.commitments.map((commitment) => ({
      description: commitment.description,
      installmentAmountCents: commitment.installmentAmountCents,
      firstOriginalInstallmentNumber: commitment.firstOriginalInstallmentNumber,
      originalInstallmentCount: commitment.originalInstallmentCount,
      firstReferenceMonth: commitment.firstReferenceMonth,
      originalTotalCents: commitment.originalTotalCents,
      originalPurchaseDate: commitment.originalPurchaseDate,
      categoryId: commitment.categoryId,
      subcategoryId: commitment.subcategoryId,
      notes: commitment.notes,
    })),
  });
  const existing = await findReceipt(input.idempotencyKey, context);
  if (existing) {
    assertReceipt(existing, fingerprint);
    return resultFromReceipt(existing, context, true);
  }

  const card = await cardSnapshot(input.cardId, context);
  if (!card || !card.is_active) throw new CardOnboardingError("Cartão inválido.", 404, "CARD_ONBOARDING_CARD_NOT_FOUND");
  if (card.has_activity) {
    throw new CardOnboardingError("Este cartão já possui atividade financeira e não pode receber uma importação inicial.", 409, "CARD_ONBOARDING_INELIGIBLE");
  }

  const importedCurrentCents = normalized.commitments.reduce((sum, commitment) => (
    commitment.firstReferenceMonth === input.initialReferenceMonth ? sum + commitment.installmentAmountCents : sum
  ), 0);
  const openingBalanceCents = input.declaredCurrentInvoiceTotalCents - importedCurrentCents;
  if (openingBalanceCents < 0) {
    throw new CardOnboardingError("O total das parcelas detalhadas supera o total declarado da fatura.", 409, "CARD_ONBOARDING_NEGATIVE_OPENING_BALANCE");
  }

  const batchId = input.operationId ?? uid("card_import");
  const invoiceIds = new Map<string, string>();
  invoiceIds.set(input.initialReferenceMonth, uid("invoice"));
  for (const commitment of normalized.commitments) {
    for (let index = 0; index < commitment.remainingInstallmentCount; index += 1) {
      const month = addMonths(commitment.firstReferenceMonth, index);
      if (!invoiceIds.has(month)) invoiceIds.set(month, uid("invoice"));
    }
  }
  const expectedInvoiceCount = invoiceIds.size;
  const d1 = context.d1;
  const statements: D1PreparedStatement[] = [];
  statements.push(d1.prepare(`INSERT INTO card_import_batches
      (id, household_id, card_id, created_by_user_id, idempotency_key, request_fingerprint,
       initial_reference_month, declared_invoice_total_cents, opening_balance_cents,
       imported_purchase_count, imported_installment_count, status, created_at, completed_at, voided_at)
    SELECT ?, ?, c.id, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL
    FROM credit_cards c
    WHERE c.id = ? AND c.household_id = ? AND c.is_active = 1
      AND c.closing_day = ? AND c.due_day = ? AND c.updated_at = ?
      AND EXISTS (SELECT 1 FROM household_members m WHERE m.household_id = c.household_id AND m.user_id = ? AND m.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM card_purchases p WHERE p.household_id = c.household_id AND p.card_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM card_invoices i WHERE i.household_id = c.household_id AND i.card_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM card_import_batches b WHERE b.household_id = c.household_id AND b.card_id = c.id)
    ON CONFLICT(household_id, idempotency_key) DO NOTHING`).bind(
    batchId, context.householdId, context.userId, input.idempotencyKey, fingerprint,
    input.initialReferenceMonth, input.declaredCurrentInvoiceTotalCents, openingBalanceCents,
    normalized.commitments.length, normalized.installmentCount, timestamp,
    input.cardId, context.householdId, card.closing_day, card.due_day, card.updated_at, context.userId,
  ));

  for (const [referenceMonth, invoiceId] of invoiceIds) {
    statements.push(d1.prepare(`INSERT INTO card_invoices
        (id, household_id, card_id, reference_month, due_date, closes_on, status, paid_at, created_at, updated_at)
      SELECT ?, b.household_id, b.card_id, ?, ?, ?, 'open', NULL, ?, ?
      FROM card_import_batches b INNER JOIN credit_cards c
        ON c.household_id = b.household_id AND c.id = b.card_id
      WHERE b.id = ? AND b.household_id = ? AND b.status = 'pending'
        AND c.is_active = 1 AND c.closing_day = ? AND c.due_day = ? AND c.updated_at = ?`)
      .bind(invoiceId, referenceMonth, dueDate(referenceMonth, card.due_day), invoiceClosesOn(referenceMonth, card.closing_day, card.due_day), timestamp, timestamp,
        batchId, context.householdId, card.closing_day, card.due_day, card.updated_at));
  }

  normalized.commitments.forEach((commitment) => {
    const purchaseId = uid("purchase");
    const metadataId = uid("purchase_import_metadata");
    statements.push(d1.prepare(`INSERT INTO card_purchases
        (id, household_id, card_id, description, total_cents, purchase_date, installment_count,
         category_id, subcategory_id, notes, status, created_by_user_id, origin, created_at, updated_at)
      SELECT ?, b.household_id, b.card_id, ?, ?, ?, ?, ?, ?, ?, 'active', b.created_by_user_id, 'system', ?, ?
      FROM card_import_batches b INNER JOIN credit_cards c
        ON c.household_id = b.household_id AND c.id = b.card_id
      WHERE b.id = ? AND b.household_id = ? AND b.status = 'pending'
        AND c.is_active = 1 AND c.updated_at = ?
        AND (? IS NULL OR EXISTS (SELECT 1 FROM categories cat
          WHERE cat.household_id = b.household_id AND cat.id = ? AND cat.is_active = 1 AND cat.type IN ('expense','both')))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM subcategories sub
          WHERE sub.household_id = b.household_id AND sub.id = ? AND sub.category_id = ? AND sub.is_active = 1))`)
      .bind(purchaseId, commitment.description, commitment.remainingTotalCents, commitment.originalPurchaseDate ?? today,
        commitment.remainingInstallmentCount, commitment.categoryId, commitment.subcategoryId, commitment.notes, timestamp, timestamp,
        batchId, context.householdId, card.updated_at,
        commitment.categoryId, commitment.categoryId,
        commitment.subcategoryId, commitment.subcategoryId, commitment.categoryId));

    for (let index = 0; index < commitment.remainingInstallmentCount; index += 1) {
      const referenceMonth = addMonths(commitment.firstReferenceMonth, index);
      statements.push(d1.prepare(`INSERT INTO card_installments
          (id, household_id, purchase_id, invoice_id, installment_number, installment_count,
           amount_cents, status, created_at, updated_at)
        SELECT ?, b.household_id, p.id, i.id, ?, ?, ?, 'pending', ?, ?
        FROM card_import_batches b
        INNER JOIN card_purchases p ON p.household_id = b.household_id AND p.id = ? AND p.card_id = b.card_id
        INNER JOIN card_invoices i ON i.household_id = b.household_id AND i.id = ? AND i.card_id = b.card_id
        WHERE b.id = ? AND b.household_id = ? AND b.status = 'pending'`)
        .bind(uid("installment"), index + 1, commitment.remainingInstallmentCount, commitment.installmentAmountCents,
          timestamp, timestamp, purchaseId, invoiceIds.get(referenceMonth)!, batchId, context.householdId));
    }

    statements.push(d1.prepare(`INSERT INTO card_purchase_import_metadata
        (id, household_id, purchase_id, import_batch_id, first_original_installment_number,
         original_installment_count, original_total_cents, original_purchase_date, imported_at)
      SELECT ?, b.household_id, p.id, b.id, ?, ?, ?, ?, ?
      FROM card_import_batches b INNER JOIN card_purchases p
        ON p.household_id = b.household_id AND p.id = ? AND p.card_id = b.card_id
      WHERE b.id = ? AND b.household_id = ? AND b.status = 'pending'`)
      .bind(metadataId, commitment.firstOriginalInstallmentNumber, commitment.originalInstallmentCount,
        commitment.originalTotalCents, commitment.originalPurchaseDate, timestamp,
        purchaseId, batchId, context.householdId));
  });

  const initialInvoiceId = invoiceIds.get(input.initialReferenceMonth)!;
  if (openingBalanceCents > 0) {
    statements.push(d1.prepare(`INSERT INTO card_invoice_adjustments
        (id, household_id, invoice_id, import_batch_id, kind, amount_cents, status, created_by_user_id, created_at, voided_at)
      SELECT ?, b.household_id, i.id, b.id, 'opening_balance',
        CASE WHEN COALESCE((SELECT SUM(s.amount_cents) FROM card_installments s
          WHERE s.household_id = i.household_id AND s.invoice_id = i.id AND s.status <> 'cancelled'), 0)
          = b.declared_invoice_total_cents - b.opening_balance_cents
        THEN b.opening_balance_cents ELSE -1 END,
        'active', b.created_by_user_id, ?, NULL
      FROM card_import_batches b INNER JOIN card_invoices i
        ON i.household_id = b.household_id AND i.id = ? AND i.card_id = b.card_id
      WHERE b.id = ? AND b.household_id = ? AND b.status = 'pending'`)
      .bind(uid("invoice_adjustment"), timestamp, initialInvoiceId, batchId, context.householdId));
  }

  statements.push(d1.prepare(`UPDATE card_import_batches
    SET status = CASE WHEN
      status = 'pending'
      AND EXISTS (SELECT 1 FROM household_members m
        WHERE m.household_id = card_import_batches.household_id AND m.user_id = ? AND m.status = 'active')
      AND EXISTS (SELECT 1 FROM credit_cards c
        WHERE c.household_id = card_import_batches.household_id AND c.id = card_import_batches.card_id
          AND c.is_active = 1 AND c.closing_day = ? AND c.due_day = ? AND c.updated_at = ?)
      AND (SELECT COUNT(*) FROM card_invoices i
        WHERE i.household_id = card_import_batches.household_id AND i.card_id = card_import_batches.card_id) = ?
      AND EXISTS (SELECT 1 FROM card_invoices i
        WHERE i.household_id = card_import_batches.household_id AND i.id = ? AND i.card_id = card_import_batches.card_id
          AND i.reference_month = card_import_batches.initial_reference_month AND i.due_date = ? AND i.closes_on = ?)
      AND (SELECT COUNT(*) FROM card_purchase_import_metadata m
        WHERE m.household_id = card_import_batches.household_id AND m.import_batch_id = card_import_batches.id)
          = card_import_batches.imported_purchase_count
      AND (SELECT COUNT(*) FROM card_installments s INNER JOIN card_purchases p
        ON p.household_id = s.household_id AND p.id = s.purchase_id
        INNER JOIN card_purchase_import_metadata m
          ON m.household_id = p.household_id AND m.purchase_id = p.id AND m.import_batch_id = card_import_batches.id
        WHERE s.household_id = card_import_batches.household_id)
          = card_import_batches.imported_installment_count
      AND COALESCE((SELECT SUM(s.amount_cents) FROM card_installments s
        WHERE s.household_id = card_import_batches.household_id AND s.invoice_id = ? AND s.status <> 'cancelled'), 0)
        + COALESCE((SELECT SUM(a.amount_cents) FROM card_invoice_adjustments a
          WHERE a.household_id = card_import_batches.household_id AND a.invoice_id = ? AND a.status = 'active'), 0)
        = card_import_batches.declared_invoice_total_cents
      AND COALESCE((SELECT SUM(a.amount_cents) FROM card_invoice_adjustments a
        WHERE a.household_id = card_import_batches.household_id AND a.invoice_id = ? AND a.status = 'active'), 0)
        = card_import_batches.opening_balance_cents
    THEN 'completed' ELSE NULL END,
    completed_at = ?
    WHERE id = ? AND household_id = ?`).bind(
    context.userId, card.closing_day, card.due_day, card.updated_at, expectedInvoiceCount,
    initialInvoiceId, dueDate(input.initialReferenceMonth, card.due_day), invoiceClosesOn(input.initialReferenceMonth, card.closing_day, card.due_day),
    initialInvoiceId, initialInvoiceId, initialInvoiceId, timestamp, batchId, context.householdId,
  ));
  statements.push(d1.prepare(`INSERT INTO audit_logs
      (id, household_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at)
    SELECT 'card_import_audit:' || b.id, b.household_id, b.created_by_user_id,
      'configure_initial_state', 'card_import_batch', b.id, NULL,
      json_object('cardId', b.card_id, 'initialReferenceMonth', b.initial_reference_month,
        'declaredInvoiceTotalCents', b.declared_invoice_total_cents,
        'openingBalanceCents', b.opening_balance_cents,
        'importedPurchaseCount', b.imported_purchase_count,
        'importedInstallmentCount', b.imported_installment_count), ?
    FROM card_import_batches b
    WHERE b.id = ? AND b.household_id = ? AND b.status = 'completed'
    ON CONFLICT(id) DO NOTHING`).bind(timestamp, batchId, context.householdId));

  let results: D1Result<unknown>[];
  try {
    results = await d1.batch(statements);
  } catch (error) {
    const raced = await findReceipt(input.idempotencyKey, context);
    if (raced) {
      assertReceipt(raced, fingerprint);
      return resultFromReceipt(raced, context, true);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/card import batch financial identity cannot be replaced|card_import_batches_active_card_unique|UNIQUE constraint failed: card_import_batches\.household_id, card_import_batches\.card_id/iu.test(message)) {
      throw new CardOnboardingError("Este cartão já possui uma importação inicial.", 409, "CARD_ONBOARDING_ALREADY_IMPORTED");
    }
    if (/FOREIGN KEY constraint failed|card import|card installment purchase and invoice|NOT NULL constraint failed: card_import_batches\.status/iu.test(message)) {
      throw new CardOnboardingError("Os dados do cartão mudaram durante a configuração. Atualize e tente novamente.", 409, "CARD_ONBOARDING_CONFLICT");
    }
    throw error;
  }
  const completed = await findReceipt(input.idempotencyKey, context);
  if (!completed) {
    throw new CardOnboardingError("Este cartão já possui atividade financeira e não pode receber uma importação inicial.", 409, "CARD_ONBOARDING_INELIGIBLE");
  }
  assertReceipt(completed, fingerprint);
  return resultFromReceipt(completed, context, (results[0]?.meta.changes ?? 0) === 0);
}

ALTER TABLE `card_import_batches`
  ADD COLUMN `import_kind` text DEFAULT 'initial_state' NOT NULL
  CONSTRAINT `card_import_batches_kind_check`
  CHECK (`import_kind` IN ('initial_state','existing_installments'));
--> statement-breakpoint

DROP INDEX `card_import_batches_active_card_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `card_import_batches_initial_card_unique`
  ON `card_import_batches` (`household_id`,`card_id`)
  WHERE `import_kind` = 'initial_state' AND `status` IN ('pending','completed');
--> statement-breakpoint
CREATE UNIQUE INDEX `card_import_batches_pending_card_unique`
  ON `card_import_batches` (`household_id`,`card_id`)
  WHERE `status` = 'pending';
--> statement-breakpoint

DROP TRIGGER `card_import_batches_financial_identity_insert`;
--> statement-breakpoint
CREATE TRIGGER `card_import_batches_financial_identity_insert`
BEFORE INSERT ON `card_import_batches`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `card_import_batches` current
  WHERE current.`id` = NEW.`id`
    OR (current.`household_id` = NEW.`household_id`
      AND current.`idempotency_key` = NEW.`idempotency_key`)
    OR (NEW.`status` = 'pending'
      AND current.`household_id` = NEW.`household_id`
      AND current.`card_id` = NEW.`card_id`
      AND current.`status` = 'pending')
    OR (NEW.`import_kind` = 'initial_state'
      AND NEW.`status` IN ('pending','completed')
      AND current.`household_id` = NEW.`household_id`
      AND current.`card_id` = NEW.`card_id`
      AND current.`import_kind` = 'initial_state'
      AND current.`status` IN ('pending','completed'))
) BEGIN SELECT RAISE(ABORT, 'card import batch financial identity cannot be replaced'); END;
--> statement-breakpoint

DROP TRIGGER `card_import_batches_identity_update`;
--> statement-breakpoint
CREATE TRIGGER `card_import_batches_identity_update`
BEFORE UPDATE ON `card_import_batches`
FOR EACH ROW WHEN
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`household_id` IS NOT OLD.`household_id`
  OR NEW.`card_id` IS NOT OLD.`card_id`
  OR NEW.`created_by_user_id` IS NOT OLD.`created_by_user_id`
  OR NEW.`idempotency_key` IS NOT OLD.`idempotency_key`
  OR NEW.`request_fingerprint` IS NOT OLD.`request_fingerprint`
  OR NEW.`import_kind` IS NOT OLD.`import_kind`
  OR NEW.`initial_reference_month` IS NOT OLD.`initial_reference_month`
  OR NEW.`declared_invoice_total_cents` IS NOT OLD.`declared_invoice_total_cents`
  OR NEW.`opening_balance_cents` IS NOT OLD.`opening_balance_cents`
  OR NEW.`imported_purchase_count` IS NOT OLD.`imported_purchase_count`
  OR NEW.`imported_installment_count` IS NOT OLD.`imported_installment_count`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'card import batch financial identity is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `card_import_batches_existing_opening_insert`
BEFORE INSERT ON `card_import_batches`
FOR EACH ROW WHEN NEW.`import_kind` = 'existing_installments' AND NEW.`opening_balance_cents` <> 0
BEGIN SELECT RAISE(ABORT, 'existing installment import cannot create opening balance'); END;
--> statement-breakpoint

PRAGMA optimize;

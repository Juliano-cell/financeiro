CREATE UNIQUE INDEX `card_installments_household_id_unique`
  ON `card_installments` (`household_id`,`id`);
--> statement-breakpoint

CREATE TABLE `card_opening_balance_allocations` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `opening_adjustment_id` text NOT NULL,
  `initial_import_batch_id` text NOT NULL,
  `source_import_batch_id` text NOT NULL,
  `invoice_id` text NOT NULL,
  `purchase_id` text NOT NULL,
  `installment_id` text NOT NULL,
  `amount_cents` integer NOT NULL,
  `created_by_user_id` text NOT NULL,
  `created_at` text NOT NULL,
  CONSTRAINT `card_opening_balance_allocations_household_id_unique` UNIQUE (`household_id`,`id`),
  CONSTRAINT `card_opening_balance_allocations_installment_unique` UNIQUE (`household_id`,`installment_id`),
  CONSTRAINT `card_opening_allocations_household_adjustment_fk` FOREIGN KEY (`household_id`,`opening_adjustment_id`) REFERENCES `card_invoice_adjustments`(`household_id`,`id`),
  CONSTRAINT `card_opening_allocations_household_initial_batch_fk` FOREIGN KEY (`household_id`,`initial_import_batch_id`) REFERENCES `card_import_batches`(`household_id`,`id`),
  CONSTRAINT `card_opening_allocations_household_source_batch_fk` FOREIGN KEY (`household_id`,`source_import_batch_id`) REFERENCES `card_import_batches`(`household_id`,`id`),
  CONSTRAINT `card_opening_allocations_household_invoice_fk` FOREIGN KEY (`household_id`,`invoice_id`) REFERENCES `card_invoices`(`household_id`,`id`),
  CONSTRAINT `card_opening_allocations_household_purchase_fk` FOREIGN KEY (`household_id`,`purchase_id`) REFERENCES `card_purchases`(`household_id`,`id`),
  CONSTRAINT `card_opening_allocations_household_installment_fk` FOREIGN KEY (`household_id`,`installment_id`) REFERENCES `card_installments`(`household_id`,`id`),
  CONSTRAINT `card_opening_allocations_household_creator_fk` FOREIGN KEY (`household_id`,`created_by_user_id`) REFERENCES `household_members`(`household_id`,`user_id`),
  CONSTRAINT `card_opening_balance_allocations_identifiers_check` CHECK (
    length(trim(`id`)) > 0 AND length(trim(`household_id`)) > 0
    AND length(trim(`opening_adjustment_id`)) > 0 AND length(trim(`initial_import_batch_id`)) > 0
    AND length(trim(`source_import_batch_id`)) > 0 AND length(trim(`invoice_id`)) > 0
    AND length(trim(`purchase_id`)) > 0 AND length(trim(`installment_id`)) > 0
    AND length(trim(`created_by_user_id`)) > 0
  ),
  CONSTRAINT `card_opening_balance_allocations_amount_check` CHECK (
    typeof(`amount_cents`) = 'integer' AND `amount_cents` BETWEEN 1 AND 9007199254740991
  )
);
--> statement-breakpoint

CREATE INDEX `idx_card_opening_allocations_adjustment`
  ON `card_opening_balance_allocations` (`household_id`,`opening_adjustment_id`);
--> statement-breakpoint
CREATE INDEX `idx_card_opening_allocations_source_batch`
  ON `card_opening_balance_allocations` (`household_id`,`source_import_batch_id`);
--> statement-breakpoint

CREATE TRIGGER `card_opening_balance_allocations_relations_insert`
BEFORE INSERT ON `card_opening_balance_allocations`
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM `card_invoice_adjustments` a
  INNER JOIN `card_import_batches` initial
    ON initial.`household_id` = a.`household_id` AND initial.`id` = NEW.`initial_import_batch_id`
  INNER JOIN `card_import_batches` source
    ON source.`household_id` = a.`household_id` AND source.`id` = NEW.`source_import_batch_id`
  INNER JOIN `card_invoices` i
    ON i.`household_id` = a.`household_id` AND i.`id` = NEW.`invoice_id`
  INNER JOIN `card_purchases` p
    ON p.`household_id` = a.`household_id` AND p.`id` = NEW.`purchase_id`
  INNER JOIN `card_installments` s
    ON s.`household_id` = a.`household_id` AND s.`id` = NEW.`installment_id`
  INNER JOIN `card_purchase_import_metadata` m
    ON m.`household_id` = p.`household_id` AND m.`purchase_id` = p.`id`
  WHERE a.`household_id` = NEW.`household_id` AND a.`id` = NEW.`opening_adjustment_id`
    AND a.`kind` = 'opening_balance' AND a.`status` = 'active'
    AND a.`invoice_id` = i.`id` AND a.`import_batch_id` = initial.`id`
    AND initial.`import_kind` = 'initial_state' AND initial.`status` = 'completed'
    AND initial.`card_id` = i.`card_id` AND initial.`initial_reference_month` = i.`reference_month`
    AND initial.`opening_balance_cents` = a.`amount_cents`
    AND source.`import_kind` = 'existing_installments' AND source.`status` = 'pending'
    AND source.`card_id` = initial.`card_id` AND source.`initial_reference_month` = initial.`initial_reference_month`
    AND source.`created_by_user_id` = NEW.`created_by_user_id`
    AND m.`import_batch_id` = source.`id`
    AND p.`card_id` = initial.`card_id` AND p.`origin` = 'system' AND p.`status` = 'active'
    AND s.`purchase_id` = p.`id` AND s.`invoice_id` = i.`id`
    AND s.`installment_number` = 1 AND s.`status` <> 'cancelled'
    AND s.`amount_cents` = NEW.`amount_cents`
) BEGIN SELECT RAISE(ABORT, 'opening balance allocation does not match financial facts'); END;
--> statement-breakpoint

CREATE TRIGGER `card_opening_balance_allocations_residual_insert`
BEFORE INSERT ON `card_opening_balance_allocations`
FOR EACH ROW WHEN NEW.`amount_cents` + COALESCE((
  SELECT SUM(current.`amount_cents`)
  FROM `card_opening_balance_allocations` current
  WHERE current.`household_id` = NEW.`household_id`
    AND current.`opening_adjustment_id` = NEW.`opening_adjustment_id`
), 0) > COALESCE((
  SELECT a.`amount_cents` FROM `card_invoice_adjustments` a
  WHERE a.`household_id` = NEW.`household_id` AND a.`id` = NEW.`opening_adjustment_id`
    AND a.`kind` = 'opening_balance' AND a.`status` = 'active'
), 0)
BEGIN SELECT RAISE(ABORT, 'opening balance allocation exceeds residual'); END;
--> statement-breakpoint

CREATE TRIGGER `card_opening_balance_allocations_update`
BEFORE UPDATE ON `card_opening_balance_allocations`
FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'opening balance allocation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `card_opening_balance_allocations_delete`
BEFORE DELETE ON `card_opening_balance_allocations`
FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'opening balance allocation cannot be deleted'); END;
--> statement-breakpoint

DROP TRIGGER `card_import_batches_completion_update`;
--> statement-breakpoint
CREATE TRIGGER `card_import_batches_completion_update`
BEFORE UPDATE OF `status`,`completed_at`,`voided_at` ON `card_import_batches`
FOR EACH ROW WHEN OLD.`status` = 'pending' AND NEW.`status` = 'completed' AND (
  NOT EXISTS (
    SELECT 1 FROM `household_members` m
    WHERE m.`household_id` = NEW.`household_id`
      AND m.`user_id` = NEW.`created_by_user_id` AND m.`status` = 'active'
  )
  OR NOT EXISTS (
    SELECT 1 FROM `credit_cards` c
    WHERE c.`household_id` = NEW.`household_id`
      AND c.`id` = NEW.`card_id` AND c.`is_active` = 1
  )
  OR NOT EXISTS (
    SELECT 1 FROM `card_invoices` i
    WHERE i.`household_id` = NEW.`household_id` AND i.`card_id` = NEW.`card_id`
      AND i.`reference_month` = NEW.`initial_reference_month`
  )
  OR (SELECT COUNT(*) FROM `card_purchase_import_metadata` m
    WHERE m.`household_id` = NEW.`household_id` AND m.`import_batch_id` = NEW.`id`)
      <> NEW.`imported_purchase_count`
  OR (SELECT COUNT(*) FROM `card_installments` s
    INNER JOIN `card_purchases` p
      ON p.`household_id` = s.`household_id` AND p.`id` = s.`purchase_id`
    INNER JOIN `card_purchase_import_metadata` m
      ON m.`household_id` = p.`household_id` AND m.`purchase_id` = p.`id`
      AND m.`import_batch_id` = NEW.`id`
    WHERE s.`household_id` = NEW.`household_id`) <> NEW.`imported_installment_count`
  OR EXISTS (
    SELECT 1
    FROM `card_purchase_import_metadata` m
    INNER JOIN `card_purchases` p
      ON p.`household_id` = m.`household_id` AND p.`id` = m.`purchase_id`
    WHERE m.`household_id` = NEW.`household_id` AND m.`import_batch_id` = NEW.`id`
      AND (p.`card_id` IS NOT NEW.`card_id`
        OR p.`created_by_user_id` IS NOT NEW.`created_by_user_id`
        OR p.`origin` <> 'system'
        OR p.`installment_count` <> m.`original_installment_count` - m.`first_original_installment_number` + 1)
  )
  OR (NEW.`opening_balance_cents` > 0 AND (
    SELECT COUNT(*) FROM `card_invoice_adjustments` a
    WHERE a.`household_id` = NEW.`household_id` AND a.`import_batch_id` = NEW.`id`
      AND a.`kind` = 'opening_balance' AND a.`status` = 'active'
      AND a.`amount_cents` = NEW.`opening_balance_cents`
  ) <> 1)
  OR (NEW.`opening_balance_cents` = 0 AND EXISTS (
    SELECT 1 FROM `card_invoice_adjustments` a
    WHERE a.`household_id` = NEW.`household_id` AND a.`import_batch_id` = NEW.`id`
  ))
  OR COALESCE((
    SELECT SUM(a.`amount_cents`) FROM `card_invoice_adjustments` a
    WHERE a.`household_id` = NEW.`household_id` AND a.`import_batch_id` = NEW.`id`
      AND a.`kind` = 'opening_balance' AND a.`status` = 'active'
  ), 0) <> NEW.`opening_balance_cents`
  OR NOT EXISTS (
    SELECT 1 FROM `card_invoices` i
    WHERE i.`household_id` = NEW.`household_id` AND i.`card_id` = NEW.`card_id`
      AND i.`reference_month` = NEW.`initial_reference_month`
      AND COALESCE((SELECT SUM(s.`amount_cents`) FROM `card_installments` s
        WHERE s.`household_id` = i.`household_id` AND s.`invoice_id` = i.`id`
          AND s.`status` <> 'cancelled'), 0)
        + COALESCE((SELECT SUM(a.`amount_cents`) FROM `card_invoice_adjustments` a
          WHERE a.`household_id` = i.`household_id` AND a.`invoice_id` = i.`id`
            AND a.`status` = 'active'), 0)
        - COALESCE((SELECT SUM(o.`amount_cents`) FROM `card_opening_balance_allocations` o
          WHERE o.`household_id` = i.`household_id` AND o.`invoice_id` = i.`id`), 0)
          = NEW.`declared_invoice_total_cents`
  )
) BEGIN SELECT RAISE(ABORT, 'card import batch cannot complete with inconsistent financial facts'); END;
--> statement-breakpoint

PRAGMA optimize;

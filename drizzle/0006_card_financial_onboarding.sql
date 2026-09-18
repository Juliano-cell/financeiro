-- Refuse the hardening migration instead of silently accepting a legacy
-- installment whose purchase and invoice belong to different cards.
CREATE TABLE `_migration_0006_cross_card_guard` (
  `valid` integer NOT NULL CONSTRAINT `migration_0006_cross_card_guard_check` CHECK (`valid` = 1)
);
--> statement-breakpoint
INSERT INTO `_migration_0006_cross_card_guard` (`valid`)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM `card_installments` s
  INNER JOIN `card_purchases` p
    ON p.`household_id` = s.`household_id` AND p.`id` = s.`purchase_id`
  INNER JOIN `card_invoices` i
    ON i.`household_id` = s.`household_id` AND i.`id` = s.`invoice_id`
  WHERE p.`card_id` IS NOT i.`card_id`
) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `_migration_0006_cross_card_guard`;
--> statement-breakpoint

CREATE TABLE `card_import_batches` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `card_id` text NOT NULL,
  `created_by_user_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `request_fingerprint` text NOT NULL,
  `initial_reference_month` text NOT NULL,
  `declared_invoice_total_cents` integer NOT NULL,
  `opening_balance_cents` integer NOT NULL,
  `imported_purchase_count` integer NOT NULL,
  `imported_installment_count` integer NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `created_at` text NOT NULL,
  `completed_at` text,
  `voided_at` text,
  CONSTRAINT `card_import_batches_household_id_unique` UNIQUE (`household_id`,`id`),
  CONSTRAINT `card_import_batches_household_card_fk` FOREIGN KEY (`household_id`,`card_id`) REFERENCES `credit_cards`(`household_id`,`id`),
  CONSTRAINT `card_import_batches_household_creator_fk` FOREIGN KEY (`household_id`,`created_by_user_id`) REFERENCES `household_members`(`household_id`,`user_id`),
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  CONSTRAINT `card_import_batches_identifiers_check` CHECK (
    length(trim(`id`)) > 0 AND length(trim(`household_id`)) > 0
    AND length(trim(`card_id`)) > 0 AND length(trim(`created_by_user_id`)) > 0
    AND length(trim(`idempotency_key`)) > 0 AND length(trim(`request_fingerprint`)) > 0
  ),
  CONSTRAINT `card_import_batches_reference_month_check` CHECK (
    length(`initial_reference_month`) = 7
    AND `initial_reference_month` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND date(`initial_reference_month` || '-01', '+0 days') = `initial_reference_month` || '-01'
  ),
  CONSTRAINT `card_import_batches_amounts_check` CHECK (
    typeof(`declared_invoice_total_cents`) = 'integer'
    AND typeof(`opening_balance_cents`) = 'integer'
    AND `declared_invoice_total_cents` BETWEEN 0 AND 9007199254740991
    AND `opening_balance_cents` BETWEEN 0 AND `declared_invoice_total_cents`
  ),
  CONSTRAINT `card_import_batches_counts_check` CHECK (
    typeof(`imported_purchase_count`) = 'integer' AND `imported_purchase_count` BETWEEN 0 AND 50
    AND typeof(`imported_installment_count`) = 'integer' AND `imported_installment_count` BETWEEN 0 AND 120
  ),
  CONSTRAINT `card_import_batches_status_check` CHECK (`status` IN ('pending','completed','voided')),
  CONSTRAINT `card_import_batches_lifecycle_check` CHECK (
    (`status` = 'pending' AND `completed_at` IS NULL AND `voided_at` IS NULL)
    OR (`status` = 'completed' AND `completed_at` IS NOT NULL AND `voided_at` IS NULL)
    OR (`status` = 'voided' AND `completed_at` IS NOT NULL AND `voided_at` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_import_batches_household_key_unique`
  ON `card_import_batches` (`household_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_import_batches_active_card_unique`
  ON `card_import_batches` (`household_id`,`card_id`)
  WHERE `status` IN ('pending','completed');
--> statement-breakpoint
CREATE INDEX `idx_card_import_batches_household_created`
  ON `card_import_batches` (`household_id`,`created_at`);
--> statement-breakpoint

CREATE TABLE `card_purchase_import_metadata` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `purchase_id` text NOT NULL,
  `import_batch_id` text NOT NULL,
  `first_original_installment_number` integer NOT NULL,
  `original_installment_count` integer NOT NULL,
  `original_total_cents` integer,
  `original_purchase_date` text,
  `imported_at` text NOT NULL,
  CONSTRAINT `card_purchase_import_metadata_household_id_unique` UNIQUE (`household_id`,`id`),
  CONSTRAINT `card_purchase_import_metadata_purchase_unique` UNIQUE (`household_id`,`purchase_id`),
  CONSTRAINT `card_purchase_import_metadata_household_purchase_fk` FOREIGN KEY (`household_id`,`purchase_id`) REFERENCES `card_purchases`(`household_id`,`id`),
  CONSTRAINT `card_purchase_import_metadata_household_batch_fk` FOREIGN KEY (`household_id`,`import_batch_id`) REFERENCES `card_import_batches`(`household_id`,`id`),
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  CONSTRAINT `card_purchase_import_metadata_numbers_check` CHECK (
    typeof(`first_original_installment_number`) = 'integer'
    AND typeof(`original_installment_count`) = 'integer'
    AND `first_original_installment_number` BETWEEN 1 AND `original_installment_count`
    AND `original_installment_count` BETWEEN 1 AND 120
  ),
  CONSTRAINT `card_purchase_import_metadata_total_check` CHECK (
    `original_total_cents` IS NULL
    OR (typeof(`original_total_cents`) = 'integer' AND `original_total_cents` BETWEEN 1 AND 9007199254740991)
  ),
  CONSTRAINT `card_purchase_import_metadata_date_check` CHECK (
    `original_purchase_date` IS NULL
    OR (length(`original_purchase_date`) = 10
      AND `original_purchase_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND `original_purchase_date` >= '0001-01-01'
      AND date(`original_purchase_date`, '+0 days') = `original_purchase_date`)
  )
);
--> statement-breakpoint
CREATE INDEX `idx_card_purchase_import_metadata_batch`
  ON `card_purchase_import_metadata` (`household_id`,`import_batch_id`);
--> statement-breakpoint

CREATE TABLE `card_invoice_adjustments` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `invoice_id` text NOT NULL,
  `import_batch_id` text NOT NULL,
  `kind` text NOT NULL,
  `amount_cents` integer NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `created_by_user_id` text NOT NULL,
  `created_at` text NOT NULL,
  `voided_at` text,
  CONSTRAINT `card_invoice_adjustments_household_id_unique` UNIQUE (`household_id`,`id`),
  CONSTRAINT `card_invoice_adjustments_household_invoice_fk` FOREIGN KEY (`household_id`,`invoice_id`) REFERENCES `card_invoices`(`household_id`,`id`),
  CONSTRAINT `card_invoice_adjustments_household_batch_fk` FOREIGN KEY (`household_id`,`import_batch_id`) REFERENCES `card_import_batches`(`household_id`,`id`),
  CONSTRAINT `card_invoice_adjustments_household_creator_fk` FOREIGN KEY (`household_id`,`created_by_user_id`) REFERENCES `household_members`(`household_id`,`user_id`),
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  CONSTRAINT `card_invoice_adjustments_kind_check` CHECK (`kind` = 'opening_balance'),
  CONSTRAINT `card_invoice_adjustments_amount_check` CHECK (
    typeof(`amount_cents`) = 'integer' AND `amount_cents` BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT `card_invoice_adjustments_status_check` CHECK (`status` IN ('active','voided')),
  CONSTRAINT `card_invoice_adjustments_void_check` CHECK (
    (`status` = 'active' AND `voided_at` IS NULL)
    OR (`status` = 'voided' AND `voided_at` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_invoice_adjustments_active_opening_unique`
  ON `card_invoice_adjustments` (`household_id`,`invoice_id`,`kind`)
  WHERE `status` = 'active';
--> statement-breakpoint
CREATE INDEX `idx_card_invoice_adjustments_household_invoice`
  ON `card_invoice_adjustments` (`household_id`,`invoice_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_card_invoice_adjustments_batch`
  ON `card_invoice_adjustments` (`household_id`,`import_batch_id`);
--> statement-breakpoint

-- SQLite implements INSERT OR REPLACE as a conflicting-row deletion followed by
-- an insert. Guard existing financial identities before that implicit deletion,
-- because UPDATE/DELETE triggers alone do not make REPLACE immutable.
CREATE TRIGGER `card_purchases_financial_identity_insert`
BEFORE INSERT ON `card_purchases`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `card_purchases` current WHERE current.`id` = NEW.`id`
) BEGIN SELECT RAISE(ABORT, 'card purchase financial identity cannot be replaced'); END;
--> statement-breakpoint
CREATE TRIGGER `card_invoices_financial_identity_insert`
BEFORE INSERT ON `card_invoices`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `card_invoices` current WHERE current.`id` = NEW.`id`
) BEGIN SELECT RAISE(ABORT, 'card invoice financial identity cannot be replaced'); END;
--> statement-breakpoint
-- Preserve the existing createCardPurchase ON CONFLICT reuse semantics while
-- preventing REPLACE with a new id from deleting an invoice for the same cycle.
CREATE TRIGGER `card_invoices_cycle_collision_insert`
BEFORE INSERT ON `card_invoices`
FOR EACH ROW WHEN
  NOT EXISTS (SELECT 1 FROM `card_invoices` current WHERE current.`id` = NEW.`id`)
  AND EXISTS (
    SELECT 1 FROM `card_invoices` current
    WHERE current.`household_id` = NEW.`household_id`
      AND current.`card_id` = NEW.`card_id`
      AND current.`reference_month` = NEW.`reference_month`
  )
BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint
CREATE TRIGGER `card_installments_financial_identity_insert`
BEFORE INSERT ON `card_installments`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `card_installments` current
  WHERE current.`id` = NEW.`id`
    OR (current.`purchase_id` = NEW.`purchase_id`
      AND current.`installment_number` = NEW.`installment_number`)
) BEGIN SELECT RAISE(ABORT, 'card installment financial identity cannot be replaced'); END;
--> statement-breakpoint

CREATE TRIGGER `card_import_batches_financial_identity_insert`
BEFORE INSERT ON `card_import_batches`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `card_import_batches` current
  WHERE current.`id` = NEW.`id`
    OR (current.`household_id` = NEW.`household_id`
      AND current.`idempotency_key` = NEW.`idempotency_key`)
    OR (NEW.`status` IN ('pending','completed')
      AND current.`household_id` = NEW.`household_id`
      AND current.`card_id` = NEW.`card_id`
      AND current.`status` IN ('pending','completed'))
) BEGIN SELECT RAISE(ABORT, 'card import batch financial identity cannot be replaced'); END;
--> statement-breakpoint
CREATE TRIGGER `card_import_batches_pending_insert`
BEFORE INSERT ON `card_import_batches`
FOR EACH ROW WHEN NEW.`status` <> 'pending' OR NEW.`completed_at` IS NOT NULL OR NEW.`voided_at` IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'card import batch must start pending'); END;
--> statement-breakpoint

CREATE TRIGGER `card_purchase_import_metadata_financial_identity_insert`
BEFORE INSERT ON `card_purchase_import_metadata`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `card_purchase_import_metadata` current
  WHERE current.`id` = NEW.`id`
    OR (current.`household_id` = NEW.`household_id`
      AND current.`purchase_id` = NEW.`purchase_id`)
) BEGIN SELECT RAISE(ABORT, 'card import metadata financial identity cannot be replaced'); END;
--> statement-breakpoint

CREATE TRIGGER `card_invoice_adjustments_financial_identity_insert`
BEFORE INSERT ON `card_invoice_adjustments`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `card_invoice_adjustments` current
  WHERE current.`id` = NEW.`id`
    OR (current.`household_id` = NEW.`household_id`
      AND current.`invoice_id` = NEW.`invoice_id`
      AND current.`kind` = NEW.`kind`)
    OR (current.`household_id` = NEW.`household_id`
      AND current.`import_batch_id` = NEW.`import_batch_id`
      AND current.`kind` = NEW.`kind`)
) BEGIN SELECT RAISE(ABORT, 'card invoice adjustment financial identity cannot be replaced'); END;
--> statement-breakpoint

CREATE TRIGGER `card_purchase_import_metadata_relations_insert`
BEFORE INSERT ON `card_purchase_import_metadata`
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM `card_purchases` p
  INNER JOIN `card_import_batches` b
    ON b.`household_id` = p.`household_id` AND b.`id` = NEW.`import_batch_id`
  WHERE p.`household_id` = NEW.`household_id` AND p.`id` = NEW.`purchase_id`
    AND p.`card_id` = b.`card_id` AND p.`origin` = 'system'
    AND p.`created_by_user_id` = b.`created_by_user_id`
    AND p.`installment_count` = NEW.`original_installment_count` - NEW.`first_original_installment_number` + 1
    AND b.`status` = 'pending'
) BEGIN SELECT RAISE(ABORT, 'card import metadata does not match purchase and batch'); END;
--> statement-breakpoint
CREATE TRIGGER `card_purchase_import_metadata_immutable_update`
BEFORE UPDATE ON `card_purchase_import_metadata`
FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'card import metadata is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `card_purchase_import_metadata_delete`
BEFORE DELETE ON `card_purchase_import_metadata`
FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'card import metadata cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER `card_invoice_adjustments_relations_insert`
BEFORE INSERT ON `card_invoice_adjustments`
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM `card_invoices` i
  INNER JOIN `card_import_batches` b
    ON b.`household_id` = i.`household_id` AND b.`id` = NEW.`import_batch_id`
  WHERE i.`household_id` = NEW.`household_id` AND i.`id` = NEW.`invoice_id`
    AND i.`card_id` = b.`card_id` AND i.`reference_month` = b.`initial_reference_month`
    AND NEW.`created_by_user_id` = b.`created_by_user_id`
    AND NEW.`amount_cents` = b.`opening_balance_cents`
    AND NEW.`status` = 'active' AND NEW.`voided_at` IS NULL
    AND b.`status` = 'pending'
) BEGIN SELECT RAISE(ABORT, 'card invoice adjustment does not match invoice and batch'); END;
--> statement-breakpoint
CREATE TRIGGER `card_invoice_adjustments_identity_update`
BEFORE UPDATE ON `card_invoice_adjustments`
FOR EACH ROW WHEN
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`household_id` IS NOT OLD.`household_id`
  OR NEW.`invoice_id` IS NOT OLD.`invoice_id`
  OR NEW.`import_batch_id` IS NOT OLD.`import_batch_id`
  OR NEW.`kind` IS NOT OLD.`kind`
  OR NEW.`amount_cents` IS NOT OLD.`amount_cents`
  OR NEW.`created_by_user_id` IS NOT OLD.`created_by_user_id`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'card invoice adjustment financial identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `card_invoice_adjustments_completed_batch_update`
BEFORE UPDATE ON `card_invoice_adjustments`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `card_import_batches` b
  WHERE b.`household_id` = OLD.`household_id`
    AND b.`id` = OLD.`import_batch_id`
    AND b.`status` = 'completed'
)
BEGIN SELECT RAISE(ABORT, 'completed card import adjustment cannot be changed'); END;
--> statement-breakpoint
CREATE TRIGGER `card_invoice_adjustments_safe_void_update`
BEFORE UPDATE OF `status`,`voided_at` ON `card_invoice_adjustments`
FOR EACH ROW WHEN OLD.`status` = 'active' AND NEW.`status` = 'voided' AND (
  SELECT COALESCE(SUM(p.`amount_cents`), 0)
  FROM `invoice_payments` p
  WHERE p.`household_id` = OLD.`household_id` AND p.`invoice_id` = OLD.`invoice_id`
    AND NOT EXISTS (
      SELECT 1 FROM `invoice_payment_operations` r
      WHERE r.`household_id` = p.`household_id` AND r.`reversed_payment_id` = p.`id` AND r.`kind` = 'reversal'
    )
) > (
  SELECT COALESCE(SUM(s.`amount_cents`), 0)
  FROM `card_installments` s
  WHERE s.`household_id` = OLD.`household_id` AND s.`invoice_id` = OLD.`invoice_id` AND s.`status` <> 'cancelled'
) + (
  SELECT COALESCE(SUM(a.`amount_cents`), 0)
  FROM `card_invoice_adjustments` a
  WHERE a.`household_id` = OLD.`household_id` AND a.`invoice_id` = OLD.`invoice_id`
    AND a.`status` = 'active' AND a.`id` <> OLD.`id`
) BEGIN SELECT RAISE(ABORT, 'card invoice adjustment cannot be voided below active payments'); END;
--> statement-breakpoint
CREATE TRIGGER `card_invoice_adjustments_voided_immutable_update`
BEFORE UPDATE OF `status`,`voided_at` ON `card_invoice_adjustments`
FOR EACH ROW WHEN OLD.`status` = 'voided' AND (
  NEW.`status` IS NOT OLD.`status` OR NEW.`voided_at` IS NOT OLD.`voided_at`
) BEGIN SELECT RAISE(ABORT, 'voided card invoice adjustment cannot be changed'); END;
--> statement-breakpoint
CREATE TRIGGER `card_invoice_adjustments_delete`
BEFORE DELETE ON `card_invoice_adjustments`
FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'card invoice adjustment cannot be deleted'); END;
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
  OR NEW.`initial_reference_month` IS NOT OLD.`initial_reference_month`
  OR NEW.`declared_invoice_total_cents` IS NOT OLD.`declared_invoice_total_cents`
  OR NEW.`opening_balance_cents` IS NOT OLD.`opening_balance_cents`
  OR NEW.`imported_purchase_count` IS NOT OLD.`imported_purchase_count`
  OR NEW.`imported_installment_count` IS NOT OLD.`imported_installment_count`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'card import batch financial identity is immutable'); END;
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
            AND a.`status` = 'active'), 0) = NEW.`declared_invoice_total_cents`
  )
) BEGIN SELECT RAISE(ABORT, 'card import batch cannot complete with inconsistent financial facts'); END;
--> statement-breakpoint
CREATE TRIGGER `card_import_batches_completed_status_update`
BEFORE UPDATE OF `status`,`completed_at`,`voided_at` ON `card_import_batches`
FOR EACH ROW WHEN OLD.`status` = 'completed' AND (
  NEW.`status` IS NOT OLD.`status`
  OR NEW.`completed_at` IS NOT OLD.`completed_at`
  OR NEW.`voided_at` IS NOT OLD.`voided_at`
) BEGIN SELECT RAISE(ABORT, 'completed card import batch cannot be changed'); END;
--> statement-breakpoint
CREATE TRIGGER `card_import_batches_delete`
BEFORE DELETE ON `card_import_batches`
FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'card import batch cannot be deleted'); END;
--> statement-breakpoint

-- Facts imported by a completed onboarding are historical snapshots. They may
-- be assembled while the batch is pending, but become immutable at completion.
CREATE TRIGGER `card_purchases_completed_import_update`
BEFORE UPDATE ON `card_purchases`
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM `card_purchase_import_metadata` m
  INNER JOIN `card_import_batches` b
    ON b.`household_id` = m.`household_id` AND b.`id` = m.`import_batch_id`
  WHERE m.`household_id` = OLD.`household_id` AND m.`purchase_id` = OLD.`id`
    AND b.`status` = 'completed'
)
BEGIN SELECT RAISE(ABORT, 'completed imported card purchase cannot be changed'); END;
--> statement-breakpoint
CREATE TRIGGER `card_purchases_completed_import_delete`
BEFORE DELETE ON `card_purchases`
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM `card_purchase_import_metadata` m
  INNER JOIN `card_import_batches` b
    ON b.`household_id` = m.`household_id` AND b.`id` = m.`import_batch_id`
  WHERE m.`household_id` = OLD.`household_id` AND m.`purchase_id` = OLD.`id`
    AND b.`status` = 'completed'
)
BEGIN SELECT RAISE(ABORT, 'completed imported card purchase cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER `card_installments_completed_import_insert`
BEFORE INSERT ON `card_installments`
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM `card_purchase_import_metadata` m
  INNER JOIN `card_import_batches` b
    ON b.`household_id` = m.`household_id` AND b.`id` = m.`import_batch_id`
  WHERE m.`household_id` = NEW.`household_id` AND m.`purchase_id` = NEW.`purchase_id`
    AND b.`status` = 'completed'
)
BEGIN SELECT RAISE(ABORT, 'completed imported card installment cannot be added'); END;
--> statement-breakpoint
CREATE TRIGGER `card_installments_completed_import_update`
BEFORE UPDATE ON `card_installments`
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM `card_purchase_import_metadata` m
  INNER JOIN `card_import_batches` b
    ON b.`household_id` = m.`household_id` AND b.`id` = m.`import_batch_id`
  WHERE m.`household_id` = OLD.`household_id` AND m.`purchase_id` = OLD.`purchase_id`
    AND b.`status` = 'completed'
)
BEGIN SELECT RAISE(ABORT, 'completed imported card installment cannot be changed'); END;
--> statement-breakpoint
CREATE TRIGGER `card_installments_completed_import_delete`
BEFORE DELETE ON `card_installments`
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM `card_purchase_import_metadata` m
  INNER JOIN `card_import_batches` b
    ON b.`household_id` = m.`household_id` AND b.`id` = m.`import_batch_id`
  WHERE m.`household_id` = OLD.`household_id` AND m.`purchase_id` = OLD.`purchase_id`
    AND b.`status` = 'completed'
)
BEGIN SELECT RAISE(ABORT, 'completed imported card installment cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER `card_installments_card_match_insert`
BEFORE INSERT ON `card_installments`
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM `card_purchases` p
  INNER JOIN `card_invoices` i
    ON i.`household_id` = p.`household_id` AND i.`id` = NEW.`invoice_id`
  WHERE p.`household_id` = NEW.`household_id` AND p.`id` = NEW.`purchase_id`
    AND p.`card_id` = i.`card_id`
) BEGIN SELECT RAISE(ABORT, 'card installment purchase and invoice must belong to the same card'); END;
--> statement-breakpoint
CREATE TRIGGER `card_installments_card_match_update`
BEFORE UPDATE OF `household_id`,`purchase_id`,`invoice_id` ON `card_installments`
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM `card_purchases` p
  INNER JOIN `card_invoices` i
    ON i.`household_id` = p.`household_id` AND i.`id` = NEW.`invoice_id`
  WHERE p.`household_id` = NEW.`household_id` AND p.`id` = NEW.`purchase_id`
    AND p.`card_id` = i.`card_id`
) BEGIN SELECT RAISE(ABORT, 'card installment purchase and invoice must belong to the same card'); END;
--> statement-breakpoint
CREATE TRIGGER `card_purchases_card_match_update`
BEFORE UPDATE OF `id`,`household_id`,`card_id` ON `card_purchases`
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM `card_installments` s
  INNER JOIN `card_invoices` i
    ON i.`household_id` = s.`household_id` AND i.`id` = s.`invoice_id`
  WHERE s.`household_id` = OLD.`household_id` AND s.`purchase_id` = OLD.`id`
    AND (i.`household_id` IS NOT NEW.`household_id` OR i.`card_id` IS NOT NEW.`card_id`)
) BEGIN SELECT RAISE(ABORT, 'card purchase cannot move away from installment invoices'); END;
--> statement-breakpoint
CREATE TRIGGER `card_invoices_card_match_update`
BEFORE UPDATE OF `id`,`household_id`,`card_id` ON `card_invoices`
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM `card_installments` s
  INNER JOIN `card_purchases` p
    ON p.`household_id` = s.`household_id` AND p.`id` = s.`purchase_id`
  WHERE s.`household_id` = OLD.`household_id` AND s.`invoice_id` = OLD.`id`
    AND (p.`household_id` IS NOT NEW.`household_id` OR p.`card_id` IS NOT NEW.`card_id`)
) BEGIN SELECT RAISE(ABORT, 'card invoice cannot move away from installment purchases'); END;
--> statement-breakpoint
CREATE TRIGGER `card_invoices_completed_import_cycle_update`
BEFORE UPDATE OF `id`,`household_id`,`card_id`,`reference_month`,`due_date` ON `card_invoices`
FOR EACH ROW WHEN (
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`household_id` IS NOT OLD.`household_id`
  OR NEW.`card_id` IS NOT OLD.`card_id`
  OR NEW.`reference_month` IS NOT OLD.`reference_month`
  OR NEW.`due_date` IS NOT OLD.`due_date`
) AND (
  EXISTS (
    SELECT 1
    FROM `card_installments` s
    INNER JOIN `card_purchase_import_metadata` m
      ON m.`household_id` = s.`household_id` AND m.`purchase_id` = s.`purchase_id`
    INNER JOIN `card_import_batches` b
      ON b.`household_id` = m.`household_id` AND b.`id` = m.`import_batch_id`
    WHERE s.`household_id` = OLD.`household_id` AND s.`invoice_id` = OLD.`id`
      AND b.`status` = 'completed'
  )
  OR EXISTS (
    SELECT 1
    FROM `card_invoice_adjustments` a
    INNER JOIN `card_import_batches` b
      ON b.`household_id` = a.`household_id` AND b.`id` = a.`import_batch_id`
    WHERE a.`household_id` = OLD.`household_id` AND a.`invoice_id` = OLD.`id`
      AND b.`status` = 'completed'
  )
)
BEGIN SELECT RAISE(ABORT, 'completed imported card invoice cycle cannot be changed'); END;
--> statement-breakpoint
PRAGMA optimize;

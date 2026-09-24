CREATE TABLE `expected_income_series` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `description` text NOT NULL,
  `expected_amount_cents` integer NOT NULL,
  `recurrence` text DEFAULT 'monthly' NOT NULL,
  `configured_day` integer NOT NULL,
  `starts_on` text NOT NULL,
  `ends_on` text,
  `planned_account_id` text,
  `category_id` text,
  `subcategory_id` text,
  `notes` text,
  `is_active` integer DEFAULT 1 NOT NULL,
  `materialized_through_month` text NOT NULL,
  `last_operation_id` text NOT NULL,
  `created_by_user_id` text NOT NULL,
  `origin` text DEFAULT 'web' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `expected_income_series_description_check`
    CHECK (length(trim(`description`)) BETWEEN 1 AND 120),
  CONSTRAINT `expected_income_series_amount_check`
    CHECK (`expected_amount_cents` BETWEEN 1 AND 100000000000),
  CONSTRAINT `expected_income_series_recurrence_check`
    CHECK (`recurrence` = 'monthly'),
  CONSTRAINT `expected_income_series_day_check`
    CHECK (`configured_day` BETWEEN 1 AND 31),
  CONSTRAINT `expected_income_series_starts_on_check`
    CHECK (length(`starts_on`) = 10
      AND `starts_on` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND `starts_on` >= '0001-01-01'
      AND date(`starts_on`, '+0 days') IS NOT NULL
      AND date(`starts_on`, '+0 days') = `starts_on`),
  CONSTRAINT `expected_income_series_effective_day_check`
    CHECK (CAST(substr(`starts_on`, 9, 2) AS integer) =
      CASE
        WHEN `configured_day` <= CAST(strftime('%d', date(substr(`starts_on`, 1, 7) || '-01', '+1 month', '-1 day')) AS integer)
          THEN `configured_day`
        ELSE CAST(strftime('%d', date(substr(`starts_on`, 1, 7) || '-01', '+1 month', '-1 day')) AS integer)
      END),
  CONSTRAINT `expected_income_series_ends_on_check`
    CHECK (`ends_on` IS NULL OR (
      length(`ends_on`) = 10
      AND `ends_on` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(`ends_on`, '+0 days') IS NOT NULL
      AND date(`ends_on`, '+0 days') = `ends_on`
      AND `ends_on` >= `starts_on`)),
  CONSTRAINT `expected_income_series_month_check`
    CHECK (length(`materialized_through_month`) = 7
      AND `materialized_through_month` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND date(`materialized_through_month` || '-01', '+0 days') = `materialized_through_month` || '-01'
      AND `materialized_through_month` >= substr(`starts_on`, 1, 7)
      AND (`ends_on` IS NULL OR `materialized_through_month` <= substr(`ends_on`, 1, 7))),
  CONSTRAINT `expected_income_series_notes_check`
    CHECK (`notes` IS NULL OR length(`notes`) <= 500),
  CONSTRAINT `expected_income_series_active_check`
    CHECK (`is_active` IN (0,1)),
  CONSTRAINT `expected_income_series_origin_check`
    CHECK (`origin` IN ('web','telegram','system')),
  UNIQUE (`household_id`,`id`),
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`planned_account_id`) REFERENCES `accounts`(`household_id`,`id`),
  FOREIGN KEY (`household_id`,`category_id`) REFERENCES `categories`(`household_id`,`id`),
  FOREIGN KEY (`subcategory_id`) REFERENCES `subcategories`(`id`),
  FOREIGN KEY (`household_id`,`created_by_user_id`) REFERENCES `household_members`(`household_id`,`user_id`)
);
--> statement-breakpoint

CREATE INDEX `idx_expected_income_series_household_active`
  ON `expected_income_series` (`household_id`,`is_active`,`materialized_through_month`);
--> statement-breakpoint

CREATE TABLE `expected_income_occurrences` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `series_id` text,
  `occurrence_month` text,
  `description` text NOT NULL,
  `expected_amount_cents` integer NOT NULL,
  `expected_date` text NOT NULL,
  `planned_account_id` text,
  `category_id` text,
  `subcategory_id` text,
  `notes` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `received_transaction_id` text,
  `received_at` text,
  `cancelled_at` text,
  `last_operation_id` text NOT NULL,
  `created_by_user_id` text NOT NULL,
  `origin` text DEFAULT 'web' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `expected_income_occurrences_description_check`
    CHECK (length(trim(`description`)) BETWEEN 1 AND 120),
  CONSTRAINT `expected_income_occurrences_amount_check`
    CHECK (`expected_amount_cents` BETWEEN 1 AND 100000000000),
  CONSTRAINT `expected_income_occurrences_date_check`
    CHECK (length(`expected_date`) = 10
      AND `expected_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND `expected_date` >= '0001-01-01'
      AND date(`expected_date`, '+0 days') IS NOT NULL
      AND date(`expected_date`, '+0 days') = `expected_date`),
  CONSTRAINT `expected_income_occurrences_series_check`
    CHECK ((`series_id` IS NULL AND `occurrence_month` IS NULL)
      OR (`series_id` IS NOT NULL
        AND length(`occurrence_month`) = 7
        AND `occurrence_month` = substr(`expected_date`, 1, 7))),
  CONSTRAINT `expected_income_occurrences_notes_check`
    CHECK (`notes` IS NULL OR length(`notes`) <= 500),
  CONSTRAINT `expected_income_occurrences_status_check`
    CHECK (`status` IN ('pending','received','cancelled')),
  CONSTRAINT `expected_income_occurrences_lifecycle_check`
    CHECK ((`status` = 'pending' AND `received_transaction_id` IS NULL AND `received_at` IS NULL AND `cancelled_at` IS NULL)
      OR (`status` = 'received' AND `received_transaction_id` IS NOT NULL AND `received_at` IS NOT NULL AND `cancelled_at` IS NULL)
      OR (`status` = 'cancelled' AND `received_transaction_id` IS NULL AND `received_at` IS NULL AND `cancelled_at` IS NOT NULL)),
  CONSTRAINT `expected_income_occurrences_origin_check`
    CHECK (`origin` IN ('web','telegram','system')),
  UNIQUE (`household_id`,`id`),
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`series_id`) REFERENCES `expected_income_series`(`household_id`,`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`planned_account_id`) REFERENCES `accounts`(`household_id`,`id`),
  FOREIGN KEY (`household_id`,`category_id`) REFERENCES `categories`(`household_id`,`id`),
  FOREIGN KEY (`subcategory_id`) REFERENCES `subcategories`(`id`),
  FOREIGN KEY (`household_id`,`received_transaction_id`) REFERENCES `transactions`(`household_id`,`id`),
  FOREIGN KEY (`household_id`,`created_by_user_id`) REFERENCES `household_members`(`household_id`,`user_id`)
);
--> statement-breakpoint

CREATE UNIQUE INDEX `expected_income_occurrences_series_month_unique`
  ON `expected_income_occurrences` (`household_id`,`series_id`,`occurrence_month`)
  WHERE `series_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `expected_income_occurrences_transaction_unique`
  ON `expected_income_occurrences` (`household_id`,`received_transaction_id`)
  WHERE `received_transaction_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_expected_income_occurrences_household_status_date`
  ON `expected_income_occurrences` (`household_id`,`status`,`expected_date`);
--> statement-breakpoint
CREATE INDEX `idx_expected_income_occurrences_household_series`
  ON `expected_income_occurrences` (`household_id`,`series_id`);
--> statement-breakpoint
CREATE INDEX `idx_expected_income_occurrences_household_account`
  ON `expected_income_occurrences` (`household_id`,`planned_account_id`);
--> statement-breakpoint

CREATE TABLE `expected_income_operations` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `operation_type` text NOT NULL,
  `series_id` text,
  `occurrence_id` text,
  `transaction_id` text,
  `performed_by_user_id` text NOT NULL,
  `financial_date` text,
  `created_at` text NOT NULL,
  CONSTRAINT `expected_income_operations_key_check`
    CHECK (length(trim(`idempotency_key`)) BETWEEN 1 AND 200),
  CONSTRAINT `expected_income_operations_hash_check`
    CHECK (length(`request_hash`) = 64 AND `request_hash` NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT `expected_income_operations_type_check`
    CHECK (`operation_type` IN ('create_occurrence','create_series','materialize','receive','cancel','reverse','update_occurrence')),
  CONSTRAINT `expected_income_operations_shape_check`
    CHECK ((`operation_type` IN ('create_series','materialize') AND `series_id` IS NOT NULL AND `occurrence_id` IS NULL AND `transaction_id` IS NULL)
      OR (`operation_type` IN ('create_occurrence','update_occurrence','cancel') AND `series_id` IS NULL AND `occurrence_id` IS NOT NULL AND `transaction_id` IS NULL)
      OR (`operation_type` IN ('receive','reverse') AND `series_id` IS NULL AND `occurrence_id` IS NOT NULL AND `transaction_id` IS NOT NULL AND `financial_date` IS NOT NULL)),
  CONSTRAINT `expected_income_operations_date_check`
    CHECK (`financial_date` IS NULL OR (
      length(`financial_date`) = 10
      AND `financial_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND `financial_date` >= '0001-01-01'
      AND date(`financial_date`, '+0 days') IS NOT NULL
      AND date(`financial_date`, '+0 days') = `financial_date`)),
  UNIQUE (`household_id`,`id`),
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`performed_by_user_id`) REFERENCES `household_members`(`household_id`,`user_id`),
  FOREIGN KEY (`household_id`,`transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON DELETE cascade
);
--> statement-breakpoint

CREATE UNIQUE INDEX `expected_income_operations_household_key_unique`
  ON `expected_income_operations` (`household_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_expected_income_operations_household_occurrence`
  ON `expected_income_operations` (`household_id`,`occurrence_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_expected_income_operations_household_series`
  ON `expected_income_operations` (`household_id`,`series_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_expected_income_operations_household_transaction`
  ON `expected_income_operations` (`household_id`,`transaction_id`,`operation_type`);
--> statement-breakpoint
CREATE UNIQUE INDEX `expected_income_operations_reverse_transaction_unique`
  ON `expected_income_operations` (`household_id`,`transaction_id`)
  WHERE `operation_type` = 'reverse';
--> statement-breakpoint

CREATE TRIGGER `expected_income_operations_insert_guard`
BEFORE INSERT ON `expected_income_operations`
FOR EACH ROW WHEN
  (NEW.`operation_type` = 'materialize' AND NOT EXISTS (
    SELECT 1 FROM `expected_income_series`
    WHERE `id` = NEW.`series_id` AND `household_id` = NEW.`household_id` AND `is_active` = 1
  ))
  OR (NEW.`operation_type` = 'update_occurrence' AND NOT EXISTS (
    SELECT 1 FROM `expected_income_occurrences`
    WHERE `id` = NEW.`occurrence_id` AND `household_id` = NEW.`household_id` AND `status` = 'pending'
  ))
  OR (NEW.`operation_type` = 'cancel' AND NOT EXISTS (
    SELECT 1 FROM `expected_income_occurrences`
    WHERE `id` = NEW.`occurrence_id` AND `household_id` = NEW.`household_id` AND `status` = 'pending'
  ))
  OR (NEW.`operation_type` = 'receive' AND NOT EXISTS (
    SELECT 1
    FROM `expected_income_occurrences` occurrence
    INNER JOIN `transactions` transaction_row
      ON transaction_row.`id` = NEW.`transaction_id`
      AND transaction_row.`household_id` = occurrence.`household_id`
    WHERE occurrence.`id` = NEW.`occurrence_id`
      AND occurrence.`household_id` = NEW.`household_id`
      AND occurrence.`status` = 'pending'
      AND transaction_row.`type` = 'income'
      AND transaction_row.`status` = 'confirmed'
  ))
  OR (NEW.`operation_type` = 'reverse' AND NOT EXISTS (
    SELECT 1
    FROM `expected_income_occurrences` occurrence
    INNER JOIN `transactions` transaction_row
      ON transaction_row.`id` = occurrence.`received_transaction_id`
      AND transaction_row.`household_id` = occurrence.`household_id`
    WHERE occurrence.`id` = NEW.`occurrence_id`
      AND occurrence.`household_id` = NEW.`household_id`
      AND occurrence.`status` = 'received'
      AND occurrence.`received_transaction_id` = NEW.`transaction_id`
      AND transaction_row.`type` = 'income'
      AND transaction_row.`status` = 'confirmed'
      AND NEW.`financial_date` >= transaction_row.`transaction_date`
  ))
BEGIN SELECT RAISE(ABORT, 'invalid expected income operation target'); END;
--> statement-breakpoint

CREATE TRIGGER `expected_income_operations_update_guard`
BEFORE UPDATE ON `expected_income_operations`
FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'expected income operation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `expected_income_operations_delete_guard`
BEFORE DELETE ON `expected_income_operations`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `households` WHERE `id` = OLD.`household_id`
) BEGIN SELECT RAISE(ABORT, 'expected income operation is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `expected_income_series_insert_guard`
BEFORE INSERT ON `expected_income_series`
FOR EACH ROW WHEN
  NOT EXISTS (
    SELECT 1 FROM `expected_income_operations`
    WHERE `household_id` = NEW.`household_id`
      AND `series_id` = NEW.`id`
      AND `operation_type` = 'create_series'
      AND `id` = NEW.`last_operation_id`
  )
  OR (NEW.`planned_account_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `accounts`
    WHERE `id` = NEW.`planned_account_id` AND `household_id` = NEW.`household_id` AND `is_active` = 1
  ))
  OR (NEW.`category_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `categories`
    WHERE `id` = NEW.`category_id` AND `household_id` = NEW.`household_id` AND `is_active` = 1 AND `type` IN ('income','both')
  ))
  OR (NEW.`category_id` IS NULL AND NEW.`subcategory_id` IS NOT NULL)
  OR (NEW.`subcategory_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `subcategories`
    WHERE `id` = NEW.`subcategory_id`
      AND `household_id` = NEW.`household_id`
      AND `category_id` = NEW.`category_id`
      AND `is_active` = 1
  ))
BEGIN SELECT RAISE(ABORT, 'invalid expected income series'); END;
--> statement-breakpoint

CREATE TRIGGER `expected_income_series_update_guard`
BEFORE UPDATE ON `expected_income_series`
FOR EACH ROW WHEN
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`household_id` IS NOT OLD.`household_id`
  OR NEW.`description` IS NOT OLD.`description`
  OR NEW.`expected_amount_cents` IS NOT OLD.`expected_amount_cents`
  OR NEW.`recurrence` IS NOT OLD.`recurrence`
  OR NEW.`configured_day` IS NOT OLD.`configured_day`
  OR NEW.`starts_on` IS NOT OLD.`starts_on`
  OR NEW.`ends_on` IS NOT OLD.`ends_on`
  OR NEW.`planned_account_id` IS NOT OLD.`planned_account_id`
  OR NEW.`category_id` IS NOT OLD.`category_id`
  OR NEW.`subcategory_id` IS NOT OLD.`subcategory_id`
  OR NEW.`notes` IS NOT OLD.`notes`
  OR NEW.`is_active` IS NOT OLD.`is_active`
  OR NEW.`created_by_user_id` IS NOT OLD.`created_by_user_id`
  OR NEW.`origin` IS NOT OLD.`origin`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'expected income series contract is immutable in B1'); END;
--> statement-breakpoint

CREATE TRIGGER `expected_income_series_cursor_guard`
BEFORE UPDATE OF `materialized_through_month` ON `expected_income_series`
FOR EACH ROW WHEN
  NEW.`materialized_through_month` <= OLD.`materialized_through_month`
  OR NOT EXISTS (
    SELECT 1 FROM `expected_income_operations`
    WHERE `household_id` = OLD.`household_id`
      AND `series_id` = OLD.`id`
      AND `operation_type` = 'materialize'
      AND `id` = NEW.`last_operation_id`
      AND substr(`financial_date`, 1, 7) = NEW.`materialized_through_month`
  )
BEGIN SELECT RAISE(ABORT, 'invalid expected income materialization cursor'); END;
--> statement-breakpoint

CREATE TRIGGER `expected_income_occurrences_insert_guard`
BEFORE INSERT ON `expected_income_occurrences`
FOR EACH ROW WHEN
  NEW.`status` <> 'pending'
  OR NEW.`received_transaction_id` IS NOT NULL
  OR NEW.`received_at` IS NOT NULL
  OR NEW.`cancelled_at` IS NOT NULL
  OR (NEW.`series_id` IS NULL AND NOT EXISTS (
    SELECT 1 FROM `expected_income_operations`
    WHERE `household_id` = NEW.`household_id`
      AND `occurrence_id` = NEW.`id`
      AND `operation_type` = 'create_occurrence'
      AND `id` = NEW.`last_operation_id`
  ))
  OR (NEW.`series_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `expected_income_operations`
    WHERE `household_id` = NEW.`household_id`
      AND `series_id` = NEW.`series_id`
      AND `operation_type` IN ('create_series','materialize')
      AND `id` = NEW.`last_operation_id`
  ))
  OR (NEW.`series_id` IS NULL AND NEW.`planned_account_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `accounts`
    WHERE `id` = NEW.`planned_account_id` AND `household_id` = NEW.`household_id` AND `is_active` = 1
  ))
  OR (NEW.`series_id` IS NULL AND NEW.`category_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `categories`
    WHERE `id` = NEW.`category_id` AND `household_id` = NEW.`household_id` AND `is_active` = 1 AND `type` IN ('income','both')
  ))
  OR (NEW.`series_id` IS NULL AND NEW.`category_id` IS NULL AND NEW.`subcategory_id` IS NOT NULL)
  OR (NEW.`series_id` IS NULL AND NEW.`subcategory_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `subcategories`
    WHERE `id` = NEW.`subcategory_id`
      AND `household_id` = NEW.`household_id`
      AND `category_id` = NEW.`category_id`
      AND `is_active` = 1
  ))
  OR (NEW.`series_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `expected_income_series` series
    WHERE series.`id` = NEW.`series_id`
      AND series.`household_id` = NEW.`household_id`
      AND series.`description` = NEW.`description`
      AND series.`expected_amount_cents` = NEW.`expected_amount_cents`
      AND series.`planned_account_id` IS NEW.`planned_account_id`
      AND series.`category_id` IS NEW.`category_id`
      AND series.`subcategory_id` IS NEW.`subcategory_id`
      AND series.`notes` IS NEW.`notes`
      AND NEW.`expected_date` >= series.`starts_on`
      AND (series.`ends_on` IS NULL OR NEW.`expected_date` <= series.`ends_on`)
      AND NEW.`expected_date` = NEW.`occurrence_month` || '-' || printf('%02d',
        CASE
          WHEN series.`configured_day` <= CAST(strftime('%d', date(NEW.`occurrence_month` || '-01', '+1 month', '-1 day')) AS integer)
            THEN series.`configured_day`
          ELSE CAST(strftime('%d', date(NEW.`occurrence_month` || '-01', '+1 month', '-1 day')) AS integer)
        END)
  ))
BEGIN SELECT RAISE(ABORT, 'invalid expected income occurrence'); END;
--> statement-breakpoint

CREATE TRIGGER `expected_income_occurrences_identity_guard`
BEFORE UPDATE ON `expected_income_occurrences`
FOR EACH ROW WHEN
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`household_id` IS NOT OLD.`household_id`
  OR NEW.`series_id` IS NOT OLD.`series_id`
  OR NEW.`occurrence_month` IS NOT OLD.`occurrence_month`
  OR NEW.`created_by_user_id` IS NOT OLD.`created_by_user_id`
  OR NEW.`origin` IS NOT OLD.`origin`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'expected income occurrence identity is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `expected_income_occurrences_financial_update_guard`
BEFORE UPDATE ON `expected_income_occurrences`
FOR EACH ROW WHEN (
  NEW.`description` IS NOT OLD.`description`
  OR NEW.`expected_amount_cents` IS NOT OLD.`expected_amount_cents`
  OR NEW.`expected_date` IS NOT OLD.`expected_date`
  OR NEW.`planned_account_id` IS NOT OLD.`planned_account_id`
  OR NEW.`category_id` IS NOT OLD.`category_id`
  OR NEW.`subcategory_id` IS NOT OLD.`subcategory_id`
  OR NEW.`notes` IS NOT OLD.`notes`
) AND (
  OLD.`status` <> 'pending'
  OR NEW.`status` <> 'pending'
  OR NOT EXISTS (
    SELECT 1 FROM `expected_income_operations`
    WHERE `household_id` = OLD.`household_id`
      AND `occurrence_id` = OLD.`id`
      AND `operation_type` = 'update_occurrence'
      AND `id` = NEW.`last_operation_id`
  )
  OR (NEW.`planned_account_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `accounts`
    WHERE `id` = NEW.`planned_account_id` AND `household_id` = NEW.`household_id` AND `is_active` = 1
  ))
  OR (NEW.`category_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `categories`
    WHERE `id` = NEW.`category_id` AND `household_id` = NEW.`household_id` AND `is_active` = 1 AND `type` IN ('income','both')
  ))
  OR (NEW.`category_id` IS NULL AND NEW.`subcategory_id` IS NOT NULL)
  OR (NEW.`subcategory_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `subcategories`
    WHERE `id` = NEW.`subcategory_id`
      AND `household_id` = NEW.`household_id`
      AND `category_id` = NEW.`category_id`
      AND `is_active` = 1
  ))
)
BEGIN SELECT RAISE(ABORT, 'invalid expected income occurrence edit'); END;
--> statement-breakpoint

CREATE TRIGGER `expected_income_occurrences_lifecycle_guard`
BEFORE UPDATE ON `expected_income_occurrences`
FOR EACH ROW WHEN (
  NEW.`status` IS NOT OLD.`status`
  OR NEW.`received_transaction_id` IS NOT OLD.`received_transaction_id`
  OR NEW.`received_at` IS NOT OLD.`received_at`
  OR NEW.`cancelled_at` IS NOT OLD.`cancelled_at`
) AND NOT (
  (OLD.`status` = 'pending' AND NEW.`status` = 'received'
    AND EXISTS (
      SELECT 1 FROM `expected_income_operations`
      WHERE `household_id` = OLD.`household_id`
        AND `occurrence_id` = OLD.`id`
        AND `transaction_id` = NEW.`received_transaction_id`
        AND `operation_type` = 'receive'
        AND `id` = NEW.`last_operation_id`
    ))
  OR (OLD.`status` = 'pending' AND NEW.`status` = 'cancelled'
    AND EXISTS (
      SELECT 1 FROM `expected_income_operations`
      WHERE `household_id` = OLD.`household_id`
        AND `occurrence_id` = OLD.`id`
        AND `operation_type` = 'cancel'
        AND `id` = NEW.`last_operation_id`
    ))
  OR (OLD.`status` = 'received' AND NEW.`status` = 'pending'
    AND EXISTS (
      SELECT 1 FROM `expected_income_operations`
      WHERE `household_id` = OLD.`household_id`
        AND `occurrence_id` = OLD.`id`
        AND `transaction_id` = OLD.`received_transaction_id`
        AND `operation_type` = 'reverse'
        AND `id` = NEW.`last_operation_id`
    ))
)
BEGIN SELECT RAISE(ABORT, 'invalid expected income lifecycle transition'); END;
--> statement-breakpoint

CREATE TRIGGER `expected_income_linked_transaction_update_guard`
BEFORE UPDATE ON `transactions`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `expected_income_operations`
  WHERE `household_id` = OLD.`household_id`
    AND `transaction_id` = OLD.`id`
)
BEGIN SELECT RAISE(ABORT, 'expected income transaction must be managed by its occurrence'); END;
--> statement-breakpoint

CREATE TRIGGER `expected_income_linked_transaction_delete_guard`
BEFORE DELETE ON `transactions`
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM `households` WHERE `id` = OLD.`household_id`)
AND EXISTS (
  SELECT 1 FROM `expected_income_operations`
  WHERE `household_id` = OLD.`household_id`
    AND `transaction_id` = OLD.`id`
)
BEGIN SELECT RAISE(ABORT, 'expected income transaction must be managed by its occurrence'); END;
--> statement-breakpoint

PRAGMA optimize;

CREATE UNIQUE INDEX `bills_household_id_unique`
  ON `bills` (`household_id`,`id`);
--> statement-breakpoint

CREATE TABLE `bill_installment_series` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `description` text NOT NULL,
  `total_amount_cents` integer NOT NULL,
  `installment_count` integer NOT NULL,
  `first_due_date` text NOT NULL,
  `configured_day` integer NOT NULL,
  `category_id` text NOT NULL,
  `subcategory_id` text,
  `account_id` text,
  `notes` text,
  `idempotency_key` text NOT NULL,
  `request_fingerprint` text NOT NULL,
  `created_by_user_id` text NOT NULL,
  `origin` text DEFAULT 'web' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `bill_installment_series_description_check`
    CHECK (length(trim(`description`)) BETWEEN 1 AND 120),
  CONSTRAINT `bill_installment_series_total_check`
    CHECK (`total_amount_cents` > 0 AND `total_amount_cents` >= `installment_count`),
  CONSTRAINT `bill_installment_series_count_check`
    CHECK (`installment_count` BETWEEN 2 AND 120),
  CONSTRAINT `bill_installment_series_date_check`
    CHECK (length(`first_due_date`) = 10
      AND `first_due_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND `first_due_date` >= '0001-01-01'
      AND date(`first_due_date`, '+0 days') IS NOT NULL
      AND date(`first_due_date`, '+0 days') = `first_due_date`),
  CONSTRAINT `bill_installment_series_day_check`
    CHECK (`configured_day` BETWEEN 1 AND 31
      AND `configured_day` = CAST(substr(`first_due_date`, 9, 2) AS integer)),
  CONSTRAINT `bill_installment_series_notes_check`
    CHECK (`notes` IS NULL OR length(`notes`) <= 500),
  CONSTRAINT `bill_installment_series_idempotency_check`
    CHECK (length(trim(`idempotency_key`)) BETWEEN 1 AND 200),
  CONSTRAINT `bill_installment_series_fingerprint_check`
    CHECK (length(`request_fingerprint`) = 64
      AND `request_fingerprint` NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT `bill_installment_series_origin_check`
    CHECK (`origin` IN ('web','telegram','system')),
  UNIQUE (`household_id`,`id`),
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`category_id`) REFERENCES `categories`(`household_id`,`id`),
  FOREIGN KEY (`subcategory_id`) REFERENCES `subcategories`(`id`),
  FOREIGN KEY (`household_id`,`account_id`) REFERENCES `accounts`(`household_id`,`id`),
  FOREIGN KEY (`household_id`,`created_by_user_id`) REFERENCES `household_members`(`household_id`,`user_id`)
);
--> statement-breakpoint

CREATE UNIQUE INDEX `bill_installment_series_household_key_unique`
  ON `bill_installment_series` (`household_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_bill_installment_series_household_created`
  ON `bill_installment_series` (`household_id`,`created_at`);
--> statement-breakpoint

CREATE TABLE `bill_installment_occurrences` (
  `household_id` text NOT NULL,
  `series_id` text NOT NULL,
  `bill_id` text NOT NULL,
  `installment_number` integer NOT NULL,
  `created_at` text NOT NULL,
  CONSTRAINT `bill_installment_occurrences_number_check`
    CHECK (`installment_number` >= 1),
  PRIMARY KEY (`household_id`,`series_id`,`installment_number`),
  UNIQUE (`bill_id`),
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`series_id`) REFERENCES `bill_installment_series`(`household_id`,`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`bill_id`) REFERENCES `bills`(`household_id`,`id`) ON DELETE cascade
);
--> statement-breakpoint

CREATE INDEX `idx_bill_installment_occurrences_household_bill`
  ON `bill_installment_occurrences` (`household_id`,`bill_id`);
--> statement-breakpoint

CREATE TRIGGER `bill_installment_series_subcategory_insert`
BEFORE INSERT ON `bill_installment_series`
FOR EACH ROW WHEN NEW.`subcategory_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `subcategories`
  WHERE `id` = NEW.`subcategory_id`
    AND `household_id` = NEW.`household_id`
    AND `category_id` = NEW.`category_id`
    AND `is_active` = 1
) BEGIN SELECT RAISE(ABORT, 'bill installment subcategory does not belong to household and category'); END;
--> statement-breakpoint

CREATE TRIGGER `bill_installment_series_identity_update`
BEFORE UPDATE ON `bill_installment_series`
FOR EACH ROW WHEN
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`household_id` IS NOT OLD.`household_id`
  OR NEW.`description` IS NOT OLD.`description`
  OR NEW.`total_amount_cents` IS NOT OLD.`total_amount_cents`
  OR NEW.`installment_count` IS NOT OLD.`installment_count`
  OR NEW.`first_due_date` IS NOT OLD.`first_due_date`
  OR NEW.`configured_day` IS NOT OLD.`configured_day`
  OR NEW.`category_id` IS NOT OLD.`category_id`
  OR NEW.`subcategory_id` IS NOT OLD.`subcategory_id`
  OR NEW.`account_id` IS NOT OLD.`account_id`
  OR NEW.`notes` IS NOT OLD.`notes`
  OR NEW.`idempotency_key` IS NOT OLD.`idempotency_key`
  OR NEW.`request_fingerprint` IS NOT OLD.`request_fingerprint`
  OR NEW.`created_by_user_id` IS NOT OLD.`created_by_user_id`
  OR NEW.`origin` IS NOT OLD.`origin`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'bill installment series contract is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `bill_installment_occurrences_insert_guard`
BEFORE INSERT ON `bill_installment_occurrences`
FOR EACH ROW WHEN
  NOT EXISTS (
    SELECT 1 FROM `bill_installment_series` series
    WHERE series.`id` = NEW.`series_id`
      AND series.`household_id` = NEW.`household_id`
      AND NEW.`installment_number` <= series.`installment_count`
  )
  OR NOT EXISTS (
    SELECT 1 FROM `bills` bill
    WHERE bill.`id` = NEW.`bill_id`
      AND bill.`household_id` = NEW.`household_id`
      AND bill.`recurrence` = 'none'
      AND bill.`recurrence_series_id` IS NULL
      AND bill.`recurrence_end_date` IS NULL
  )
BEGIN SELECT RAISE(ABORT, 'invalid bill installment occurrence'); END;
--> statement-breakpoint

CREATE TRIGGER `bill_installment_occurrences_identity_update`
BEFORE UPDATE ON `bill_installment_occurrences`
FOR EACH ROW WHEN
  NEW.`household_id` IS NOT OLD.`household_id`
  OR NEW.`series_id` IS NOT OLD.`series_id`
  OR NEW.`bill_id` IS NOT OLD.`bill_id`
  OR NEW.`installment_number` IS NOT OLD.`installment_number`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'bill installment occurrence is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `bill_installment_bill_recurrence_update`
BEFORE UPDATE OF `household_id`,`recurrence`,`recurrence_series_id`,`recurrence_end_date` ON `bills`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `bill_installment_occurrences` occurrence
  WHERE occurrence.`bill_id` = OLD.`id`
) AND (
  NEW.`household_id` IS NOT OLD.`household_id`
  OR NEW.`recurrence` <> 'none'
  OR NEW.`recurrence_series_id` IS NOT NULL
  OR NEW.`recurrence_end_date` IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'installment bill must remain non-recurring'); END;
--> statement-breakpoint

PRAGMA optimize;

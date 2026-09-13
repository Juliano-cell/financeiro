ALTER TABLE `bills` ADD COLUMN `subcategory_id` text REFERENCES `subcategories`(`id`);
--> statement-breakpoint
ALTER TABLE `recurring_bill_series` ADD COLUMN `subcategory_id` text REFERENCES `subcategories`(`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `subcategories_household_category_name_unique` ON `subcategories` (`household_id`,`category_id`,`name` COLLATE NOCASE);
--> statement-breakpoint
CREATE UNIQUE INDEX `bills_payment_transaction_unique` ON `bills` (`payment_transaction_id`);
--> statement-breakpoint
CREATE INDEX `idx_bills_household_subcategory_status` ON `bills` (`household_id`,`subcategory_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_recurring_bill_series_household_subcategory` ON `recurring_bill_series` (`household_id`,`subcategory_id`);
--> statement-breakpoint
CREATE TRIGGER `subcategories_household_category_insert` BEFORE INSERT ON `subcategories` FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM `categories` WHERE `id` = NEW.`category_id` AND `household_id` = NEW.`household_id`) BEGIN SELECT RAISE(ABORT, 'subcategory category belongs to another household'); END;
--> statement-breakpoint
CREATE TRIGGER `subcategories_household_category_update` BEFORE UPDATE OF `household_id`,`category_id` ON `subcategories` FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM `categories` WHERE `id` = NEW.`category_id` AND `household_id` = NEW.`household_id`) BEGIN SELECT RAISE(ABORT, 'subcategory category belongs to another household'); END;
--> statement-breakpoint
CREATE TRIGGER `bills_household_subcategory_insert` BEFORE INSERT ON `bills` FOR EACH ROW WHEN NEW.`subcategory_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `subcategories` WHERE `id` = NEW.`subcategory_id` AND `household_id` = NEW.`household_id` AND NEW.`category_id` IS NOT NULL AND `category_id` = NEW.`category_id`) BEGIN SELECT RAISE(ABORT, 'bill subcategory does not belong to household and category'); END;
--> statement-breakpoint
CREATE TRIGGER `bills_household_subcategory_update` BEFORE UPDATE OF `household_id`,`category_id`,`subcategory_id` ON `bills` FOR EACH ROW WHEN NEW.`subcategory_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `subcategories` WHERE `id` = NEW.`subcategory_id` AND `household_id` = NEW.`household_id` AND NEW.`category_id` IS NOT NULL AND `category_id` = NEW.`category_id`) BEGIN SELECT RAISE(ABORT, 'bill subcategory does not belong to household and category'); END;
--> statement-breakpoint
CREATE TRIGGER `recurring_bill_series_household_subcategory_insert` BEFORE INSERT ON `recurring_bill_series` FOR EACH ROW WHEN NEW.`subcategory_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `subcategories` WHERE `id` = NEW.`subcategory_id` AND `household_id` = NEW.`household_id` AND NEW.`category_id` IS NOT NULL AND `category_id` = NEW.`category_id`) BEGIN SELECT RAISE(ABORT, 'recurring bill subcategory does not belong to household and category'); END;
--> statement-breakpoint
CREATE TRIGGER `recurring_bill_series_household_subcategory_update` BEFORE UPDATE OF `household_id`,`category_id`,`subcategory_id` ON `recurring_bill_series` FOR EACH ROW WHEN NEW.`subcategory_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `subcategories` WHERE `id` = NEW.`subcategory_id` AND `household_id` = NEW.`household_id` AND NEW.`category_id` IS NOT NULL AND `category_id` = NEW.`category_id`) BEGIN SELECT RAISE(ABORT, 'recurring bill subcategory does not belong to household and category'); END;
--> statement-breakpoint
PRAGMA optimize;

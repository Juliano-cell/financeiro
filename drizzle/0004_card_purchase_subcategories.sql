ALTER TABLE `card_purchases` ADD COLUMN `subcategory_id` text REFERENCES `subcategories`(`id`);
--> statement-breakpoint
CREATE INDEX `idx_card_purchases_household_subcategory` ON `card_purchases` (`household_id`,`subcategory_id`);
--> statement-breakpoint
CREATE TRIGGER `card_purchases_household_subcategory_insert` BEFORE INSERT ON `card_purchases` FOR EACH ROW WHEN NEW.`subcategory_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `subcategories` WHERE `id` = NEW.`subcategory_id` AND `household_id` = NEW.`household_id` AND NEW.`category_id` IS NOT NULL AND `category_id` = NEW.`category_id`) BEGIN SELECT RAISE(ABORT, 'card purchase subcategory does not belong to household and category'); END;
--> statement-breakpoint
CREATE TRIGGER `card_purchases_household_subcategory_update` BEFORE UPDATE OF `household_id`,`category_id`,`subcategory_id` ON `card_purchases` FOR EACH ROW WHEN NEW.`subcategory_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `subcategories` WHERE `id` = NEW.`subcategory_id` AND `household_id` = NEW.`household_id` AND NEW.`category_id` IS NOT NULL AND `category_id` = NEW.`category_id`) BEGIN SELECT RAISE(ABORT, 'card purchase subcategory does not belong to household and category'); END;
--> statement-breakpoint
PRAGMA optimize;

-- Parallel, opt-in notification foundation. The legacy notification tables and
-- delivery route remain untouched until a later controlled migration.
CREATE TABLE `user_notification_preferences` (
  `household_id` text NOT NULL,
  `user_id` text NOT NULL,
  `channel` text NOT NULL,
  `enabled` integer DEFAULT 0 NOT NULL,
  `bill_due_tomorrow` integer DEFAULT 1 NOT NULL,
  `bill_due_today` integer DEFAULT 1 NOT NULL,
  `bill_overdue` integer DEFAULT 1 NOT NULL,
  `upcoming_digest` integer DEFAULT 0 NOT NULL,
  `preferred_local_time` text DEFAULT '09:00' NOT NULL,
  `timezone` text DEFAULT 'America/Sao_Paulo' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`household_id`,`user_id`,`channel`),
  CONSTRAINT `user_notification_preferences_channel_check`
    CHECK (`channel` IN ('telegram','push')),
  CONSTRAINT `user_notification_preferences_flags_check`
    CHECK (`enabled` IN (0,1)
      AND `bill_due_tomorrow` IN (0,1)
      AND `bill_due_today` IN (0,1)
      AND `bill_overdue` IN (0,1)
      AND `upcoming_digest` IN (0,1)),
  CONSTRAINT `user_notification_preferences_time_check`
    CHECK (length(`preferred_local_time`) = 5
      AND `preferred_local_time` GLOB '[0-2][0-9]:[0-5][0-9]'
      AND substr(`preferred_local_time`,1,2) BETWEEN '00' AND '23'),
  CONSTRAINT `user_notification_preferences_timezone_check`
    CHECK (length(trim(`timezone`)) BETWEEN 1 AND 100),
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`user_id`)
    REFERENCES `household_members`(`household_id`,`user_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_user_notification_preferences_user`
  ON `user_notification_preferences` (`user_id`,`household_id`);
CREATE INDEX `idx_user_notification_preferences_enabled_channel`
  ON `user_notification_preferences` (`enabled`,`channel`,`household_id`);
--> statement-breakpoint
CREATE TABLE `notification_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `recipient_user_id` text NOT NULL,
  `channel` text NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `event_type` text NOT NULL,
  `reference_date` text NOT NULL,
  `dedupe_key` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` text,
  `lease_until` text,
  `provider_message_id` text,
  `last_error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `sent_at` text,
  CONSTRAINT `notification_outbox_channel_check`
    CHECK (`channel` IN ('telegram','push')),
  CONSTRAINT `notification_outbox_entity_check`
    CHECK ((`event_type` IN ('bill_due_tomorrow','bill_due_today','bill_overdue') AND `entity_type` = 'bill')
      OR (`event_type` = 'upcoming_digest' AND `entity_type` = 'household')),
  CONSTRAINT `notification_outbox_event_check`
    CHECK (`event_type` IN ('bill_due_tomorrow','bill_due_today','bill_overdue','upcoming_digest')),
  CONSTRAINT `notification_outbox_reference_date_check`
    CHECK (length(`reference_date`) = 10
      AND `reference_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND `reference_date` >= '0001-01-01'
      AND date(`reference_date`, '+0 days') = `reference_date`),
  CONSTRAINT `notification_outbox_status_check`
    CHECK (`status` IN ('pending','processing','sent','failed','uncertain','cancelled')),
  CONSTRAINT `notification_outbox_attempts_check`
    CHECK (typeof(`attempts`) = 'integer' AND `attempts` BETWEEN 0 AND 1000),
  CONSTRAINT `notification_outbox_lease_check`
    CHECK ((`status` = 'processing' AND `lease_until` IS NOT NULL)
      OR (`status` <> 'processing' AND `lease_until` IS NULL)),
  CONSTRAINT `notification_outbox_sent_check`
    CHECK ((`status` = 'sent' AND `sent_at` IS NOT NULL)
      OR (`status` <> 'sent' AND `sent_at` IS NULL)),
  CONSTRAINT `notification_outbox_identifiers_check`
    CHECK (length(trim(`id`)) > 0
      AND length(trim(`household_id`)) > 0
      AND length(trim(`recipient_user_id`)) > 0
      AND length(trim(`entity_id`)) > 0
      AND length(trim(`dedupe_key`)) BETWEEN 1 AND 512),
  CONSTRAINT `notification_outbox_error_check`
    CHECK (`last_error` IS NULL OR length(`last_error`) <= 1000),
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`recipient_user_id`)
    REFERENCES `household_members`(`household_id`,`user_id`),
  FOREIGN KEY (`household_id`,`recipient_user_id`,`channel`)
    REFERENCES `user_notification_preferences`(`household_id`,`user_id`,`channel`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_dedupe_key_unique`
  ON `notification_outbox` (`dedupe_key`);
CREATE UNIQUE INDEX `notification_outbox_logical_event_unique`
  ON `notification_outbox` (`household_id`,`recipient_user_id`,`channel`,`entity_type`,`entity_id`,`event_type`,`reference_date`);
CREATE INDEX `idx_notification_outbox_dispatch`
  ON `notification_outbox` (`status`,`next_attempt_at`,`lease_until`);
CREATE INDEX `idx_notification_outbox_household_recipient`
  ON `notification_outbox` (`household_id`,`recipient_user_id`,`created_at`);
CREATE INDEX `idx_notification_outbox_entity`
  ON `notification_outbox` (`household_id`,`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE TRIGGER `notification_outbox_bill_insert`
BEFORE INSERT ON `notification_outbox`
FOR EACH ROW WHEN NEW.`entity_type` = 'bill' AND NOT EXISTS (
  SELECT 1 FROM `bills` b
  WHERE b.`household_id` = NEW.`household_id` AND b.`id` = NEW.`entity_id`
)
BEGIN SELECT RAISE(ABORT, 'notification bill belongs to another household or does not exist'); END;
--> statement-breakpoint
CREATE TRIGGER `notification_outbox_bill_update`
BEFORE UPDATE OF `household_id`,`entity_type`,`entity_id` ON `notification_outbox`
FOR EACH ROW WHEN NEW.`entity_type` = 'bill' AND NOT EXISTS (
  SELECT 1 FROM `bills` b
  WHERE b.`household_id` = NEW.`household_id` AND b.`id` = NEW.`entity_id`
)
BEGIN SELECT RAISE(ABORT, 'notification bill belongs to another household or does not exist'); END;
--> statement-breakpoint
CREATE TRIGGER `notification_outbox_identity_immutable`
BEFORE UPDATE OF `id`,`household_id`,`recipient_user_id`,`channel`,`entity_type`,`entity_id`,`event_type`,`reference_date`,`dedupe_key`,`created_at`
ON `notification_outbox`
FOR EACH ROW WHEN
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`household_id` IS NOT OLD.`household_id`
  OR NEW.`recipient_user_id` IS NOT OLD.`recipient_user_id`
  OR NEW.`channel` IS NOT OLD.`channel`
  OR NEW.`entity_type` IS NOT OLD.`entity_type`
  OR NEW.`entity_id` IS NOT OLD.`entity_id`
  OR NEW.`event_type` IS NOT OLD.`event_type`
  OR NEW.`reference_date` IS NOT OLD.`reference_date`
  OR NEW.`dedupe_key` IS NOT OLD.`dedupe_key`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'notification outbox identity is immutable'); END;
--> statement-breakpoint
PRAGMA optimize;

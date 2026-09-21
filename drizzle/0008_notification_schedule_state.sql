-- Persistent cursor for the future automatic notification scheduler.
-- This migration deliberately performs no backfill and activates no scheduler.
CREATE TABLE `notification_schedule_state` (
  `household_id` text NOT NULL,
  `user_id` text NOT NULL,
  `channel` text NOT NULL,
  `preferred_local_time` text NOT NULL,
  `timezone` text NOT NULL,
  `preference_updated_at` text NOT NULL,
  `next_run_at` text,
  `scheduled_local_date` text,
  `lease_until` text,
  `lease_token` text,
  `last_completed_local_date` text,
  `last_result` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`household_id`,`user_id`,`channel`),
  CONSTRAINT `notification_schedule_state_channel_check`
    CHECK (`channel` IN ('telegram','push')),
  CONSTRAINT `notification_schedule_state_time_check`
    CHECK (length(`preferred_local_time`) = 5
      AND `preferred_local_time` GLOB '[0-2][0-9]:[0-5][0-9]'
      AND substr(`preferred_local_time`,1,2) BETWEEN '00' AND '23'),
  CONSTRAINT `notification_schedule_state_timezone_check`
    CHECK (length(trim(`timezone`)) BETWEEN 1 AND 100),
  CONSTRAINT `notification_schedule_state_slot_check`
    CHECK ((`next_run_at` IS NULL AND `scheduled_local_date` IS NULL)
      OR (`next_run_at` IS NOT NULL AND `scheduled_local_date` IS NOT NULL)),
  CONSTRAINT `notification_schedule_state_date_check`
    CHECK ((`scheduled_local_date` IS NULL OR (
        length(`scheduled_local_date`) = 10
        AND `scheduled_local_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(`scheduled_local_date`, '+0 days') = `scheduled_local_date`
      )) AND (`last_completed_local_date` IS NULL OR (
        length(`last_completed_local_date`) = 10
        AND `last_completed_local_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(`last_completed_local_date`, '+0 days') = `last_completed_local_date`
      ))),
  CONSTRAINT `notification_schedule_state_utc_check`
    CHECK (length(`preference_updated_at`) = 24
      AND substr(`preference_updated_at`,11,1) = 'T'
      AND substr(`preference_updated_at`,24,1) = 'Z'
      AND julianday(`preference_updated_at`) IS NOT NULL
      AND length(`created_at`) = 24 AND substr(`created_at`,11,1) = 'T'
      AND substr(`created_at`,24,1) = 'Z' AND julianday(`created_at`) IS NOT NULL
      AND length(`updated_at`) = 24 AND substr(`updated_at`,11,1) = 'T'
      AND substr(`updated_at`,24,1) = 'Z' AND julianday(`updated_at`) IS NOT NULL
      AND (`next_run_at` IS NULL OR (
        length(`next_run_at`) = 24 AND substr(`next_run_at`,11,1) = 'T'
        AND substr(`next_run_at`,24,1) = 'Z' AND julianday(`next_run_at`) IS NOT NULL
      )) AND (`lease_until` IS NULL OR (
        length(`lease_until`) = 24 AND substr(`lease_until`,11,1) = 'T'
        AND substr(`lease_until`,24,1) = 'Z' AND julianday(`lease_until`) IS NOT NULL
      ))),
  CONSTRAINT `notification_schedule_state_lease_check`
    CHECK ((`lease_until` IS NULL AND `lease_token` IS NULL)
      OR (`lease_until` IS NOT NULL AND `lease_token` IS NOT NULL
        AND `next_run_at` IS NOT NULL AND length(trim(`lease_token`)) BETWEEN 1 AND 200)),
  CONSTRAINT `notification_schedule_state_result_check`
    CHECK ((`last_completed_local_date` IS NULL AND `last_result` IS NULL)
      OR (`last_completed_local_date` IS NOT NULL AND `last_result` IN ('completed','missed'))),
  FOREIGN KEY (`household_id`,`user_id`,`channel`)
    REFERENCES `user_notification_preferences`(`household_id`,`user_id`,`channel`)
    ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_notification_schedule_state_due`
  ON `notification_schedule_state` (`next_run_at`,`lease_until`)
  WHERE `next_run_at` IS NOT NULL;
CREATE INDEX `idx_notification_schedule_state_lease`
  ON `notification_schedule_state` (`lease_until`,`next_run_at`)
  WHERE `lease_until` IS NOT NULL;
--> statement-breakpoint
PRAGMA optimize;

-- Global operational state for notification transports. No rows are created
-- by this migration; absence means the channel is available and unleased.
CREATE TABLE `notification_transport_state` (
  `channel` text PRIMARY KEY NOT NULL,
  `paused_until` text,
  `lease_until` text,
  `lease_token` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `notification_transport_state_channel_check`
    CHECK (`channel` IN ('telegram','push')),
  CONSTRAINT `notification_transport_state_utc_check`
    CHECK ((`paused_until` IS NULL OR (
        length(`paused_until`) = 24 AND substr(`paused_until`,11,1) = 'T'
        AND substr(`paused_until`,24,1) = 'Z' AND julianday(`paused_until`) IS NOT NULL
      )) AND (`lease_until` IS NULL OR (
        length(`lease_until`) = 24 AND substr(`lease_until`,11,1) = 'T'
        AND substr(`lease_until`,24,1) = 'Z' AND julianday(`lease_until`) IS NOT NULL
      )) AND length(`created_at`) = 24 AND substr(`created_at`,11,1) = 'T'
      AND substr(`created_at`,24,1) = 'Z' AND julianday(`created_at`) IS NOT NULL
      AND length(`updated_at`) = 24 AND substr(`updated_at`,11,1) = 'T'
      AND substr(`updated_at`,24,1) = 'Z' AND julianday(`updated_at`) IS NOT NULL),
  CONSTRAINT `notification_transport_state_lease_check`
    CHECK ((`lease_until` IS NULL AND `lease_token` IS NULL)
      OR (`lease_until` IS NOT NULL AND `lease_token` IS NOT NULL
        AND length(trim(`lease_token`)) BETWEEN 1 AND 200))
);
--> statement-breakpoint
PRAGMA optimize;

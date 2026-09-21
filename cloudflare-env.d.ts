declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    LEGACY_ACCOUNT_CLAIM_SECRET?: string;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
    TELEGRAM_LINK_CODE_SECRET?: string;
    NOTIFICATION_CRON_SECRET?: string;
    NOTIFICATION_PLANNER_ENABLED?: string;
    NOTIFICATION_DISPATCHER_ENABLED?: string;
  }
}

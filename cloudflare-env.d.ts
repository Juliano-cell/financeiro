declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    LEGACY_ACCOUNT_CLAIM_SECRET?: string;
  }
}

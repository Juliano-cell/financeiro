import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";

const LOCAL_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  triggers: { crons: [] },
  vars: {
    NOTIFICATION_PLANNER_ENABLED: "false",
    NOTIFICATION_DISPATCHER_ENABLED: "false",
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "nossa-casa-financas-local",
      database_id: LOCAL_PLACEHOLDER_DATABASE_ID,
    },
  ],
  r2_buckets: [],
};

// Work around vinext#2794 until a release containing its upstream fix is used.
// Installed vinext shims otherwise form circular client chunks that abort hydration.
const vinextShimsSingleChunk = {
  name: "vinext-shims-single-chunk",
  configEnvironment(name) {
    if (name !== "client") return;
    return {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                {
                  name: "vinext-shims",
                  test: /[\\/]node_modules[\\/]vinext[\\/]dist[\\/]shims[\\/]/,
                },
              ],
            },
          },
        },
      },
    };
  },
} satisfies Plugin;

export default defineConfig(async () => {
  // Use Miniflare's local Request.cf placeholder unless fetching is requested.
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.WRANGLER_REGISTRY_PATH ??= ".wrangler/dev-registry";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinextShimsSingleChunk,
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});

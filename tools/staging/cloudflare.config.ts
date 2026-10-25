import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "../../src/index.ts" with { type: "cf-worker" };
export default defineConfig({ worker: {
  name: "azerothsurvivors-release-staging",
  compatibilityDate: "2026-10-25",
  workersDev: true,
  env: {
    DOWNLOADS: bindings.r2({ name: "azerothsurvivors-release-staging" }),
    DOWNLOAD_ANALYTICS: bindings.analyticsEngineDataset({ name: "azerothsurvivors_downloads_staging" }),
    ANALYTICS_SQL: { type: "analytics" },
    ANALYTICS_DATASET: bindings.text("azerothsurvivors_downloads_staging"),
    ADMIN_SETUP_HASH: bindings.secret(),
    LOGIN_LIMITER: bindings.rateLimit({ namespace: "98432", simple: { limit: 10, period: 60 } }),
  },
  entrypoint,
} });

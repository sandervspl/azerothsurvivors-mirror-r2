import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "azerothsurvivors",
    compatibilityDate: "2026-10-25",
    domains: ["azerothsurvivors-mirror.sandervspl.dev"],
    workersDev: true,
    entrypoint,
    env: {
      DOWNLOADS: bindings.r2({ name: "azerothsurvivors-downloads" }),
      DOWNLOAD_ANALYTICS: bindings.analyticsEngineDataset({ name: "azerothsurvivors_downloads" }),
      ANALYTICS_SQL: { type: "analytics" },
      ANALYTICS_DATASET: bindings.text("azerothsurvivors_downloads"),
      ADMIN_SETUP_HASH: bindings.secret(),
      LOGIN_LIMITER: bindings.rateLimit({ namespace: "98431", simple: { limit: 10, period: 60 } }),
    },
  },
});

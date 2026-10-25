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
    },
  },
});

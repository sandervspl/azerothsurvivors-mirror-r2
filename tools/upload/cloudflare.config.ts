import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

export default defineConfig({ worker: {
  name: "azerothsurvivors-upload",
  compatibilityDate: "2026-10-25",
  entrypoint,
  env: {
    DOWNLOADS: bindings.r2({ name: "azerothsurvivors-downloads" }),
    UPLOAD_TOKEN: bindings.secret(),
  },
} });

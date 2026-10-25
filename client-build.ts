import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export function adminClient(): Plugin {
  return {
    name: "mirror-admin-client",
    resolveId(id) { if (id === "virtual:admin-client") return "\0virtual:admin-client"; },
    async load(id) {
      if (id !== "\0virtual:admin-client") return;
      const result = await build({ entryPoints: [fileURLToPath(new URL("./src/admin-client.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true });
      return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
    },
  };
}

import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { adminClient } from "./client-build.ts";

export default defineConfig({ plugins: [adminClient(), cloudflare()] });

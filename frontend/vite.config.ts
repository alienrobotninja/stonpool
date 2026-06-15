import { writeFileSync } from "fs";
import { join } from "path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

import { buildManifest, missingEnv } from "./src/build-config";

// fail a production build on dead config, and emit the tonconnect manifest from VITE_APP_URL
function stonpoolBuild(mode: string): Plugin {
  let outDir = "dist";
  return {
    name: "stonpool-build",
    apply: "build",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    buildStart() {
      const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
      const missing = missingEnv(env);
      if (missing.length) {
        throw new Error(`production build missing required env: ${missing.join(", ")}`);
      }
    },
    closeBundle() {
      const appUrl = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env }.VITE_APP_URL;
      if (!appUrl) {
        this.warn("VITE_APP_URL unset: shipping the placeholder tonconnect manifest");
        return;
      }
      writeFileSync(
        join(outDir, "tonconnect-manifest.json"),
        JSON.stringify(buildManifest(appUrl), null, 2) + "\n",
      );
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), stonpoolBuild(mode)],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
    css: true,
  },
}));
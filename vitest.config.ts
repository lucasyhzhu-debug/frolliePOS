import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";
import { readFileSync } from "node:fs";

// Mirror vite.config.ts's __APP_VERSION__ define so components reading it
// (e.g. the home header) render under test instead of throwing on the
// undefined global. package.json stays the single source of truth.
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // esc-pos-encoder's default export condition pulls in the native `canvas`
      // module (intentionally unbuilt); its "browser" build is canvas-free.
      // Alias the test resolution straight to that browser bundle — the same
      // one `vite build` picks via the browser export condition. Scoped to this
      // package so we don't change resolution for convex/react & co (a global
      // resolve.conditions:["browser"] flips their build and triggers spurious
      // WebSocket-teardown promise-rejection warnings in the React tests).
      "esc-pos-encoder": path.resolve(
        __dirname,
        "./node_modules/esc-pos-encoder/dist/esc-pos-encoder.esm.js",
      ),
    },
  },
  test: {
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "convex/**/*.test.ts",
      "tools/**/*.test.{ts,mjs,js}",
    ],
    environmentMatchGlobs: [
      ["convex/**", "edge-runtime"],
      ["src/**", "jsdom"],
    ],
    server: { deps: { inline: ["convex-test"] } },
  },
});

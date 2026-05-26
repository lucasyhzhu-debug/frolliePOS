import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
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

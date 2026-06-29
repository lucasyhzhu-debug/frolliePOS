import path from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Single source of truth for the app version: package.json. Injected as a
// build-time constant (`__APP_VERSION__`) so the UI can display it without a
// runtime import. Bump package.json + tag together at each release.
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // `prompt` (not `autoUpdate`): a new build does NOT silently swap under an
      // open booth PWA — instead `useRegisterSW().needRefresh` flips true and we
      // surface a tap-to-update banner (src/pwa). An always-open kiosk never
      // reloads, so silent autoUpdate's detection starved and devices stuck on an
      // old build; the banner + periodic update poll in useAppUpdate fixes that.
      registerType: "prompt",
      includeAssets: ["icons/*"],
      manifest: {
        name: "Frollie POS",
        short_name: "Frollie",
        description: "Frollie booth point-of-sale",
        theme_color: "#1d8a8a",
        background_color: "#f6f1e6",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        // `/presentation/` is a self-contained static deck (conference talk),
        // not a React Router route — exempt it from the SPA fallback so the
        // browser loads the real HTML instead of index.html. Mirrors /r/ + /approve/.
        navigateFallbackDenylist: [/^\/r\//, /^\/approve\//, /^\/presentation\//],
        // Keep the deck's images out of the precache manifest so they don't
        // bloat every PWA install; they load on demand when the deck is opened.
        globIgnores: ["**/presentation/**"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkOnly",
            options: { cacheName: "frollie-no-cache" },
          },
          {
            urlPattern: ({ request }) => request.destination === "image",
            handler: "CacheFirst",
            options: { cacheName: "frollie-images", expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    host: true,
    // Allow public tunnel domains so dev sessions reachable via ngrok / localtunnel /
    // cloudflared can pass Vite's host-header check (DNS-rebinding guard). The leading
    // dot is Vite's subdomain-wildcard sigil. Dev-only; production builds don't read this.
    allowedHosts: [
      ".ngrok-free.dev",
      ".ngrok-free.app",
      ".ngrok.io",
      ".ngrok.app",
      ".loca.lt",
      ".trycloudflare.com",
    ],
  },
});

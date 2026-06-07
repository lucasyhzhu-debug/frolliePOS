import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
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

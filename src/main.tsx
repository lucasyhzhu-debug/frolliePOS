import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Toaster } from "sonner";
import { router } from "@/router";
import "@/index.css";
import { reportOps } from "@/lib/reportOps";
import { isChunkLoadError } from "@/lib/chunkLoadError";
import { requestPersistentStorage } from "@/lib/persistStorage";

// Ask the browser to keep our storage (device-id in IndexedDB + localStorage)
// out of the evictable best-effort bucket. Without this, a desktop tab can lose
// the device UUID between sessions and be forced to re-activate. Fire-and-forget.
void requestPersistentStorage();

// Global unhandled error reporters — registered once at startup.
// Chunk-load errors (stale deploy / offline) are excluded: they are noise, not
// actionable crashes, and historically caused reload loops (ADR-025).
window.addEventListener("error", (e) => {
  if (isChunkLoadError(e.error)) return;
  reportOps({ kind: "unhandled", error: e.error ?? e.message });
});
window.addEventListener("unhandledrejection", (e) => {
  if (isChunkLoadError(e.reason)) return;
  reportOps({ kind: "unhandled", error: e.reason });
});

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;

if (!convexUrl) {
  // Surfacing this early is friendlier than a runtime "convex client not configured" error mid-render.
  console.warn("[frollie-pos] VITE_CONVEX_URL is not set. Copy .env.example → .env.local and `npx convex dev`.");
}

const convex = new ConvexReactClient(convexUrl ?? "https://placeholder.convex.cloud");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexProvider client={convex}>
      <RouterProvider router={router} />
      <Toaster position="top-center" richColors closeButton />
    </ConvexProvider>
  </React.StrictMode>,
);

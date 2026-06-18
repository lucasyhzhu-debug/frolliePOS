import { useRef } from "react";
import { useRouteError, useLocation } from "react-router";
import { isChunkLoadError } from "@/lib/chunkLoadError";
import { reportOps } from "@/lib/reportOps";
import { Button } from "@/components/ui/button";

/**
 * Root-level React Router error element. Two behaviours:
 *
 * 1. **Chunk-load failures** (stale deploy): reload the page exactly once,
 *    guarded by a `sessionStorage` timestamp. Second failure within 30s
 *    falls through to the friendly fallback instead of looping. Skipped
 *    entirely when offline: a chunk import fails offline too (an unvisited
 *    lazy route on a connection drop), and reloading then can't fetch the
 *    chunk — it just replaces the friendly fallback with a browser error
 *    page. Offline → show the fallback; the staffer reloads on reconnect.
 * 2. **Anything else**: render a minimal branded fallback. No stack trace,
 *    even in dev — staff are at the booth, not the IDE.
 *
 * Public routes (/r/:receiptNumber, /approve/:token, /activate) mount this
 * via PublicShell. The receipt route is customer-facing via Telegram, so
 * the fallback uses Indonesian copy under /r/*.
 *
 * Why timestamp not a boolean flag: a stale flag from a previous session
 * would force the fallback on a genuinely-fresh chunk failure. A 30s
 * window scopes the guard to the just-now reload attempt.
 */
const RELOAD_WINDOW_MS = 30_000;
const RELOAD_STAMP_KEY = "chunk-reload-at";

export function RouteErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();
  // Guard against double-reporting on React re-renders. The ref tracks the
  // exact error object we last reported so identical re-renders don't double-send.
  // Server-side dedup + client dedup in reportOps are belt-and-suspenders.
  const reportedError = useRef<unknown>(undefined);

  if (isChunkLoadError(error)) {
    const stamp = Number(sessionStorage.getItem(RELOAD_STAMP_KEY) ?? "0");
    // A missing/NaN stamp reads as 0, so the window check below is already
    // false for it — no separate stamp > 0 guard needed.
    const recentlyTried = Date.now() - stamp < RELOAD_WINDOW_MS;
    // Reloading only helps online: a fresh GET can fetch the new chunk hash.
    // Offline, the chunk is unreachable and a reload yields a browser error
    // page (chrome-error://) instead of our fallback — so skip it.
    if (!recentlyTried && navigator.onLine) {
      sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
      window.location.reload();
      return null;
    }
    // Fall through to the fallback below.
  }

  // Report genuine crashes (chunk-load handled above, never reported).
  if (!isChunkLoadError(error) && reportedError.current !== error) {
    reportedError.current = error;
    reportOps({ kind: "crash", error, route: location.pathname });
  }

  const isCustomerReceipt = location.pathname.startsWith("/r/");

  const title = isCustomerReceipt
    ? "Halaman tidak bisa dimuat"
    : "Something went wrong";
  const body = isCustomerReceipt
    ? "Buka ulang link dari Telegram."
    : "Reload to try again. If this keeps happening, lock the device and log in again.";
  const buttonLabel = isCustomerReceipt ? "Muat ulang" : "Reload";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-foreground">
      <div className="max-w-sm space-y-3 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
        <Button
          variant="default"
          onClick={() => {
            sessionStorage.removeItem(RELOAD_STAMP_KEY);
            window.location.reload();
          }}
        >
          {buttonLabel}
        </Button>
      </div>
    </main>
  );
}

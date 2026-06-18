// Resilient client-side error reporter. Uses raw fetch (NOT the Convex client,
// which a crash may have taken down) + keepalive (survives navigation/reload).

import { convexSiteOrigin } from "./convexUrl";

export function opsEndpoint(convexUrl: string): string {
  return convexSiteOrigin(convexUrl) + "/ops/error";
}

// In-memory dedup so a tight error loop can't hammer the endpoint (belt-and-
// suspenders to the server storm-cap). Cleared on reload.
const recentlySent = new Map<string, number>();
const CLIENT_DEDUP_MS = 10_000;

export function reportOps(input: {
  kind: "crash" | "unhandled" | "payment" | "mutation";
  error: unknown;
  route?: string;
  staffCode?: string;
  deviceId?: string;
}): void {
  try {
    // Read at call-time (Vite still statically replaces import.meta.env.VITE_* at
    // build) so tests can stub env, and so a missing token degrades to a no-op.
    const CONVEX_URL = import.meta.env.VITE_CONVEX_URL as string | undefined;
    const OPS_TOKEN = import.meta.env.VITE_OPS_INGEST_TOKEN as string | undefined;
    if (!CONVEX_URL || !OPS_TOKEN) return;
    const err = input.error;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const route = input.route ?? (typeof location !== "undefined" ? location.pathname : undefined);

    const key = `${input.kind}|${route ?? ""}|${message}`;
    const now = Date.now();
    const last = recentlySent.get(key);
    if (last && now - last < CLIENT_DEDUP_MS) return;
    recentlySent.set(key, now);
    if (recentlySent.size > 200) recentlySent.clear(); // bound memory

    void fetch(opsEndpoint(CONVEX_URL), {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json", "x-ops-token": OPS_TOKEN },
      body: JSON.stringify({
        kind: input.kind,
        message,
        stack,
        route,
        staff_code: input.staffCode,
        device_id: input.deviceId,
        online: typeof navigator !== "undefined" ? navigator.onLine : undefined,
        app_version: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : undefined,
      }),
    }).catch(() => {});
  } catch {
    /* reporting must never throw */
  }
}

import { useMemo } from "react";

/**
 * Generate a stable UUID for the lifetime of a single intent. ADR-013.
 *
 * The `intent` string is the natural key for what the user is trying to do
 * ("login:citra:dev-1", "createDraft:session-abc", "stockIn:tray-of-trays").
 * Same intent → same key → server deduplicates. Different intent → fresh key.
 *
 * Callers MUST regenerate the intent string when the user explicitly retries
 * after a failure they want re-executed, otherwise the server may return the
 * cached response from the first attempt (for successful prior calls).
 *
 * KNOWN v0.2 LIMITATION: keys live only in component memory. A full page
 * reload mid-mutation generates a fresh key on the next attempt — the server
 * treats that as a new mutation. Acceptable for v0.2 (login + catalog only,
 * no money flows). v0.3 will back this with IDB so reload-mid-payment
 * doesn't double-charge.
 */
export function useIdempotency(intent: string): string {
  return useMemo(() => `${intent}:${crypto.randomUUID()}`, [intent]);
}

import { Id } from "../_generated/dataModel";

/**
 * Lenient outlet-prefix assertion for idempotency keys. v2.0 Stream 5.
 *
 * As of v2.0, the FE prefixes idempotency keys with the session outlet:
 *   `"${outlet_id}:${intent}:${uuid}"`
 *
 * This helper enforces that the prefix matches the current session's outlet so
 * a client key minted in outlet A cannot replay a cached response in outlet B.
 *
 * ## Leniency rules (backward compatible)
 * - Key has no `:` separator → PASS (pre-v2.0 or window key format)
 * - `sessionOutletId` is undefined → PASS (window session, no outlet to assert)
 * - prefix before first `:` === sessionOutletId → PASS
 * - Otherwise → throws `OUTLET_KEY_MISMATCH`
 *
 * The assertion is intentionally lenient on unprefixed keys so that in-flight
 * keys minted before the v2.0 deploy (which have no outlet prefix) are not
 * rejected during the rolling upgrade window. Full enforcement (rejecting
 * unprefixed keys) is a follow-up task once all clients are on v2.0.
 *
 * Call this right after `require*Session(...)` resolves in the authCheck/handler.
 */
export function assertOutletKeyPrefix(
  key: string,
  sessionOutletId: Id<"outlets"> | undefined,
): void {
  const sep = key.indexOf(":");
  if (sep === -1) return; // unprefixed (pre-v2.0 or window key) — PASS
  if (sessionOutletId === undefined) return; // window session — PASS
  const prefix = key.slice(0, sep);
  if (prefix !== (sessionOutletId as string)) {
    throw new Error("OUTLET_KEY_MISMATCH");
  }
}

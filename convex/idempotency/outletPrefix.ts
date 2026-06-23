import { Id } from "../_generated/dataModel";

/**
 * Outlet-prefix assertion for idempotency keys. v2.0 Stream 5.
 *
 * As of v2.0, an outlet-scoped client prefixes idempotency keys with an
 * explicit sentinel marker:
 *   `"o:${outlet_id}:${intent}:${uuid}"`
 *
 * This helper enforces that the embedded outlet matches the current session's
 * outlet, so a client key minted in outlet A cannot replay a cached response
 * in outlet B.
 *
 * ## Why the `"o:"` sentinel is load-bearing
 * Legacy / pre-v2.0 keys are `"${intent}:${uuid}"` — they ALSO contain colons.
 * The original v2.0 helper tried to distinguish prefixed from legacy keys by
 * "has a colon", but every key has a colon, so it read the *intent name*
 * (`charge`, `draft`, `createProduct`, …) as the outlet id and threw
 * `OUTLET_KEY_MISMATCH` on every real mutation — taking the booth offline
 * (incident 2026-06-23). The leading `"o:"` sentinel removes that ambiguity:
 * no intent string begins with `"o:"`, so a key carries an outlet prefix *iff*
 * it starts with the sentinel.
 *
 * ## Rules (backward compatible)
 * - Key does NOT start with the `"o:"` sentinel → legacy / unprefixed → PASS.
 * - `sessionOutletId` is undefined (window session) → PASS.
 * - sentinel outlet === sessionOutletId → PASS.
 * - sentinel outlet !== sessionOutletId → throw `OUTLET_KEY_MISMATCH`.
 *
 * Leniency on non-sentinel keys keeps in-flight keys minted before the v2.0
 * deploy (and any client not yet emitting the prefix) working during the
 * rolling-upgrade window. Full enforcement (rejecting non-sentinel keys) is a
 * follow-up task once all clients emit the sentinel.
 *
 * Call this right after `require*Session(...)` resolves in the authCheck/handler.
 */
const OUTLET_KEY_SENTINEL = "o:";

export function assertOutletKeyPrefix(
  key: string,
  sessionOutletId: Id<"outlets"> | undefined,
): void {
  if (!key.startsWith(OUTLET_KEY_SENTINEL)) return; // legacy / unprefixed — PASS
  if (sessionOutletId === undefined) return; // window session — PASS
  const rest = key.slice(OUTLET_KEY_SENTINEL.length);
  const sep = rest.indexOf(":");
  const outlet = sep === -1 ? rest : rest.slice(0, sep);
  if (outlet !== (sessionOutletId as string)) {
    throw new Error("OUTLET_KEY_MISMATCH");
  }
}

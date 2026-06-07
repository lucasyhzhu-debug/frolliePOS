import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Action-level idempotency helper. v0.5.3b post-review extraction.
 *
 * Wraps an action body so:
 *   - On cache hit for `key`: returns the cached response without running fn.
 *   - On cache miss: runs fn, caches the JSON-stringified result under `key`
 *     with `mutationName` for debugging, returns the result.
 *
 * Seven PIN-gated admin actions follow this exact lookup/run/write shape:
 *   - staff.setStaffRole, staff.deactivateStaff
 *   - catalog.createProduct, catalog.createInventorySku, catalog.updateProductPricing
 *   - vouchers.createVoucher
 *   - inventory.recordSpoilage
 *
 * ADR-046 (auth hardening): `authCheck` runs BEFORE the cache lookup so a
 * replay with a spent idempotencyKey is rejected when the caller no longer holds
 * a valid manager session. Mirrors `withIdempotency`'s `authCheck` ordering in
 * `convex/idempotency/internal.ts` (lines 57–63). The PIN verify
 * (`verifyManagerPinOrThrow`) stays INSIDE `fn` so a legit retry skips the
 * expensive argon2 verify while still enforcing the session check.
 *
 * The helper does NOT replace the `:commit`-derived idempotencyKey passed to
 * the wrapped internal mutation — callers still pass `${key}:commit` to the
 * inner runMutation so the internal's withIdempotency wrap short-circuits an
 * action retry crashed between commit and cache-write. The two layers compose:
 *
 *   action retry (full re-run) → action cache absorbs second call
 *   action retry (crashed before cache write) → :commit wrap absorbs second
 *     internal call inside fn(), action cache then writes once
 *
 * Mirrors refunds/actions.ts:commitRefundInline's dual-cache discipline:
 * cache-lookup at the top, `${key}:commit` to the inner mutation, cache-write
 * at the bottom — just hoisted into one place.
 *
 * NOT for actions with custom post-cache logic (e.g. loginWithPin's session-
 * liveness recheck after cache hit, or auth.changePin's pre-commit shape).
 * Those keep the explicit three-step pattern.
 */
export async function withActionCache<T>(
  ctx: ActionCtx,
  params: { key: string; mutationName: string },
  authCheck: () => Promise<void>, // ADR-046: runs BEFORE cache lookup; throws on bad auth
  fn: () => Promise<T>,
): Promise<T> {
  await authCheck();
  const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
    key: params.key,
  });
  if (cached) return JSON.parse(cached) as T;
  const result = await fn();
  await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
    key: params.key,
    mutationName: params.mutationName,
    response: JSON.stringify(result),
  });
  return result;
}

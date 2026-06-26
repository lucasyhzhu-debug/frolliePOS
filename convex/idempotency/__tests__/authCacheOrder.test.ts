import { describe, test, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

/**
 * Regression test: withIdempotency must run authCheck BEFORE the cache lookup.
 *
 * Security invariant: an attacker who replays a request with a stale/revoked
 * sessionId must be rejected by authCheck — they must NOT receive a cached
 * response from an earlier valid execution. If auth ran AFTER the cache, the
 * cached response would be returned to the unauthorised caller and the security
 * bug would ship silently.
 *
 * Target: commitCart — its authCheck calls resolveSessionStaff which throws
 * "SESSION_INVALID" on a missing/ended session. This is a strict, throwing check.
 *
 * Why not logout? logout's authCheck is a documented no-op (graceful idempotent
 * Lock UX — see commit a0a73be). A no-op authCheck would not verify the ordering
 * invariant.
 */
describe("withIdempotency authCheck ordering", () => {
  test("invalid session is rejected BEFORE the cached response is read", async () => {
    const t = convexTest(schema);

    // Seed a staff member and a TERMINATED session (ended_at set). This models
    // the real attack: a session that was valid when a previous commitCart ran,
    // but has since been revoked (staff locked out, or explicit logout).
    // _resolveSession_internal returns null for ended sessions → resolveSessionStaff
    // throws "SESSION_INVALID".
    const { revokedSessionId } = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { is_open: false, code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
      const staffId = await ctx.db.insert("staff", {
        name: "Attacker", code: "S-0001", pin_hash: "x", role: "staff", active: true, created_at: Date.now(),
      });
      const revokedSessionId = await ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-attack",
        started_at: Date.now() - 120_000,
        ended_at: Date.now() - 60_000,   // session was ended — revoked
        end_reason: "manual_lock",
        outlet_id: outletId,
      } as any);
      return { revokedSessionId };
    });

    // Seed a fake cache entry with the idempotencyKey we're about to send.
    // If auth ran AFTER the cache lookup, this response would be returned to the
    // unauthorised caller — the security bug would ship silently.
    const key = "test-key-auth-cache-order";
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_idempotency", {
        key,
        mutation_name: "transactions.commitCart",
        response_blob: JSON.stringify({ txnId: "fake-cached-success" }),
        expires_at: Date.now() + 60_000,
      });
    });

    // Attempt commitCart with the SAME idempotencyKey but the revoked session.
    // authCheck must throw "SESSION_INVALID" — the cached response must NOT be returned.
    await expect(
      t.mutation(api.transactions.public.commitCart, {
        idempotencyKey: key,
        sessionId: revokedSessionId,
        intent: "draft",
        lines: [],   // empty — would throw EMPTY_CART, but authCheck fires first
      }),
    ).rejects.toThrow(/SESSION_INVALID/);
  });
});

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { seedManagerSession } from "../../staff/__tests__/_helpers";
import { api, internal } from "../../_generated/api";

/**
 * Regression test: withActionCache must run authCheck BEFORE the cache lookup
 * (ADR-046).
 *
 * Security invariant: a holder of a spent idempotencyKey whose session is NOT a
 * valid manager session must be rejected — they must NOT receive a cached response
 * from an earlier valid execution. Before this fix, withActionCache ran no pre-cache
 * auth check, so any caller who knew an idempotencyKey could replay it with any
 * sessionId (including a staff session or a random ID) and receive the cached result.
 *
 * Flow:
 *   1. Seed a manager + active manager session. Run createVoucher with key "K" →
 *      succeeds, seeds the cache row.
 *   2. Seed a separate STAFF (non-manager) and insert an active staff session.
 *   3. Replay createVoucher with the same key "K" but the staff session.
 *   4. Expected (AFTER fix): throws MANAGER_SESSION_REQUIRED (authCheck fires before
 *      cache lookup).
 *   5. Expected (BEFORE fix — red state): returns cached voucher id with no throw.
 */
describe("withActionCache auth-before-lookup (via createVoucher)", () => {
  // In-file arg-block helper: only key/sessionId/managerPin (and the unique
  // voucher code) vary per call; type/value are constant across all 4 tests.
  // Vouchers carry a unique-code constraint, so each test passes its own code.
  const mkVoucher = (
    t: ReturnType<typeof convexTest>,
    {
      sessionId,
      key,
      pin,
      code,
    }: { sessionId: unknown; key: string; pin: string; code: string },
  ) =>
    t.action(api.vouchers.actions.createVoucher, {
      idempotencyKey: key,
      sessionId: sessionId as never,
      code,
      type: "amount",
      value: 1000,
      managerPin: pin,
    });

  it("a cached key cannot be replayed without a valid manager session", async () => {
    const t = convexTest(schema);

    // Step 1: seed manager + session and create a voucher (warms the cache)
    const { sessionId } = await seedManagerSession(t);
    await mkVoucher(t, { sessionId, key: "K", pin: "9999", code: "AUTHCHK" });

    // Step 2: seed a STAFF member (not manager) and an active session for them
    const staffId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Bayu",
      pin: "0000",
      role: "staff",
    });
    const staffSession = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { code: "PKW2", name: "y", timezone: "Asia/Jakarta", active: false, created_at: Date.now(), created_by: null } as any);
      return ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "staff-device",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any);
    });

    // Step 3 + 4: replay the same idempotencyKey "K" with the staff session
    // AFTER the fix: withActionCache calls assertManagerSessionInAction BEFORE the
    // cache lookup → throws MANAGER_SESSION_REQUIRED.
    // BEFORE the fix (red): would return the cached Id<"pos_vouchers"> with no throw.
    await expect(
      mkVoucher(t, { sessionId: staffSession, key: "K", pin: "0000", code: "AUTHCHK" }),
    ).rejects.toThrow(/MANAGER_SESSION_REQUIRED/);
  });

  /**
   * Regression test: cache-hit path must NOT re-run verifyManagerPinOrThrow
   * (argon2). Proven by replaying the same idempotencyKey with a WRONG PIN —
   * if the cached id is returned (not a throw), argon2 was skipped on the
   * hit path. If it throws instead, that means PIN was re-checked, which is a
   * regression (the assertion must NOT be weakened to hide that failure).
   */
  it("cache hit returns cached value without re-verifying PIN", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);

    // First call: valid PIN, warms the cache
    const a = await mkVoucher(t, { sessionId, key: "HIT", pin: "9999", code: "SKIPPIN" });

    // Same key + valid manager session, but WRONG pin →
    // pre-cache authCheck passes (session is still active manager),
    // cache is hit, verifyManagerPinOrThrow/argon2 does NOT run,
    // so the cached id is returned without throwing.
    const b = await mkVoucher(t, { sessionId, key: "HIT", pin: "0000", code: "SKIPPIN" });

    expect(b).toBe(a);
  });

  /**
   * Regression test: an ENDED manager session must be rejected by the
   * pre-cache authCheck gate (MANAGER_SESSION_REQUIRED) even on a fresh key,
   * proving the resolution-parity between a live-session check and a
   * post-end replay.
   */
  it("ended manager session is rejected by the pre-cache gate", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);

    // Terminate the session
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, {
        ended_at: Date.now(),
        end_reason: "manual_lock",
      }),
    );

    // Fresh key — no cache row exists yet — but session is ended,
    // so the pre-cache authCheck must reject it.
    await expect(
      mkVoucher(t, { sessionId, key: "ENDED", pin: "9999", code: "PARITY" }),
    ).rejects.toThrow(/MANAGER_SESSION_REQUIRED/);
  });

  /**
   * Regression test: a manager whose staff row is DEACTIVATED (active=false)
   * must be rejected by the pre-cache authCheck gate (MANAGER_SESSION_REQUIRED)
   * even on a fresh key — the session row is still live, but the actor is no
   * longer an active manager.
   */
  it("deactivated manager (active=false) is rejected by the pre-cache gate", async () => {
    const t = convexTest(schema);
    const { managerId, sessionId } = await seedManagerSession(t);
    await t.run(async (ctx) => ctx.db.patch(managerId, { active: false }));
    await expect(
      mkVoucher(t, { sessionId, key: "DEACTIVATED", pin: "9999", code: "PARITY2" }),
    ).rejects.toThrow(/MANAGER_SESSION_REQUIRED/);
  });
});

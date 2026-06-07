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
  it("a cached key cannot be replayed without a valid manager session", async () => {
    const t = convexTest(schema);

    // Step 1: seed manager + session and create a voucher (warms the cache)
    const { sessionId } = await seedManagerSession(t);
    await t.action(api.vouchers.actions.createVoucher, {
      idempotencyKey: "K",
      sessionId,
      code: "AUTHCHK",
      type: "amount",
      value: 1000,
      managerPin: "9999",
    });

    // Step 2: seed a STAFF member (not manager) and an active session for them
    const staffId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Bayu",
      pin: "0000",
      role: "staff",
    });
    const staffSession = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "staff-device",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      }),
    );

    // Step 3 + 4: replay the same idempotencyKey "K" with the staff session
    // AFTER the fix: withActionCache calls assertManagerSessionInAction BEFORE the
    // cache lookup → throws MANAGER_SESSION_REQUIRED.
    // BEFORE the fix (red): would return the cached Id<"pos_vouchers"> with no throw.
    await expect(
      t.action(api.vouchers.actions.createVoucher, {
        idempotencyKey: "K",
        sessionId: staffSession,
        code: "AUTHCHK",
        type: "amount",
        value: 1000,
        managerPin: "0000",
      }),
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
    const a = await t.action(api.vouchers.actions.createVoucher, {
      idempotencyKey: "HIT",
      sessionId,
      code: "SKIPPIN",
      type: "amount",
      value: 1000,
      managerPin: "9999",
    });

    // Same key + valid manager session, but WRONG pin →
    // pre-cache authCheck passes (session is still active manager),
    // cache is hit, verifyManagerPinOrThrow/argon2 does NOT run,
    // so the cached id is returned without throwing.
    const b = await t.action(api.vouchers.actions.createVoucher, {
      idempotencyKey: "HIT",
      sessionId,
      code: "SKIPPIN",
      type: "amount",
      value: 1000,
      managerPin: "0000",
    });

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
      t.action(api.vouchers.actions.createVoucher, {
        idempotencyKey: "ENDED",
        sessionId,
        code: "PARITY",
        type: "amount",
        value: 1000,
        managerPin: "9999",
      }),
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
      t.action(api.vouchers.actions.createVoucher, {
        idempotencyKey: "DEACTIVATED", sessionId, code: "PARITY2",
        type: "amount", value: 1000, managerPin: "9999",
      }),
    ).rejects.toThrow(/MANAGER_SESSION_REQUIRED/);
  });
});

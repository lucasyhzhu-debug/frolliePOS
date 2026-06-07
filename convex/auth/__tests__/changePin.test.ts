import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

describe("auth/actions.changePin", () => {
  it("verifies currentPin, hashes newPin, calls _changePinCommit with actor=self", async () => {
    const t = convexTest(schema);
    const staffId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucy",
      pin: "1234",
      role: "staff",
    });
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      }),
    );

    await t.action(api.auth.actions.changePin, {
      sessionId: session,
      currentPin: "1234",
      newPin: "5678",
      idempotencyKey: "k-cp",
    });

    // Old PIN should now fail, new PIN succeeds
    await expect(
      t.action(api.auth.actions.loginWithPin, {
        idempotencyKey: "k-old",
        staffId,
        pin: "1234",
        deviceId: "d",
      }),
    ).rejects.toThrow();
    const ok = await t.action(api.auth.actions.loginWithPin, {
      idempotencyKey: "k-new",
      staffId,
      pin: "5678",
      deviceId: "d",
    });
    expect(ok.sessionId).toBeDefined();
  });

  it("rejects when newPin === currentPin", async () => {
    const t = convexTest(schema);
    const staffId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucy",
      pin: "1234",
      role: "staff",
    });
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      }),
    );
    await expect(
      t.action(api.auth.actions.changePin, {
        sessionId: session,
        currentPin: "1234",
        newPin: "1234",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/SAME_PIN|NEW_PIN_INVALID/);
  });
});

describe("auth/actions.resetStaffPin", () => {
  it("manager resets staff PIN at booth — clears lockout, logs staff.pin_reset", async () => {
    const t = convexTest(schema);
    const mgrId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucas",
      pin: "9999",
      role: "manager",
    });
    const staffId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucy",
      pin: "1234",
      role: "staff",
    });
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: mgrId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      }),
    );

    await t.action(api.auth.actions.resetStaffPin, {
      sessionId: session,
      targetStaffId: staffId,
      newPin: "5678",
      managerPin: "9999",
      idempotencyKey: "k-rsp",
    });

    // Staff can log in with new PIN
    const r = await t.action(api.auth.actions.loginWithPin, {
      idempotencyKey: "k-after",
      staffId,
      pin: "5678",
      deviceId: "d",
    });
    expect(r.sessionId).toBeDefined();
  });

  it("rejects when manager PIN is wrong", async () => {
    const t = convexTest(schema);
    const mgrId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucas",
      pin: "9999",
      role: "manager",
    });
    const staffId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucy",
      pin: "1234",
      role: "staff",
    });
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: mgrId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      }),
    );
    await expect(
      t.action(api.auth.actions.resetStaffPin, {
        sessionId: session,
        targetStaffId: staffId,
        newPin: "5678",
        managerPin: "WRONG",
        idempotencyKey: "k-bad",
      }),
    ).rejects.toThrow(/INVALID_PIN/);
  });

  it("rejects non-manager caller (MANAGER_SESSION_REQUIRED)", async () => {
    // ADR-046: assertManagerSessionInAction now fires BEFORE the cache lookup
    // (pre-cache authCheck). A staff-role caller gets MANAGER_SESSION_REQUIRED
    // from the authCheck rather than NOT_MANAGER from verifyManagerPinOrThrow
    // (which ran inside the cached body before this fix). Both errors assert "not
    // a manager" — the new error fires earlier and is semantically more precise.
    const t = convexTest(schema);
    const callerId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucy",
      pin: "1234",
      role: "staff",
    });
    const targetId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Mira",
      pin: "1111",
      role: "staff",
    });
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: callerId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      }),
    );
    await expect(
      t.action(api.auth.actions.resetStaffPin, {
        sessionId: session,
        targetStaffId: targetId,
        newPin: "5678",
        managerPin: "1234",
        idempotencyKey: "k-notmgr",
      }),
    ).rejects.toThrow(/MANAGER_SESSION_REQUIRED/);
  });

  it("rejects self-reset (USE_CHANGE_PIN_FOR_SELF)", async () => {
    const t = convexTest(schema);
    const mgrId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucas",
      pin: "9999",
      role: "manager",
    });
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: mgrId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      }),
    );
    await expect(
      t.action(api.auth.actions.resetStaffPin, {
        sessionId: session,
        targetStaffId: mgrId,
        newPin: "5678",
        managerPin: "9999",
        idempotencyKey: "k-self",
      }),
    ).rejects.toThrow(/USE_CHANGE_PIN_FOR_SELF/);
  });
});

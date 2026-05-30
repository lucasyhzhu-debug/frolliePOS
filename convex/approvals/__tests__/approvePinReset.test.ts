import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { createHash } from "node:crypto";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("approvals/actions.approveStaffPinReset", () => {
  it("happy path: argon2-verifies manager PIN, commits new PIN, marks resolved", async () => {
    const t = convexTest(schema);

    const mgrId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucas",
      pin: "9999",
      role: "manager",
    });
    const lucyId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucy",
      pin: "1234",
      role: "staff",
    });
    // _seedHashedStaff_internal does not set a `code` — patch one so the manager
    // can be resolved by code in approveStaffPinReset.
    const MGR_CODE = "S-0001";
    await t.run(async (ctx) => {
      await ctx.db.patch(mgrId, { code: MGR_CODE });
    });

    const rawToken = "raw-token-abc";
    const { requestId } = await t.mutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "staff_pin_reset",
        subject_staff_id: lucyId,
        triggered_by_event: "auth_lockout",
        triggered_at: Date.now(),
        token_hash: sha256Hex(rawToken),
        token_expires_at: Date.now() + 3_600_000,
      },
    );

    const res = await t.action(api.approvals.actions.approveStaffPinReset, {
      token: rawToken,
      managerPin: "9999",
      newPin: "5678",
      managerStaffCode: MGR_CODE,
      idempotencyKey: "k-app",
    });
    expect(res.resolved).toBe(true);

    // Lucy can now log in with the new PIN.
    const login = await t.action(api.auth.actions.loginWithPin, {
      idempotencyKey: "k-after",
      staffId: lucyId,
      pin: "5678",
      deviceId: "d",
    });
    expect(login.sessionId).toBeDefined();

    // Request marked resolved by the manager.
    const req = await t.run((ctx) => ctx.db.get(requestId));
    expect(req?.status).toBe("resolved");
    expect(req?.resolved_by_manager_id).toBe(mgrId);

    // The off-booth reset must record the off-booth source on the staff.pin_reset
    // audit row (Fix I-1) — booth_inline would be factually wrong here.
    // v0.4: shipped path always delivered via Telegram; legacy "wa_approval"
    // literal updated to "telegram_approval".
    const resetAudit = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "staff.pin_reset"))
        .collect(),
    );
    expect(resetAudit.length).toBe(1);
    expect(resetAudit[0].source).toBe("telegram_approval");
  });

  it("rejects expired token", async () => {
    const t = convexTest(schema);

    const mgrId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucas",
      pin: "9999",
      role: "manager",
    });
    const lucyId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "L",
      pin: "1234",
      role: "staff",
    });
    const MGR_CODE = "S-0001";
    await t.run(async (ctx) => {
      await ctx.db.patch(mgrId, { code: MGR_CODE });
    });

    const rawToken = "tok";
    await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "staff_pin_reset",
      subject_staff_id: lucyId,
      triggered_by_event: "auth_lockout",
      triggered_at: Date.now(),
      token_hash: sha256Hex(rawToken),
      token_expires_at: Date.now() - 1000, // already expired
    });

    await expect(
      t.action(api.approvals.actions.approveStaffPinReset, {
        token: rawToken,
        managerPin: "9999",
        newPin: "5678",
        managerStaffCode: MGR_CODE,
        idempotencyKey: "k-expired",
      }),
    ).rejects.toThrow(/TOKEN_EXPIRED|TOKEN_INVALID/);
  });

  it("rejects wrong manager PIN", async () => {
    const t = convexTest(schema);

    const mgrId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucas",
      pin: "9999",
      role: "manager",
    });
    const lucyId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "L",
      pin: "1234",
      role: "staff",
    });
    const MGR_CODE = "S-0001";
    await t.run(async (ctx) => {
      await ctx.db.patch(mgrId, { code: MGR_CODE });
    });

    const rawToken = "good-token";
    await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "staff_pin_reset",
      subject_staff_id: lucyId,
      triggered_by_event: "auth_lockout",
      triggered_at: Date.now(),
      token_hash: sha256Hex(rawToken),
      token_expires_at: Date.now() + 3_600_000,
    });

    await expect(
      t.action(api.approvals.actions.approveStaffPinReset, {
        token: rawToken,
        managerPin: "0000", // wrong PIN
        newPin: "5678",
        managerStaffCode: MGR_CODE,
        idempotencyKey: "k-wrongpin",
      }),
    ).rejects.toThrow("INVALID_PIN");

    // The wrong manager PIN must be RECORDED against the manager (lockout policy),
    // not silently swallowed.
    const attempt = await t.run((ctx) =>
      ctx.db
        .query("pos_auth_attempts")
        .withIndex("by_staff", (q) => q.eq("staff_id", mgrId))
        .first(),
    );
    expect(attempt?.fail_count).toBe(1);

    // And the request must remain pending — a wrong PIN never resolves it.
    const reqRow = await t.run((ctx) =>
      ctx.db
        .query("pos_approval_requests")
        .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", lucyId))
        .first(),
    );
    expect(reqRow?.status).toBe("pending");
  });
});

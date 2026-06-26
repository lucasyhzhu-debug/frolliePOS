import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { createHash } from "node:crypto";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// v2.0 Task 12 (ENFORCE): _createRequest_internal requires outletId; loginWithPin
// resolves the outlet from a bound device + asserts staff_outlet_access. Seeds the
// default outlet (returns its id).
async function seedOutlet(t: ReturnType<typeof convexTest>): Promise<Id<"outlets">> {
  return await t.run((ctx) =>
    ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any),
  );
}
// Bind device "d" to the outlet + grant the staff access so loginWithPin succeeds.
async function bindLogin(
  t: ReturnType<typeof convexTest>,
  outletId: Id<"outlets">,
  staffId: Id<"staff">,
): Promise<void> {
  await t.run(async (ctx: any) => {
    const devices = await ctx.db.query("registered_devices").collect();
    const dev = devices.find((d: any) => d.device_id === "d");
    if (!dev) {
      await ctx.db.insert("registered_devices", {
        device_id: "d", label: "d", activated_by: staffId,
        activated_at: Date.now(), last_seen_at: Date.now(), active: true,
        outlet_id: outletId,
      });
    }
    await ctx.db.insert("staff_outlet_access", {
      staff_id: staffId, outlet_id: outletId, granted_at: 0, granted_by: null,
    });
  });
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
    const outletId = await seedOutlet(t);
    await bindLogin(t, outletId, lucyId);

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
        outletId,
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
    const outletId = await seedOutlet(t);

    const rawToken = "tok";
    await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "staff_pin_reset",
      subject_staff_id: lucyId,
      triggered_by_event: "auth_lockout",
      triggered_at: Date.now(),
      token_hash: sha256Hex(rawToken),
      token_expires_at: Date.now() - 1000, // already expired
      outletId,
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
    const outletId = await seedOutlet(t);

    const rawToken = "good-token";
    await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "staff_pin_reset",
      subject_staff_id: lucyId,
      triggered_by_event: "auth_lockout",
      triggered_at: Date.now(),
      token_hash: sha256Hex(rawToken),
      token_expires_at: Date.now() + 3_600_000,
      outletId,
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

    // SEC-07: the wrong manager PIN is AUDITED (source=telegram_approval) but must
    // NOT write a booth lockout row — a leaked off-booth token can't DoS-lock the
    // manager's booth login. Brute force here is bounded by the per-token cap.
    const attempt = await t.run((ctx) =>
      ctx.db
        .query("pos_auth_attempts")
        .withIndex("by_staff", (q) => q.eq("staff_id", mgrId))
        .first(),
    );
    expect(attempt ?? null).toBeNull();
    const failAudit = await t.run((ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "staff.failed_pin")).first(),
    );
    expect(failAudit?.source).toBe("telegram_approval");

    // And the request must remain pending — a wrong PIN never resolves it.
    const reqRow = await t.run((ctx) =>
      ctx.db
        .query("pos_approval_requests")
        .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", lucyId))
        .first(),
    );
    expect(reqRow?.status).toBe("pending");
  });

  // ── denyRequest on staff_pin_reset ─────────────────────────────────────────
  // denyRequest is intentionally kind-agnostic (no WRONG_KIND guard) — the staff
  // PIN reset flow needs decline as much as the manual_payment_override flow.
  // Covers Reviewer #2 [CQ-8]: prior tests only exercised denyRequest on
  // manual_payment_override.

  it("denyRequest on staff_pin_reset marks the request denied + emits staff.pin_reset_denied audit row", async () => {
    const t = convexTest(schema);

    const mgrId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucas", pin: "9999", role: "manager",
    });
    const lucyId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucy", pin: "1234", role: "staff",
    });
    const MGR_CODE = "S-0001";
    await t.run(async (ctx) => {
      await ctx.db.patch(mgrId, { code: MGR_CODE });
    });
    const outletId = await seedOutlet(t);
    await bindLogin(t, outletId, lucyId);

    const rawToken = "deny-pin-tok";
    const { requestId } = await t.mutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "staff_pin_reset",
        subject_staff_id: lucyId,
        triggered_by_event: "auth_lockout",
        triggered_at: Date.now(),
        token_hash: sha256Hex(rawToken),
        token_expires_at: Date.now() + 3_600_000,
        outletId,
      },
    );

    const res = await t.action(api.approvals.actions.denyRequest, {
      token: rawToken,
      managerStaffCode: MGR_CODE,
      managerPin: "9999",
      denyReason: "suspicious lockout",
      idempotencyKey: "deny-pin-1",
    });
    expect(res.denied).toBe(true);

    // Request transitions to denied with the manager + reason recorded.
    const req = await t.run((ctx) => ctx.db.get(requestId));
    expect(req?.status).toBe("denied");
    expect(req?.denied_by_manager_id).toBe(mgrId);
    expect(req?.deny_reason).toBe("suspicious lockout");

    // Lucy's PIN must NOT have changed — deny never resets. Verified by login
    // with her original PIN. (Direct hash compare doesn't work — argon2 salts.)
    const login = await t.action(api.auth.actions.loginWithPin, {
      idempotencyKey: "post-deny-login",
      staffId: lucyId,
      pin: "1234",
      deviceId: "d",
    });
    expect(login.sessionId).toBeDefined();

    // Audit row routes through KIND_AUDIT["staff_pin_reset"].denied which now
    // emits "staff_pin_reset.denied" (per-kind verbs, v0.5.0) and threads
    // source="telegram_approval" per the off-booth deny path (Fix I-5 + ADR-035).
    const audits = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("entity_id"), requestId))
        .collect(),
    );
    const denyRow = audits.find((a) => a.action === "staff_pin_reset.denied");
    expect(denyRow).toBeDefined();
    expect(denyRow!.source).toBe("telegram_approval");
    expect(denyRow!.mgr_approver_id).toBe(mgrId);
  });
});

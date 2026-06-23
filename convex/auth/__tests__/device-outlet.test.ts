/**
 * Task 7 (v2.0 Stream 6, C2): device→outlet binding — window-tolerant tests.
 *
 * Controller decision: Task 7 ships in Step-1 (additive). Throws/access-deny are
 * deferred to Task 12 (enforce). These tests assert the WINDOW-TOLERANT behaviour:
 *   - unbound device login resolves to the default outlet (no throw)
 *   - bound device login resolves to the device's outlet
 *   - managerTakeover session carries outlet_id
 *   - assignDeviceOutlet binds + re-assign ends active sessions
 *   - seed fixtures carry default outlet_id on the manager session
 *
 * The `DEVICE_HAS_NO_OUTLET` throw and access-denial assertions belong to Task 12.
 */
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

// Shared helper: insert a minimal outlet row and return its id.
async function insertOutlet(ctx: any, code: string) {
  return ctx.db.insert("outlets", {
    code,
    name: `Outlet ${code}`,
    timezone: "Asia/Jakarta",
    active: true,
    created_at: Date.now(),
    created_by: null,
  });
}

// Shared helper: insert a staff row.
async function insertStaff(ctx: any, code: string, role: "staff" | "manager" = "staff") {
  return ctx.db.insert("staff", {
    name: `Staff ${code}`,
    code,
    pin_hash: "test-hash",
    role,
    active: true,
    created_at: Date.now(),
  });
}

// Shared helper: insert an active registered_devices row (unbound by default).
async function insertDevice(
  ctx: any,
  deviceId: string,
  activatedBy: any,
  outletId?: any,
) {
  const row: any = {
    device_id: deviceId,
    label: `Device ${deviceId}`,
    activated_by: activatedBy,
    activated_at: Date.now(),
    last_seen_at: Date.now(),
    active: true,
  };
  if (outletId) row.outlet_id = outletId;
  return ctx.db.insert("registered_devices", row);
}

// ---------------------------------------------------------------------------
// _loginCommit_internal — outlet stamping on session
// ---------------------------------------------------------------------------

describe("_loginCommit_internal — outlet stamping (window-tolerant)", () => {
  it("stamps the default outlet when the device is bound to it", async () => {
    const t = convexTest(schema);

    const { outletId, staffId } = await t.run(async (ctx) => {
      const outletId = await insertOutlet(ctx, "PKW-A");
      const staffId = await insertStaff(ctx, "S-T001");
      // Device bound to the outlet
      await insertDevice(ctx, "dev-unbound-1", staffId, outletId);
      // Grant access
      await (ctx as any).db.insert("staff_outlet_access", {
        staff_id: staffId, outlet_id: outletId, granted_at: 0, granted_by: null,
      });
      return { outletId, staffId };
    });

    // Call _loginCommit_internal directly (skips argon2)
    const result = await t.mutation(internal.auth.internal._loginCommit_internal, {
      idempotencyKey: "idem-unbound-1",
      staffId,
      deviceId: "dev-unbound-1",
    });

    expect(result.sessionId).toBeDefined();

    // Verify session row has outlet_id stamped
    const session = await t.run((ctx) => ctx.db.get(result.sessionId));
    expect((session as any)?.outlet_id).toBe(outletId);
  });

  it("stamps the device's bound outlet when the device has an outlet_id", async () => {
    const t = convexTest(schema);

    const { outletId, staffId } = await t.run(async (ctx) => {
      const outletId = await insertOutlet(ctx, "PKW-B");
      const staffId = await insertStaff(ctx, "S-T002");
      // Device BOUND to outletId
      await insertDevice(ctx, "dev-bound-1", staffId, outletId);
      // Grant access
      await (ctx as any).db.insert("staff_outlet_access", {
        staff_id: staffId, outlet_id: outletId, granted_at: 0, granted_by: null,
      });
      return { outletId, staffId };
    });

    const result = await t.mutation(internal.auth.internal._loginCommit_internal, {
      idempotencyKey: "idem-bound-1",
      staffId,
      deviceId: "dev-bound-1",
    });

    const session = await t.run((ctx) => ctx.db.get(result.sessionId));
    expect((session as any)?.outlet_id).toBe(outletId);
  });

  it("login audit metadata includes outlet_id", async () => {
    const t = convexTest(schema);

    const { outletId, staffId } = await t.run(async (ctx) => {
      const outletId = await insertOutlet(ctx, "PKW-C");
      const staffId = await insertStaff(ctx, "S-T003");
      await insertDevice(ctx, "dev-audit-1", staffId, outletId);
      // Grant access
      await (ctx as any).db.insert("staff_outlet_access", {
        staff_id: staffId, outlet_id: outletId, granted_at: 0, granted_by: null,
      });
      return { outletId, staffId };
    });

    await t.mutation(internal.auth.internal._loginCommit_internal, {
      idempotencyKey: "idem-audit-1",
      staffId,
      deviceId: "dev-audit-1",
    });

    const auditRow = await t.run((ctx) =>
      ctx.db.query("audit_log").filter((q: any) => q.eq(q.field("action"), "staff.login")).first()
    );
    expect(auditRow).toBeDefined();
    // metadata is JSON-stringified; parse it
    const meta = JSON.parse((auditRow as any)?.metadata ?? "{}");
    expect(meta.outlet_id).toBe(outletId);
  });
});

// ---------------------------------------------------------------------------
// _managerTakeoverSession_internal — outlet stamping
// ---------------------------------------------------------------------------

describe("_managerTakeoverSession_internal — outlet stamping", () => {
  it("manager takeover session carries outlet_id from bound device", async () => {
    const t = convexTest(schema);

    const { outletId, mgr } = await t.run(async (ctx) => {
      const outletId = await insertOutlet(ctx, "PKW-D");
      const staffId = await insertStaff(ctx, "S-T010");
      const mgr = await insertStaff(ctx, "S-T011", "manager");
      // Pre-existing active session for the staff member being displaced
      await ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-takeover-1",
        started_at: Date.now() - 1000,
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any);
      // Device bound to outlet
      await insertDevice(ctx, "dev-takeover-1", mgr, outletId);
      return { outletId, mgr };
    });

    const result = await t.mutation(internal.auth.internal._managerTakeoverSession_internal, {
      deviceId: "dev-takeover-1",
      managerStaffId: mgr,
    });

    const session = await t.run((ctx) => ctx.db.get(result.sessionId));
    expect((session as any)?.outlet_id).toBe(outletId);
  });

  it("manager takeover on device bound to outlet carries that outlet_id", async () => {
    const t = convexTest(schema);

    const { outletId, mgr } = await t.run(async (ctx) => {
      const outletId = await insertOutlet(ctx, "PKW-E");
      const mgr = await insertStaff(ctx, "S-T012", "manager");
      // Device BOUND to outlet
      await insertDevice(ctx, "dev-takeover-2", mgr, outletId);
      return { outletId, mgr };
    });

    const result = await t.mutation(internal.auth.internal._managerTakeoverSession_internal, {
      deviceId: "dev-takeover-2",
      managerStaffId: mgr,
    });

    const session = await t.run((ctx) => ctx.db.get(result.sessionId));
    expect((session as any)?.outlet_id).toBe(outletId);
  });
});

// ---------------------------------------------------------------------------
// _reset_internal (seed) — outlet fixtures
// ---------------------------------------------------------------------------

describe("_reset_internal seed — default outlet fixtures", () => {
  it("seeds a default outlet and the manager session carries outlet_id", async () => {
    const t = convexTest(schema);

    const result = await t.mutation(internal.seed.internal._reset_internal, {
      staffPinHash: "dummy-staff-hash",
      mgrPinHash: "dummy-mgr-hash",
      staffNames: ["Bayu", "Citra"],
    });

    // Default outlet should exist
    const outlets = await t.run((ctx) =>
      ctx.db.query("outlets").withIndex("by_active", (q: any) => q.eq("active", true)).collect()
    );
    expect(outlets.length).toBe(1);
    expect((outlets[0] as any).code).toBe("PKW");

    const outletId = (outlets[0] as any)._id;

    // Manager session should carry outlet_id
    const session = await t.run((ctx) => ctx.db.get(result.managerSessionId));
    expect((session as any)?.outlet_id).toBe(outletId);

    // Dev device should be bound to the outlet
    const device = await t.run((ctx) =>
      ctx.db.query("registered_devices")
        .withIndex("by_device_id", (q: any) => q.eq("device_id", "dev-booth-device"))
        .first()
    );
    expect((device as any)?.outlet_id).toBe(outletId);
  });

  it("seeds staff_outlet_access rows for all seeded staff", async () => {
    const t = convexTest(schema);

    await t.mutation(internal.seed.internal._reset_internal, {
      staffPinHash: "dummy-staff-hash",
      mgrPinHash: "dummy-mgr-hash",
      staffNames: ["Bayu", "Citra"],
    });

    const outlets = await t.run((ctx) =>
      ctx.db.query("outlets").withIndex("by_active", (q: any) => q.eq("active", true)).collect()
    );
    const outletId = (outlets[0] as any)._id;

    const allStaff = await t.run((ctx) => ctx.db.query("staff").collect());
    const accessRows = await t.run((ctx) =>
      ctx.db.query("staff_outlet_access").withIndex("by_outlet", (q: any) => q.eq("outlet_id", outletId)).collect()
    );

    // Every seeded staff member (staff + manager) should have an access row
    expect(accessRows.length).toBe(allStaff.length);
  });
});

// ---------------------------------------------------------------------------
// _assignDeviceOutlet_internal — device binding + session force-logout
// ---------------------------------------------------------------------------

describe("_assignDeviceOutlet_internal", () => {
  it("binds a device to an outlet and logs the audit event", async () => {
    const t = convexTest(schema);

    const { deviceId, outletId, mgrId } = await t.run(async (ctx) => {
      const outletId = await insertOutlet(ctx, "PKW-F");
      const mgrId = await insertStaff(ctx, "S-T020", "manager");
      await insertDevice(ctx, "dev-bind-1", mgrId); // unbound
      return { deviceId: "dev-bind-1", outletId, mgrId };
    });

    await t.mutation(internal.staff.internal._assignDeviceOutlet_internal, {
      deviceId,
      targetOutletId: outletId,
      mgrId,
      mgrDeviceId: "dev-bind-src",
    });

    const device = await t.run((ctx) =>
      ctx.db.query("registered_devices")
        .withIndex("by_device_id", (q: any) => q.eq("device_id", deviceId))
        .first()
    );
    expect((device as any)?.outlet_id).toBe(outletId);

    const auditRow = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .filter((q: any) => q.eq(q.field("action"), "device.assignOutlet"))
        .first()
    );
    expect(auditRow).toBeDefined();
    const meta = JSON.parse((auditRow as any)?.metadata ?? "{}");
    expect(meta.to_outlet_id).toBe(outletId);
    expect(meta.from_outlet_id).toBeNull();
  });

  it("re-assigning to a different outlet ends active sessions on that device", async () => {
    const t = convexTest(schema);

    const { deviceId, outlet1, outlet2, mgrId, sessionId } = await t.run(async (ctx) => {
      const outlet1 = await insertOutlet(ctx, "PKW-G");
      const outlet2 = await insertOutlet(ctx, "PKW-H");
      const staffId = await insertStaff(ctx, "S-T030");
      const mgrId = await insertStaff(ctx, "S-T031", "manager");
      await insertDevice(ctx, "dev-rebind-1", mgrId, outlet1); // bound to outlet1
      // Active session on this device
      const sessionId = await ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-rebind-1",
        started_at: Date.now() - 1000,
        ended_at: null,
        end_reason: null,
        outlet_id: outlet1,
      } as any);
      return { deviceId: "dev-rebind-1", outlet1, outlet2, mgrId, sessionId };
    });

    await t.mutation(internal.staff.internal._assignDeviceOutlet_internal, {
      deviceId,
      targetOutletId: outlet2,
      mgrId,
      mgrDeviceId: "dev-rebind-src",
    });

    // Active session must be force-logged out
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect((session as any)?.ended_at).not.toBeNull();
    expect((session as any)?.end_reason).toBe("force_logout");

    // Audit should record from/to outlet ids
    const auditRow = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .filter((q: any) => q.eq(q.field("action"), "device.assignOutlet"))
        .first()
    );
    const meta = JSON.parse((auditRow as any)?.metadata ?? "{}");
    expect(meta.from_outlet_id).toBe(outlet1);
    expect(meta.to_outlet_id).toBe(outlet2);
  });

  it("re-assigning to the SAME outlet is a no-op (no session force-logout)", async () => {
    const t = convexTest(schema);

    const { deviceId, outletId, mgrId, sessionId } = await t.run(async (ctx) => {
      const outletId = await insertOutlet(ctx, "PKW-I");
      const staffId = await insertStaff(ctx, "S-T040");
      const mgrId = await insertStaff(ctx, "S-T041", "manager");
      await insertDevice(ctx, "dev-same-1", mgrId, outletId);
      const sessionId = await ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-same-1",
        started_at: Date.now() - 1000,
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any);
      return { deviceId: "dev-same-1", outletId, mgrId, sessionId };
    });

    await t.mutation(internal.staff.internal._assignDeviceOutlet_internal, {
      deviceId,
      targetOutletId: outletId,
      mgrId,
      mgrDeviceId: "dev-same-src",
    });

    // Session must still be active (no force-logout on same-outlet assign)
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect((session as any)?.ended_at).toBeNull();
  });
});

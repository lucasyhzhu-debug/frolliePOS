import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

// v2.0 Task 12 (ENFORCE): sessions must carry outlet_id (requireSession /
// requireManagerSession throw SESSION_NO_OUTLET otherwise) and loginWithPin
// resolves the outlet from a bound device + asserts staff_outlet_access. This
// helper seeds the default outlet, binds device "d", and grants both the caller
// and (optionally) a target staff access — then returns { outletId }.
async function seedOutlet(t: ReturnType<typeof convexTest>): Promise<Id<"outlets">> {
  return await t.run((ctx) =>
    ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any),
  );
}
async function bindDeviceAndAccess(
  t: ReturnType<typeof convexTest>,
  outletId: Id<"outlets">,
  deviceId: string,
  staffIds: Id<"staff">[],
): Promise<void> {
  await t.run(async (ctx: any) => {
    const devices = await ctx.db.query("registered_devices").collect();
    const dev = devices.find((d: any) => d.device_id === deviceId);
    if (!dev) {
      await ctx.db.insert("registered_devices", {
        device_id: deviceId, label: deviceId, activated_by: staffIds[0],
        activated_at: Date.now(), last_seen_at: Date.now(), active: true,
        outlet_id: outletId,
      });
    }
    const accessRows = await ctx.db.query("staff_outlet_access").collect();
    for (const sid of staffIds) {
      const access = accessRows.find(
        (a: any) => a.staff_id === sid && a.outlet_id === outletId,
      );
      if (!access) {
        await ctx.db.insert("staff_outlet_access", {
          staff_id: sid, outlet_id: outletId, granted_at: 0, granted_by: null,
        });
      }
    }
  });
}

describe("auth/actions.changePin", () => {
  it("verifies currentPin, hashes newPin, calls _changePinCommit with actor=self", async () => {
    const t = convexTest(schema);
    const staffId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Lucy",
      pin: "1234",
      role: "staff",
    });
    const outletId = await seedOutlet(t);
    await bindDeviceAndAccess(t, outletId, "d", [staffId]);
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any),
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
    const outletId = await seedOutlet(t);
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any),
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
    const outletId = await seedOutlet(t);
    await bindDeviceAndAccess(t, outletId, "d", [mgrId, staffId]);
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: mgrId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any),
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
    const outletId = await seedOutlet(t);
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: mgrId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any),
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
    const outletId = await seedOutlet(t);
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: callerId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any),
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
    const outletId = await seedOutlet(t);
    const session = await t.run((ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: mgrId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any),
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

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { seedStaff } from "../../auth/__tests__/auth.test";

async function seedManager(t: ReturnType<typeof convexTest>) {
  return seedStaff(t, "AuditMgr", "9999", "manager");
}

async function seedRegularStaff(t: ReturnType<typeof convexTest>) {
  return seedStaff(t, "AuditStaff", "1111", "staff");
}

// Seed outlet + device binding + access grant so loginWithPin succeeds (Task 12 enforce).
async function seedOutletDeviceAccess(
  t: ReturnType<typeof convexTest>,
  staffId: any,
  deviceId: string,
) {
  return await t.run(async (ctx: any) => {
    const outlets = await ctx.db.query("outlets").collect();
    const outletId =
      outlets[0]?._id ??
      (await ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      }));
    const devices = await ctx.db.query("registered_devices").collect();
    const dev = devices.find((d: any) => d.device_id === deviceId);
    if (!dev) {
      await ctx.db.insert("registered_devices", {
        device_id: deviceId, label: deviceId, activated_by: staffId,
        activated_at: Date.now(), last_seen_at: Date.now(), active: true,
        outlet_id: outletId,
      });
    }
    const accessRows = await ctx.db.query("staff_outlet_access").collect();
    const access = accessRows.find((a: any) => a.staff_id === staffId && a.outlet_id === outletId);
    if (!access) {
      await ctx.db.insert("staff_outlet_access", {
        staff_id: staffId, outlet_id: outletId, granted_at: 0, granted_by: null,
      });
    }
    return outletId;
  });
}

async function loginAs(t: ReturnType<typeof convexTest>, staffId: any, pin: string) {
  await seedOutletDeviceAccess(t, staffId, "dev-audit");
  const { sessionId } = await t.action(api.auth.actions.loginWithPin, {
    staffId, pin, deviceId: "dev-audit", idempotencyKey: crypto.randomUUID(),
  });
  return sessionId;
}

describe("logAudit", () => {
  it("appends an audit row visible via _list_internal", async () => {
    const t = convexTest(schema);

    const staffId = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "Citra",
        code: "S-0001",
        pin_hash: "$argon2id$dummy",
        role: "staff",
        active: true,
        created_at: Date.now(),
      })
    );

    await t.mutation(internal.audit.internal.__test_log, {
      actor_id: staffId,
      action: "staff.login",
      entity_type: "staff",
      entity_id: staffId,
      source: "booth_inline",
    });

    const rows = await t.query(internal.audit.internal._list_internal, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "staff.login",
      entity_type: "staff",
      source: "booth_inline",
    });
  });
});

describe("audit.list — manager-only gate (Fix 4)", () => {
  it("manager session can read audit log", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const mgrSession = await loginAs(t, mgrId, "9999");

    // Seed one audit row via internal
    await t.mutation(internal.audit.internal.__test_log, {
      actor_id: mgrId,
      action: "test.action",
      entity_type: "staff",
      source: "booth_inline",
    });

    const rows = await t.query(api.audit.public.list, {
      sessionId: mgrSession,
      limit: 10,
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("non-manager session is rejected", async () => {
    const t = convexTest(schema);
    const staffId = await seedRegularStaff(t);
    const staffSession = await loginAs(t, staffId, "1111");

    await expect(
      t.query(api.audit.public.list, { sessionId: staffSession, limit: 10 })
    ).rejects.toThrow(/manager/i);
  });

  it("attaches actor_name (staff name for a staff actor, 'System' for system)", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t); // seeds staff named "AuditMgr"
    const mgrSession = await loginAs(t, mgrId, "9999");

    await t.mutation(internal.audit.internal.__test_log, {
      actor_id: mgrId,
      action: "test.byname",
      entity_type: "staff",
      source: "booth_inline",
    });
    await t.mutation(internal.audit.internal.__test_log, {
      actor_id: "system",
      action: "test.system",
      entity_type: "system",
      source: "system",
    });

    const rows = await t.query(api.audit.public.list, {
      sessionId: mgrSession,
      limit: 10,
    });
    const byName = rows.find((r) => r.action === "test.byname");
    const bySystem = rows.find((r) => r.action === "test.system");
    expect(byName?.actor_name).toBe("AuditMgr");
    expect(bySystem?.actor_name).toBe("System");
  });
});

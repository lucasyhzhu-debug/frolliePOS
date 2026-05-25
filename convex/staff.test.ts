import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { seedStaff } from "./auth.test";

const modules = import.meta.glob("./**/*.*s");

async function seedManager(t: ReturnType<typeof convexTest>) {
  return seedStaff(t, "Lucas", "9999", "manager");
}

async function loginAs(t: ReturnType<typeof convexTest>, staffId: any, pin: string) {
  const { sessionId } = await t.action(api.authActions.loginWithPin, {
    staffId, pin, deviceId: "dev-1", idempotencyKey: crypto.randomUUID(),
  });
  return sessionId;
}

describe("device registration", () => {
  it("generateDeviceSetupCode returns 6-digit code with 1h TTL (manager-only)", async () => {
    const t = convexTest(schema, modules);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");

    const { code, expiresAt } = await t.mutation(api.staff.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-1",
    });
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);

    const pending = await t.run(async (ctx) =>
      ctx.db.query("pending_device_setups")
        .withIndex("by_code", (q) => q.eq("setup_code", code)).unique()
    );
    expect(pending).not.toBeNull();
    expect(pending!.consumed_at).toBeNull();
  });

  it("activateDevice consumes a valid code + creates an active device", async () => {
    const t = convexTest(schema, modules);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code } = await t.mutation(api.staff.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-2",
    });

    const device = await t.mutation(api.staff.activateDevice, {
      code, deviceLabel: "Booth Phone 1", deviceId: "dev-new", idempotencyKey: "act-1",
    });
    expect(device.active).toBe(true);
    expect(device.label).toBe("Booth Phone 1");
    expect(device.device_id).toBe("dev-new");

    const pending = await t.run(async (ctx) =>
      ctx.db.query("pending_device_setups")
        .withIndex("by_code", (q) => q.eq("setup_code", code)).unique()
    );
    expect(pending!.consumed_at).toBeTypeOf("number");
  });

  it("activateDevice rejects an expired or already-consumed code", async () => {
    const t = convexTest(schema, modules);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code } = await t.mutation(api.staff.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-3",
    });

    await t.mutation(api.staff.activateDevice, {
      code, deviceLabel: "X", deviceId: "dev-x", idempotencyKey: "act-2",
    });

    await expect(
      t.mutation(api.staff.activateDevice, {
        code, deviceLabel: "Y", deviceId: "dev-y", idempotencyKey: "act-3",
      })
    ).rejects.toThrow(/invalid|expired|used|consumed/i);
  });

  it("activateDevice rejects when the same device_id is already registered", async () => {
    const t = convexTest(schema, modules);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code: code1 } = await t.mutation(api.staff.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-4",
    });
    await t.mutation(api.staff.activateDevice, {
      code: code1, deviceLabel: "A", deviceId: "dev-dupe", idempotencyKey: "act-4",
    });
    const { code: code2 } = await t.mutation(api.staff.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-5",
    });
    await expect(
      t.mutation(api.staff.activateDevice, {
        code: code2, deviceLabel: "B", deviceId: "dev-dupe", idempotencyKey: "act-5",
      })
    ).rejects.toThrow(/already registered/i);
  });
});

describe("isDeviceRegistered", () => {
  it("false for unknown device", async () => {
    const t = convexTest(schema, modules);
    const result = await t.query(api.staff.isDeviceRegistered, { deviceId: "unknown" });
    expect(result).toBe(false);
  });

  it("true after activation", async () => {
    const t = convexTest(schema, modules);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code } = await t.mutation(api.staff.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-iso-1",
    });
    await t.mutation(api.staff.activateDevice, {
      code, deviceLabel: "X", deviceId: "dev-iso", idempotencyKey: "act-iso-1",
    });
    expect(await t.query(api.staff.isDeviceRegistered, { deviceId: "dev-iso" })).toBe(true);
  });

  it("false for deactivated device", async () => {
    const t = convexTest(schema, modules);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code } = await t.mutation(api.staff.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-iso-2",
    });
    await t.mutation(api.staff.activateDevice, {
      code, deviceLabel: "X", deviceId: "dev-deact", idempotencyKey: "act-iso-2",
    });
    await t.run(async (ctx) => {
      const d = await ctx.db.query("registered_devices")
        .withIndex("by_device_id", (q) => q.eq("device_id", "dev-deact")).unique();
      await ctx.db.patch(d!._id, { active: false });
    });
    expect(await t.query(api.staff.isDeviceRegistered, { deviceId: "dev-deact" })).toBe(false);
  });
});

describe("createStaff", () => {
  it("manager-only", async () => {
    const t = convexTest(schema, modules);
    const mgrId = await seedManager(t);
    const mgrSession = await loginAs(t, mgrId, "9999");

    const newStaff = await t.action(api.authActions.createStaff, {
      sessionId: mgrSession, name: "Citra", role: "staff", pin: "1234",
      idempotencyKey: "create-1",
    });
    expect(newStaff.name).toBe("Citra");

    const staffSession = await loginAs(t, newStaff._id, "1234");
    await expect(
      t.action(api.authActions.createStaff, {
        sessionId: staffSession, name: "Eka", role: "staff", pin: "1111",
        idempotencyKey: "create-2",
      })
    ).rejects.toThrow(/manager/i);
  });
});

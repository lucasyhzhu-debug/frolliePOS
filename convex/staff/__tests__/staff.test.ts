import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { internal } from "../../_generated/api";
import { seedStaff } from "../../auth/__tests__/auth.test";

async function seedManager(t: ReturnType<typeof convexTest>) {
  return seedStaff(t, "Lucas", "9999", "manager");
}

async function loginAs(t: ReturnType<typeof convexTest>, staffId: any, pin: string) {
  const { sessionId } = await t.action(api.auth.actions.loginWithPin, {
    staffId, pin, deviceId: "dev-1", idempotencyKey: crypto.randomUUID(),
  });
  return sessionId;
}

describe("device registration", () => {
  it("generateDeviceSetupCode returns 6-digit code with 1h TTL (manager-only)", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");

    const { code, expiresAt } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
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
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-2",
    });

    const device = await t.mutation(api.staff.public.activateDevice, {
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
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-3",
    });

    await t.mutation(api.staff.public.activateDevice, {
      code, deviceLabel: "X", deviceId: "dev-x", idempotencyKey: "act-2",
    });

    await expect(
      t.mutation(api.staff.public.activateDevice, {
        code, deviceLabel: "Y", deviceId: "dev-y", idempotencyKey: "act-3",
      })
    ).rejects.toThrow(/invalid|expired|used|consumed/i);
  });

  it("activateDevice rejects when the same device_id is already registered", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code: code1 } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-4",
    });
    await t.mutation(api.staff.public.activateDevice, {
      code: code1, deviceLabel: "A", deviceId: "dev-dupe", idempotencyKey: "act-4",
    });
    const { code: code2 } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-5",
    });
    await expect(
      t.mutation(api.staff.public.activateDevice, {
        code: code2, deviceLabel: "B", deviceId: "dev-dupe", idempotencyKey: "act-5",
      })
    ).rejects.toThrow(/already registered/i);
  });
});

describe("isDeviceRegistered", () => {
  it("false for unknown device", async () => {
    const t = convexTest(schema);
    const result = await t.query(api.staff.public.isDeviceRegistered, { deviceId: "unknown" });
    expect(result).toBe(false);
  });

  it("true after activation", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-iso-1",
    });
    await t.mutation(api.staff.public.activateDevice, {
      code, deviceLabel: "X", deviceId: "dev-iso", idempotencyKey: "act-iso-1",
    });
    expect(await t.query(api.staff.public.isDeviceRegistered, { deviceId: "dev-iso" })).toBe(true);
  });

  it("false for deactivated device", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-iso-2",
    });
    await t.mutation(api.staff.public.activateDevice, {
      code, deviceLabel: "X", deviceId: "dev-deact", idempotencyKey: "act-iso-2",
    });
    await t.run(async (ctx) => {
      const d = await ctx.db.query("registered_devices")
        .withIndex("by_device_id", (q) => q.eq("device_id", "dev-deact")).unique();
      await ctx.db.patch(d!._id, { active: false });
    });
    expect(await t.query(api.staff.public.isDeviceRegistered, { deviceId: "dev-deact" })).toBe(false);
  });
});

// Fix 2 — inactive device reactivation + label validation
describe("activateDevice — Fix 2", () => {
  it("reactivates an inactive device row (same _id returned, no duplicate)", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");

    // First activation
    const { code: code1 } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "fix2-gen-1",
    });
    const first = await t.mutation(api.staff.public.activateDevice, {
      code: code1, deviceLabel: "Booth Phone", deviceId: "dev-reactivate",
      idempotencyKey: "fix2-act-1",
    });

    // Deactivate the device directly
    await t.run(async (ctx) => {
      await ctx.db.patch(first._id, { active: false });
    });

    // Re-activate with a fresh code + same device_id
    const { code: code2 } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "fix2-gen-2",
    });
    const second = await t.mutation(api.staff.public.activateDevice, {
      code: code2, deviceLabel: "Booth Phone v2", deviceId: "dev-reactivate",
      idempotencyKey: "fix2-act-2",
    });

    // Same _id — not a new row
    expect(second._id).toBe(first._id);
    expect(second.active).toBe(true);
    expect(second.label).toBe("Booth Phone v2");

    // Only ONE row for this device_id
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("registered_devices")
        .withIndex("by_device_id", (q) => q.eq("device_id", "dev-reactivate"))
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
  });

  it("rejects empty deviceLabel", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "fix2-empty-gen",
    });

    await expect(
      t.mutation(api.staff.public.activateDevice, {
        code, deviceLabel: "   ", deviceId: "dev-empty-label",
        idempotencyKey: "fix2-empty-act",
      })
    ).rejects.toThrow(/label/i);
  });

  it("rejects oversized deviceLabel (> 64 chars)", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    const { code } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "fix2-long-gen",
    });

    await expect(
      t.mutation(api.staff.public.activateDevice, {
        code, deviceLabel: "X".repeat(100), deviceId: "dev-long-label",
        idempotencyKey: "fix2-long-act",
      })
    ).rejects.toThrow(/label/i);
  });
});

describe("createStaff", () => {
  it("manager-only", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const mgrSession = await loginAs(t, mgrId, "9999");

    const newStaff = await t.action(api.auth.actions.createStaff, {
      sessionId: mgrSession, name: "Citra", role: "staff", pin: "1234",
      managerPin: "9999", idempotencyKey: "create-1",
    });
    expect(newStaff.name).toBe("Citra");

    const staffSession = await loginAs(t, newStaff._id, "1234");
    await expect(
      t.action(api.auth.actions.createStaff, {
        sessionId: staffSession, name: "Eka", role: "staff", pin: "1111",
        managerPin: "1234", idempotencyKey: "create-2",
      })
    ).rejects.toThrow(/NOT_MANAGER|manager/i);
  });
});

describe("issueDeviceSetupCode shared helper (via Telegram wrapper)", () => {
  it("issues a telegram-attributed code with issued_via + audit source telegram_approval", async () => {
    const t = convexTest(schema);
    const { code, expiresAt } = await t.mutation(
      internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal,
      { chatTitle: "Frollie · Managers", fromId: 4242 },
    );
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("pending_device_setups")
        .withIndex("by_code", (q) => q.eq("setup_code", code))
        .unique(),
    );
    expect(row?.issued_via).toBe("telegram");
    expect(row?.issued_by).toBeUndefined();
    expect(row?.issued_by_telegram).toEqual({ from_id: 4242, chat_title: "Frollie · Managers" });

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "device.setup_code_issued"))
        .collect(),
    );
    const telegramRow = audit.find((a) => a.source === "telegram_approval");
    expect(telegramRow).toBeDefined();
    expect(telegramRow?.actor_id).toBe("system");
    expect(JSON.parse(telegramRow!.metadata as string)).toMatchObject({
      issued_via: "telegram",
      telegram_from_id: 4242,
      chat_title: "Frollie · Managers",
    });
  });

  it("issues a code when fromId is undefined (anonymous admin)", async () => {
    const t = convexTest(schema);
    const { code } = await t.mutation(
      internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal,
      { chatTitle: "Frollie · Managers" },
    );
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("pending_device_setups")
        .withIndex("by_code", (q) => q.eq("setup_code", code))
        .unique(),
    );
    expect(row?.issued_by_telegram?.from_id).toBeUndefined();
    expect(row?.issued_by_telegram?.chat_title).toBe("Frollie · Managers");
  });
});

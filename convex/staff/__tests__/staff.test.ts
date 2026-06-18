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
  it("generateDeviceSetupCode returns 6-digit code with 15min TTL (manager-only)", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");

    const { code, expiresAt } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-1",
    });
    expect(code).toMatch(/^\d{6}$/);
    // SEC-04: TTL shortened 1h → 15min.
    expect(expiresAt).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);

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

    const device = await t.action(api.staff.public.activateDevice, {
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

    await t.action(api.staff.public.activateDevice, {
      code, deviceLabel: "X", deviceId: "dev-x", idempotencyKey: "act-2",
    });

    await expect(
      t.action(api.staff.public.activateDevice, {
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
    await t.action(api.staff.public.activateDevice, {
      code: code1, deviceLabel: "A", deviceId: "dev-dupe", idempotencyKey: "act-4",
    });
    const { code: code2 } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-5",
    });
    await expect(
      t.action(api.staff.public.activateDevice, {
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
    await t.action(api.staff.public.activateDevice, {
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
    await t.action(api.staff.public.activateDevice, {
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
    const first = await t.action(api.staff.public.activateDevice, {
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
    const second = await t.action(api.staff.public.activateDevice, {
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
      t.action(api.staff.public.activateDevice, {
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
      t.action(api.staff.public.activateDevice, {
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

describe("activateDevice with a Telegram-issued code", () => {
  it("activates with no activated_by and audits as system + activated_via telegram", async () => {
    const t = convexTest(schema);
    const { code } = await t.mutation(
      internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal,
      { chatTitle: "Frollie · Managers", fromId: 99 },
    );

    const res = await t.action(api.staff.public.activateDevice, {
      idempotencyKey: "act-tg-1",
      code,
      deviceLabel: "New Phone",
      deviceId: "dev-tg-1",
    });
    expect(res.active).toBe(true);

    const device = await t.run(async (ctx) =>
      ctx.db
        .query("registered_devices")
        .withIndex("by_device_id", (q) => q.eq("device_id", "dev-tg-1"))
        .unique(),
    );
    expect(device?.activated_by).toBeUndefined();

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "device.activated"))
        .collect(),
    );
    expect(audit[0]?.actor_id).toBe("system");
    expect(JSON.parse(audit[0]!.metadata as string)).toMatchObject({
      activated_via: "telegram",
      label: "New Phone",
    });
  });
});

describe("issueDeviceSetupCode shared helper (via Telegram wrapper)", () => {
  it("issues a telegram-attributed code with issued_via + audit source system", async () => {
    const t = convexTest(schema);
    const { code, expiresAt } = await t.mutation(
      internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal,
      { chatTitle: "Frollie · Managers", fromId: 4242 },
    );
    expect(code).toMatch(/^\d{6}$/);
    // SEC-04: TTL shortened 1h → 15min.
    expect(expiresAt).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);

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
    // Telegram issuance is NOT a PIN/approval-gated event — source is "system"
    // (matching the "system" actor), NOT "telegram_approval" (CLAUDE.md #10).
    const telegramRow = audit.find((a) => a.source === "system");
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

describe("SEC-04: activateDevice throttle + TTL", () => {
  it("locks a device after 5 wrong codes", async () => {
    const t = convexTest(schema);
    for (let i = 0; i < 5; i++) {
      await t.action(api.staff.public.activateDevice, {
        idempotencyKey: `bad-${i}`, code: "000000", deviceLabel: "x", deviceId: "dev-A",
      }).catch(() => {});
    }
    await expect(
      t.action(api.staff.public.activateDevice, {
        idempotencyKey: "bad-6", code: "000000", deviceLabel: "x", deviceId: "dev-A",
      }),
    ).rejects.toThrow("ACTIVATION_LOCKED");
  });

  it("global window locks ALL devices after 50 failures (per-device rotation bypass)", async () => {
    const t = convexTest(schema);
    // Rotate device_id each call so the per-device counter never trips (each
    // device fails once); only the global rolling-window counter accumulates.
    for (let i = 0; i < 50; i++) {
      await t.action(api.staff.public.activateDevice, {
        idempotencyKey: `g-${i}`, code: "000000", deviceLabel: "x", deviceId: `dev-${i}`,
      }).catch(() => {});
    }
    // A brand-new device (per-device counter clean) is still blocked by the
    // global window lock.
    await expect(
      t.action(api.staff.public.activateDevice, {
        idempotencyKey: "g-after", code: "000000", deviceLabel: "x", deviceId: "dev-fresh",
      }),
    ).rejects.toThrow("ACTIVATION_LOCKED");
    // Global breach is audited; pending_device_setups is NOT wiped.
    const audit = await t.run((ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "device.activation_throttled")).first());
    expect(audit).not.toBeNull();
    // C1 regression: the breach must lock until the WINDOW resets (15min), not a
    // fixed 60s — else a device-rotating attacker waits 60s and resumes. Assert
    // the global row's lock spans the full window from its anchor.
    const globalRow = await t.run((ctx) =>
      ctx.db.query("pos_device_activation_attempts").withIndex("by_key", (q) => q.eq("key", "__global__")).unique());
    expect(globalRow?.locked_until).toBe((globalRow!.window_start_at) + 15 * 60 * 1000);
  });

  it("I1: a format-invalid code does NOT count toward the throttle; a valid-format wrong code does", async () => {
    const t = convexTest(schema);
    // Format-invalid inputs (not 6 digits) are rejected before the throttle and
    // must NOT write an attempt row — they aren't brute-force guesses.
    for (const bad of ["abc", "12345", "1234567"]) {
      await t.action(api.staff.public.activateDevice, {
        idempotencyKey: `fmt-${bad}`, code: bad, deviceLabel: "x", deviceId: "dev-fmt",
      }).catch(() => {});
    }
    let rows = await t.run((ctx) =>
      ctx.db.query("pos_device_activation_attempts").withIndex("by_key", (q) => q.eq("key", "dev-fmt")).collect());
    expect(rows.length).toBe(0); // format misses never touch the counter

    // A valid-format but wrong 6-digit code IS a guess → counts.
    await t.action(api.staff.public.activateDevice, {
      idempotencyKey: "fmt-real", code: "000000", deviceLabel: "x", deviceId: "dev-fmt",
    }).catch(() => {});
    rows = await t.run((ctx) =>
      ctx.db.query("pos_device_activation_attempts").withIndex("by_key", (q) => q.eq("key", "dev-fmt")).collect());
    expect(rows.length).toBe(1);
    expect(rows[0].fail_count).toBe(1);
  });

  it("rejects an expired (>15min) code with INVALID_CODE", async () => {
    const t = convexTest(schema);
    await t.run((ctx) => ctx.db.insert("pending_device_setups", {
      setup_code: "123456", issued_via: "booth_inline",
      expires_at: Date.now() - 1, consumed_at: null,
    }));
    await expect(
      t.action(api.staff.public.activateDevice, {
        idempotencyKey: "exp-1", code: "123456", deviceLabel: "x", deviceId: "dev-exp",
      }),
    ).rejects.toThrow("INVALID_CODE");
  });

  it("a successful activation clears the device's failed-attempt counter", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const session = await loginAs(t, mgrId, "9999");
    // Two misses on dev-clear (under the 5-cap).
    for (let i = 0; i < 2; i++) {
      await t.action(api.staff.public.activateDevice, {
        idempotencyKey: `pre-${i}`, code: "000000", deviceLabel: "x", deviceId: "dev-clear",
      }).catch(() => {});
    }
    const { code } = await t.mutation(api.staff.public.generateDeviceSetupCode, {
      sessionId: session, idempotencyKey: "gen-clear",
    });
    await t.action(api.staff.public.activateDevice, {
      code, deviceLabel: "Booth", deviceId: "dev-clear", idempotencyKey: "act-clear",
    });
    const rows = await t.run((ctx) =>
      ctx.db.query("pos_device_activation_attempts").withIndex("by_key", (q) => q.eq("key", "dev-clear")).collect());
    expect(rows.length).toBe(0);
  });
});

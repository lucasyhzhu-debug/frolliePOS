import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { sha256Hex } from "../../lib/sha256";

// registerRememberedDevice / quickPinLogin are "use node" actions (argon2). No
// external fetch is needed — neither path sends a Telegram DM.

// ── seed helpers ──────────────────────────────────────────────────────────────

async function seedOwner(
  t: ReturnType<typeof convexTest>,
  opts: { role?: "owner" | "manager"; active?: boolean; code?: string } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "Owner",
      code: opts.code ?? "S-9000",
      pin_hash: "h",
      role: opts.role ?? "owner",
      active: opts.active ?? true,
      created_at: Date.now(),
      telegram_user_id: 555000,
    } as never),
  );
}

/** Seed a LIVE cockpit (owner) session — the gate for registerRememberedDevice. */
async function seedCockpitSession(
  t: ReturnType<typeof convexTest>,
  staffId: string,
  deviceId = "cockpit-dev",
) {
  return t.run((ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: staffId as never,
      device_id: deviceId,
      kind: "cockpit",
      started_at: Date.now(),
      last_active_at: Date.now(),
      ended_at: null,
      end_reason: null,
    } as never),
  );
}

// ── (a) register enrolls a remember_device binding ───────────────────────────

test("registerRememberedDevice enrolls a remember_device binding with quick_pin_hash + device_id", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-REG" });
  const sessionId = await seedCockpitSession(t, ownerId, "phone-A");

  const res = await t.action(api.auth.ownerActions.registerRememberedDevice, {
    idempotencyKey: "reg1",
    sessionId,
    deviceId: "phone-A",
    quickPin: "1234",
  });
  expect(typeof res.rememberToken).toBe("string");
  expect(res.rememberToken.length).toBeGreaterThan(20);

  const tokenHash = await sha256Hex(res.rememberToken);
  const binding = await t.run((ctx) =>
    ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .first(),
  );
  expect(binding).not.toBeNull();
  expect(binding!.kind).toBe("remember_device");
  expect(binding!.staff_id).toBe(ownerId);
  expect(binding!.device_id).toBe("phone-A");
  expect(typeof binding!.quick_pin_hash).toBe("string");
  // argon2id PHC-encoded, never the raw PIN.
  expect(binding!.quick_pin_hash).toContain("$argon2id$");
  expect(binding!.quick_pin_hash).not.toContain("1234");
  expect(binding!.redeemed_at).toBeNull();
  // ~30-day TTL.
  const days = (binding!.expires_at - Date.now()) / 864e5;
  expect(days).toBeGreaterThan(29);
  expect(days).toBeLessThan(31);

  // owner.device_remembered audit row, source system.
  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(
    audit.some((r) => r.action === "owner.device_remembered" && r.source === "system"),
  ).toBe(true);
});

test("registerRememberedDevice rejects a non-cockpit (booth) session", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-BOOTH" });
  const boothSession = await t.run((ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: ownerId as never,
      device_id: "phone-B",
      kind: "booth",
      started_at: Date.now(),
      last_active_at: Date.now(),
      ended_at: null,
      end_reason: null,
    } as never),
  );

  await expect(
    t.action(api.auth.ownerActions.registerRememberedDevice, {
      idempotencyKey: "reg-booth",
      sessionId: boothSession,
      deviceId: "phone-B",
      quickPin: "1234",
    }),
  ).rejects.toThrow("NOT_COCKPIT_SESSION");
});

test("registerRememberedDevice rejects a malformed quick-PIN", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-BADPIN" });
  const sessionId = await seedCockpitSession(t, ownerId, "phone-C");

  await expect(
    t.action(api.auth.ownerActions.registerRememberedDevice, {
      idempotencyKey: "reg-bad",
      sessionId,
      deviceId: "phone-C",
      quickPin: "12", // too short
    }),
  ).rejects.toThrow();
});

// ── (b) quickPinLogin mints a cockpit session ────────────────────────────────

test("quickPinLogin on the remembered device mints a cockpit session with NO outlet_id", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-QPL" });
  const sessionId = await seedCockpitSession(t, ownerId, "phone-D");

  const { rememberToken } = await t.action(
    api.auth.ownerActions.registerRememberedDevice,
    { idempotencyKey: "reg-qpl", sessionId, deviceId: "phone-D", quickPin: "4321" },
  );

  const res = await t.action(api.auth.ownerActions.quickPinLogin, {
    idempotencyKey: "qpl1",
    deviceId: "phone-D",
    rememberToken,
    quickPin: "4321",
  });
  expect(res.role).toBe("owner");

  const session = await t.run((ctx) => ctx.db.get(res.sessionId));
  expect(session?.kind).toBe("cockpit");
  expect(session?.outlet_id).toBeUndefined();
  expect(session?.ended_at).toBeNull();
  expect(session?.staff_id).toBe(ownerId);

  // owner.login audit row with sub_reason: "quick_pin".
  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  const loginRow = audit.find(
    (r) => r.action === "owner.login" && r.source === "system" && r.metadata != null,
  );
  expect(loginRow).toBeDefined();
  expect(JSON.parse(loginRow!.metadata as string)).toMatchObject({ sub_reason: "quick_pin" });
});

// ── (c) wrong quick-PIN 3× locks; pos_auth_attempts untouched (SEC-07) ───────

test("wrong quick-PIN 3x locks the binding (per-binding counter); pos_auth_attempts untouched (SEC-07)", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-LOCK" });
  const sessionId = await seedCockpitSession(t, ownerId, "phone-E");
  const { rememberToken } = await t.action(
    api.auth.ownerActions.registerRememberedDevice,
    { idempotencyKey: "reg-lock", sessionId, deviceId: "phone-E", quickPin: "1111" },
  );
  const tokenHash = await sha256Hex(rememberToken);

  // 3 wrong attempts → each rejected REMEMBER_INVALID; the 3rd trips the lock.
  for (let i = 0; i < 3; i++) {
    await expect(
      t.action(api.auth.ownerActions.quickPinLogin, {
        idempotencyKey: `qpl-bad-${i}`,
        deviceId: "phone-E",
        rememberToken,
        quickPin: "9999",
      }),
    ).rejects.toThrow("REMEMBER_INVALID");
  }

  // 4th attempt — even with the CORRECT PIN — is now locked out.
  await expect(
    t.action(api.auth.ownerActions.quickPinLogin, {
      idempotencyKey: "qpl-locked",
      deviceId: "phone-E",
      rememberToken,
      quickPin: "1111",
    }),
  ).rejects.toThrow(/LOCKED_OUT:\d+/);

  // Per-binding counter recorded the failures on the binding row.
  const binding = await t.run((ctx) =>
    ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .first(),
  );
  expect(binding!.quick_pin_fail_count).toBe(3);
  expect(binding!.quick_pin_locked_until).not.toBeNull();
  expect(binding!.quick_pin_locked_until).toBeGreaterThan(Date.now());

  // SEC-07: NO booth-lockout rows for this owner.
  const booth = await t.run((ctx) =>
    ctx.db
      .query("pos_auth_attempts")
      .withIndex("by_staff", (q) => q.eq("staff_id", ownerId))
      .collect(),
  );
  expect(booth.length).toBe(0);

  // SEC-07: the OTP rate-limit table is also untouched (different semantics).
  const otpAttempts = await t.run((ctx) =>
    ctx.db
      .query("owner_auth_attempts")
      .withIndex("by_staff", (q) => q.eq("staff_id", ownerId))
      .collect(),
  );
  expect(otpAttempts.length).toBe(0);
});

test("a correct quick-PIN before the cap resets the failure counter", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-RESET" });
  const sessionId = await seedCockpitSession(t, ownerId, "phone-F");
  const { rememberToken } = await t.action(
    api.auth.ownerActions.registerRememberedDevice,
    { idempotencyKey: "reg-reset", sessionId, deviceId: "phone-F", quickPin: "2222" },
  );
  const tokenHash = await sha256Hex(rememberToken);

  // 2 misses (below the cap of 3)…
  for (let i = 0; i < 2; i++) {
    await expect(
      t.action(api.auth.ownerActions.quickPinLogin, {
        idempotencyKey: `qpl-r-${i}`,
        deviceId: "phone-F",
        rememberToken,
        quickPin: "0000",
      }),
    ).rejects.toThrow("REMEMBER_INVALID");
  }

  // …then a correct login succeeds and clears the counter.
  const res = await t.action(api.auth.ownerActions.quickPinLogin, {
    idempotencyKey: "qpl-r-ok",
    deviceId: "phone-F",
    rememberToken,
    quickPin: "2222",
  });
  expect(res.role).toBe("owner");

  const binding = await t.run((ctx) =>
    ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .first(),
  );
  expect(binding!.quick_pin_fail_count).toBe(0);
  expect(binding!.quick_pin_locked_until == null).toBe(true);
});

// ── (d) expired / foreign-device token rejected (REMEMBER_INVALID) ───────────

test("quickPinLogin rejects a foreign-device token (REMEMBER_INVALID, no oracle)", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-FOREIGN" });
  const sessionId = await seedCockpitSession(t, ownerId, "phone-G");
  const { rememberToken } = await t.action(
    api.auth.ownerActions.registerRememberedDevice,
    { idempotencyKey: "reg-foreign", sessionId, deviceId: "phone-G", quickPin: "3333" },
  );

  // Correct PIN + correct token but the WRONG device → generic REMEMBER_INVALID.
  await expect(
    t.action(api.auth.ownerActions.quickPinLogin, {
      idempotencyKey: "qpl-foreign",
      deviceId: "phone-OTHER",
      rememberToken,
      quickPin: "3333",
    }),
  ).rejects.toThrow("REMEMBER_INVALID");
});

test("quickPinLogin rejects an expired remember token (REMEMBER_INVALID)", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-EXP" });
  const sessionId = await seedCockpitSession(t, ownerId, "phone-H");
  const { rememberToken } = await t.action(
    api.auth.ownerActions.registerRememberedDevice,
    { idempotencyKey: "reg-exp", sessionId, deviceId: "phone-H", quickPin: "4444" },
  );
  const tokenHash = await sha256Hex(rememberToken);

  // Force the binding into the past.
  await t.run(async (ctx) => {
    const b = await ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .first();
    await ctx.db.patch(b!._id, { expires_at: Date.now() - 1000 });
  });

  await expect(
    t.action(api.auth.ownerActions.quickPinLogin, {
      idempotencyKey: "qpl-exp",
      deviceId: "phone-H",
      rememberToken,
      quickPin: "4444",
    }),
  ).rejects.toThrow("REMEMBER_INVALID");
});

test("quickPinLogin rejects an unknown remember token (REMEMBER_INVALID)", async () => {
  const t = convexTest(schema);
  await seedOwner(t, { code: "S-GHOST2" });
  await expect(
    t.action(api.auth.ownerActions.quickPinLogin, {
      idempotencyKey: "qpl-ghost",
      deviceId: "phone-X",
      rememberToken: "not-a-real-token-aaaaaaaaaaaaaaaaaaaa",
      quickPin: "1234",
    }),
  ).rejects.toThrow("REMEMBER_INVALID");
});

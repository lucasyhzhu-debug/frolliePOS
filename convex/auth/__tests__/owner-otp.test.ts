import { convexTest } from "convex-test";
import { expect, test, vi, beforeEach } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { argon2id } from "hash-wasm";

// requestOwnerOtp / verifyOwnerOtp are "use node" actions; sendTemplate needs a token.
beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 11 } }),
    })),
  );
});

// ── seed helpers ──────────────────────────────────────────────────────────────

async function seedOwner(
  t: ReturnType<typeof convexTest>,
  opts: { role?: "owner" | "manager"; active?: boolean; telegram?: number | null; code?: string } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "Owner",
      code: opts.code ?? "S-9000",
      pin_hash: "h",
      role: opts.role ?? "owner",
      active: opts.active ?? true,
      created_at: Date.now(),
      ...(opts.telegram === undefined
        ? { telegram_user_id: 555000 }
        : opts.telegram === null
          ? {}
          : { telegram_user_id: opts.telegram }),
    } as never),
  );
}

// Hash a 6-digit code the way the Node action does (argon2id, encoded).
async function hashCode(code: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return argon2id({
    password: code,
    salt,
    parallelism: 1,
    iterations: 2,
    memorySize: 19_456,
    hashLength: 32,
    outputType: "encoded",
  });
}

async function seedChallenge(
  t: ReturnType<typeof convexTest>,
  staffId: string,
  opts: { code?: string; expiresInMs?: number; failCount?: number } = {},
) {
  const codeHash = await hashCode(opts.code ?? "123456");
  return t.run((ctx) =>
    ctx.db.insert("owner_auth_otp", {
      staff_id: staffId as never,
      code_hash: codeHash,
      expires_at: Date.now() + (opts.expiresInMs ?? 5 * 60_000),
      fail_count: opts.failCount ?? 0,
      consumed_at: null,
      created_at: Date.now(),
      device_id: "cockpit-dev",
    } as never),
  );
}

// ── leak-free identifier resolution ─────────────────────────────────────────

test("unknown / non-owner / unbound identifier resolves to null (generic ok, no leak)", async () => {
  const t = convexTest(schema);
  await seedOwner(t, { role: "manager", code: "S-MGR" }); // manager, not owner
  await seedOwner(t, { telegram: null, code: "S-UNB" }); // owner but unbound

  // unknown code
  const r1 = await t.query(internal.auth.ownerInternal._getOwnerByIdentifier_internal, {
    identifier: "S-NOPE",
  });
  expect(r1).toBeNull();
  // manager-role code
  const r2 = await t.query(internal.auth.ownerInternal._getOwnerByIdentifier_internal, {
    identifier: "S-MGR",
  });
  expect(r2).toBeNull();
  // unbound owner (no telegram_user_id)
  const r3 = await t.query(internal.auth.ownerInternal._getOwnerByIdentifier_internal, {
    identifier: "S-UNB",
  });
  expect(r3).toBeNull();
});

test("_getOwnerByIdentifier_internal returns the owner when owner+active+bound", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-OK", telegram: 777 });
  const r = await t.query(internal.auth.ownerInternal._getOwnerByIdentifier_internal, {
    identifier: "S-OK",
  });
  expect(r?.staffId).toBe(ownerId);
  expect(r?.telegram_user_id).toBe(777);
});

// ── SEC-07 isolation ────────────────────────────────────────────────────────

test("wrong code increments fail_count and does NOT touch pos_auth_attempts (SEC-07)", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t);
  const challengeId = await seedChallenge(t, ownerId);

  await t.mutation(internal.auth.ownerInternal._recordOtpFailure_internal, {
    challengeId,
  });

  const row = await t.run((ctx) => ctx.db.get(challengeId));
  expect(row?.fail_count).toBe(1);

  // SEC-07: no booth-lockout rows for this owner.
  const booth = await t.run((ctx) =>
    ctx.db
      .query("pos_auth_attempts")
      .withIndex("by_staff", (q) => q.eq("staff_id", ownerId))
      .collect(),
  );
  expect(booth.length).toBe(0);
});

test("5 misses consume the challenge", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t);
  const challengeId = await seedChallenge(t, ownerId);

  for (let i = 0; i < 5; i++) {
    await t.mutation(internal.auth.ownerInternal._recordOtpFailure_internal, {
      challengeId,
    });
  }
  const row = await t.run((ctx) => ctx.db.get(challengeId));
  expect(row?.fail_count).toBe(5);
  expect(row?.consumed_at).not.toBeNull();
});

// ── rate limit ───────────────────────────────────────────────────────────────

test("rate limit: 4th request within 15 min throws OTP_COOLDOWN", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t);

  await t.mutation(internal.auth.ownerInternal._checkOtpRateLimit_internal, { staffId: ownerId });
  await t.mutation(internal.auth.ownerInternal._checkOtpRateLimit_internal, { staffId: ownerId });
  await t.mutation(internal.auth.ownerInternal._checkOtpRateLimit_internal, { staffId: ownerId });
  await expect(
    t.mutation(internal.auth.ownerInternal._checkOtpRateLimit_internal, { staffId: ownerId }),
  ).rejects.toThrow(/OTP_COOLDOWN:\d+/);

  // SEC-07: rate-limit lives in owner_auth_attempts, never pos_auth_attempts.
  const booth = await t.run((ctx) =>
    ctx.db
      .query("pos_auth_attempts")
      .withIndex("by_staff", (q) => q.eq("staff_id", ownerId))
      .collect(),
  );
  expect(booth.length).toBe(0);
});

// ── cockpit session commit ───────────────────────────────────────────────────

test("_cockpitLoginCommit_internal mints a cockpit session with NO outlet_id", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t);

  const res = await t.mutation(internal.auth.ownerInternal._cockpitLoginCommit_internal, {
    idempotencyKey: "ck1:commit",
    staffId: ownerId,
    deviceId: "cockpit-dev",
  });
  expect(res.role).toBe("owner");

  const session = await t.run((ctx) => ctx.db.get(res.sessionId));
  expect(session?.kind).toBe("cockpit");
  expect(session?.outlet_id).toBeUndefined();
  expect(session?.ended_at).toBeNull();
  expect(session?.staff_id).toBe(ownerId);

  // owner.login audit row, source system.
  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(audit.some((r) => r.action === "owner.login" && r.source === "system")).toBe(true);
});

// ── full request/verify happy path + C3 redaction ────────────────────────────

test("verifyOwnerOtp mints a cockpit session on the correct code", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-VOK", telegram: 8001 });
  await seedChallenge(t, ownerId, { code: "654321" });

  const res = await t.action(api.auth.ownerActions.verifyOwnerOtp, {
    idempotencyKey: "vk1",
    identifier: "S-VOK",
    code: "654321",
    deviceId: "cockpit-dev",
  });
  expect(res.role).toBe("owner");
  const session = await t.run((ctx) => ctx.db.get(res.sessionId));
  expect(session?.kind).toBe("cockpit");
  expect(session?.outlet_id).toBeUndefined();
});

test("verifyOwnerOtp from a DIFFERENT device throws generic OTP_INVALID even with the correct code (ADR-052 #11)", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-VDEV", telegram: 8005 });
  // Challenge is bound to "cockpit-dev" by seedChallenge.
  const challengeId = await seedChallenge(t, ownerId, { code: "424242" });

  await expect(
    t.action(api.auth.ownerActions.verifyOwnerOtp, {
      idempotencyKey: "vk-dev",
      identifier: "S-VDEV",
      code: "424242", // correct code, wrong device
      deviceId: "some-other-device",
    }),
  ).rejects.toThrow("OTP_INVALID");

  // A device mismatch is NOT a code guess — fail_count must stay 0 and the
  // challenge stays live (the owner can still verify on the right device).
  const row = await t.run((ctx) => ctx.db.get(challengeId));
  expect(row!.fail_count).toBe(0);
  expect(row!.consumed_at).toBeNull();
});

test("verifyOwnerOtp on a wrong code throws OTP_INVALID and bumps fail_count", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-VBAD", telegram: 8002 });
  const challengeId = await seedChallenge(t, ownerId, { code: "111111" });

  await expect(
    t.action(api.auth.ownerActions.verifyOwnerOtp, {
      idempotencyKey: "vk2",
      identifier: "S-VBAD",
      code: "000000",
      deviceId: "cockpit-dev",
    }),
  ).rejects.toThrow("OTP_INVALID");

  const row = await t.run((ctx) => ctx.db.get(challengeId));
  expect(row?.fail_count).toBe(1);
});

test("verifyOwnerOtp on an unknown identifier throws generic OTP_INVALID (no leak)", async () => {
  const t = convexTest(schema);
  await expect(
    t.action(api.auth.ownerActions.verifyOwnerOtp, {
      idempotencyKey: "vk3",
      identifier: "S-GHOST",
      code: "123456",
      deviceId: "cockpit-dev",
    }),
  ).rejects.toThrow("OTP_INVALID");
});

test("requestOwnerOtp returns generic { ok: true } for an unknown identifier (no enumeration)", async () => {
  const t = convexTest(schema);
  const res = await t.action(api.auth.ownerActions.requestOwnerOtp, {
    idempotencyKey: "rk0",
    identifier: "S-GHOST",
    deviceId: "cockpit-dev",
  });
  expect(res).toEqual({ ok: true });
  // No challenge minted for a non-owner.
  const otps = await t.run((ctx) => ctx.db.query("owner_auth_otp").collect());
  expect(otps.length).toBe(0);
});

test("requestOwnerOtp mints a challenge + sends a DM; C3: no 6-digit code in telegram_log", async () => {
  const t = convexTest(schema);
  const ownerId = await seedOwner(t, { code: "S-REQ", telegram: 9001 });

  const res = await t.action(api.auth.ownerActions.requestOwnerOtp, {
    idempotencyKey: "rk1",
    identifier: "S-REQ",
    deviceId: "cockpit-dev",
  });
  expect(res).toEqual({ ok: true });

  // A challenge was minted for the owner.
  const otps = await t.run((ctx) =>
    ctx.db
      .query("owner_auth_otp")
      .withIndex("by_staff_active", (q) => q.eq("staff_id", ownerId).eq("consumed_at", null))
      .collect(),
  );
  expect(otps.length).toBe(1);

  // C3: the outbound telegram_log row for owner_otp must NOT contain the code.
  const logs = await t.run((ctx) => ctx.db.query("telegram_log").collect());
  const otpLog = logs.find((l) => l.template_kind === "owner_otp");
  expect(otpLog).toBeDefined();
  expect(otpLog!.payload_json).toContain("[redacted owner_otp]");
  // No 6-digit run anywhere in the persisted payload.
  expect(/\d{6}/.test(otpLog!.payload_json)).toBe(false);
});

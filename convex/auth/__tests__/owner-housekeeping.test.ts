/**
 * Task 6 TDD: owner-auth housekeeping + setStaffRole "owner" extension.
 */
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

// ── seed helpers ──────────────────────────────────────────────────────────────

async function seedOtp(
  t: ReturnType<typeof convexTest>,
  staffId: string,
  opts: {
    expiresAt?: number;
    consumedAt?: number | null;
  } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("owner_auth_otp", {
      staff_id: staffId as never,
      code_hash: "hashed",
      expires_at: opts.expiresAt ?? Date.now() + 5 * 60_000,
      fail_count: 0,
      consumed_at: opts.consumedAt === undefined ? null : (opts.consumedAt as number | null),
      created_at: Date.now(),
      device_id: "cockpit-dev",
    } as never),
  );
}

async function seedBinding(
  t: ReturnType<typeof convexTest>,
  staffId: string,
  opts: {
    expiresAt?: number;
    redeemedAt?: number | null;
  } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("owner_auth_bindings", {
      kind: "remember_device",
      staff_id: staffId as never,
      token_hash: `th-${Math.random()}`,
      expires_at: opts.expiresAt ?? Date.now() + 30 * 24 * 60 * 60_000,
      redeemed_at: opts.redeemedAt === undefined ? null : (opts.redeemedAt as number | null),
      created_at: Date.now(),
    } as never),
  );
}

async function seedOwner(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "Owner",
      code: `S-${Math.floor(Math.random() * 9000) + 1000}`,
      pin_hash: "h",
      role: "owner",
      active: true,
      created_at: Date.now(),
    } as never),
  );
}

// ── (a) _purgeOwnerAuthHousekeeping_internal ─────────────────────────────────

describe("_purgeOwnerAuthHousekeeping_internal", () => {
  it("removes expired OTPs (expires_at < now)", async () => {
    const t = convexTest(schema);
    const ownerId = await seedOwner(t);

    // Expired OTP: expires_at 1ms in the past
    await seedOtp(t, ownerId, { expiresAt: Date.now() - 1 });

    await t.mutation(
      internal.auth.internal._purgeOwnerAuthHousekeeping_internal,
      {},
    );

    const remaining = await t.run((ctx) =>
      ctx.db.query("owner_auth_otp").collect(),
    );
    expect(remaining).toHaveLength(0);
  });

  it("removes consumed OTPs (consumed_at != null)", async () => {
    const t = convexTest(schema);
    const ownerId = await seedOwner(t);

    // Still-valid TTL but consumed
    await seedOtp(t, ownerId, {
      expiresAt: Date.now() + 5 * 60_000,
      consumedAt: Date.now() - 1_000,
    });

    await t.mutation(
      internal.auth.internal._purgeOwnerAuthHousekeeping_internal,
      {},
    );

    const remaining = await t.run((ctx) =>
      ctx.db.query("owner_auth_otp").collect(),
    );
    expect(remaining).toHaveLength(0);
  });

  it("removes expired bindings (expires_at < now)", async () => {
    const t = convexTest(schema);
    const ownerId = await seedOwner(t);

    await seedBinding(t, ownerId, { expiresAt: Date.now() - 1 });

    await t.mutation(
      internal.auth.internal._purgeOwnerAuthHousekeeping_internal,
      {},
    );

    const remaining = await t.run((ctx) =>
      ctx.db.query("owner_auth_bindings").collect(),
    );
    expect(remaining).toHaveLength(0);
  });

  it("removes redeemed bindings (redeemed_at != null)", async () => {
    const t = convexTest(schema);
    const ownerId = await seedOwner(t);

    await seedBinding(t, ownerId, {
      expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
      redeemedAt: Date.now() - 1_000,
    });

    await t.mutation(
      internal.auth.internal._purgeOwnerAuthHousekeeping_internal,
      {},
    );

    const remaining = await t.run((ctx) =>
      ctx.db.query("owner_auth_bindings").collect(),
    );
    expect(remaining).toHaveLength(0);
  });

  it("LEAVES live (unexpired + unconsumed) OTPs untouched", async () => {
    const t = convexTest(schema);
    const ownerId = await seedOwner(t);

    // Live: future expires_at, not consumed
    await seedOtp(t, ownerId, {
      expiresAt: Date.now() + 5 * 60_000,
      consumedAt: null,
    });

    await t.mutation(
      internal.auth.internal._purgeOwnerAuthHousekeeping_internal,
      {},
    );

    const remaining = await t.run((ctx) =>
      ctx.db.query("owner_auth_otp").collect(),
    );
    expect(remaining).toHaveLength(1);
  });

  it("LEAVES live (unexpired + unredeemed) bindings untouched", async () => {
    const t = convexTest(schema);
    const ownerId = await seedOwner(t);

    // Live: future expires_at, not redeemed
    await seedBinding(t, ownerId, {
      expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
      redeemedAt: null,
    });

    await t.mutation(
      internal.auth.internal._purgeOwnerAuthHousekeeping_internal,
      {},
    );

    const remaining = await t.run((ctx) =>
      ctx.db.query("owner_auth_bindings").collect(),
    );
    expect(remaining).toHaveLength(1);
  });

  it("handles mixed bag: removes stale, keeps live (OTPs + bindings together)", async () => {
    const t = convexTest(schema);
    const ownerId = await seedOwner(t);

    // OTPs
    await seedOtp(t, ownerId, { expiresAt: Date.now() - 1 });           // expired → delete
    await seedOtp(t, ownerId, { expiresAt: Date.now() + 5 * 60_000, consumedAt: Date.now() - 10 }); // consumed → delete
    await seedOtp(t, ownerId, { expiresAt: Date.now() + 5 * 60_000, consumedAt: null }); // live → keep

    // Bindings
    await seedBinding(t, ownerId, { expiresAt: Date.now() - 1 });       // expired → delete
    await seedBinding(t, ownerId, { redeemedAt: Date.now() - 10 });     // redeemed → delete
    await seedBinding(t, ownerId, { expiresAt: Date.now() + 30 * 24 * 60 * 60_000, redeemedAt: null }); // live → keep

    await t.mutation(
      internal.auth.internal._purgeOwnerAuthHousekeeping_internal,
      {},
    );

    const otps = await t.run((ctx) => ctx.db.query("owner_auth_otp").collect());
    expect(otps).toHaveLength(1);
    expect(otps[0].consumed_at).toBeNull();

    const bindings = await t.run((ctx) => ctx.db.query("owner_auth_bindings").collect());
    expect(bindings).toHaveLength(1);
    expect(bindings[0].redeemed_at).toBeNull();
  });
});

// ── (b) setStaffRole accepts "owner" end-to-end ──────────────────────────────

describe("staff.actions.setStaffRole — owner role", () => {
  it("promotes a staff member to owner via manager PIN", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);

    // Seed a plain staff member to promote
    const staffId = await t.run((ctx) =>
      ctx.db.insert("staff", {
        name: "Lucas Owner",
        code: "S-9000",
        pin_hash: "h",
        role: "staff",
        active: true,
        created_at: Date.now(),
      } as never),
    );

    await t.action(api.staff.actions.setStaffRole, {
      idempotencyKey: "owner-promo-1",
      sessionId,
      staffId,
      role: "owner",
      managerPin: "9999",
    });

    const row = await t.run((ctx) => ctx.db.get(staffId));
    expect(row?.role).toBe("owner");
  });

  it("persists role:owner in the staff row after commit (from manager role)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);

    const staffId = await t.run((ctx) =>
      ctx.db.insert("staff", {
        name: "Second Owner",
        code: "S-9001",
        pin_hash: "h",
        role: "manager",
        active: true,
        created_at: Date.now(),
      } as never),
    );

    await t.action(api.staff.actions.setStaffRole, {
      idempotencyKey: "owner-promo-2",
      sessionId,
      staffId,
      role: "owner",
      managerPin: "9999",
    });

    const row = await t.run((ctx) => ctx.db.get(staffId));
    expect(row?.role).toBe("owner");
  });
});

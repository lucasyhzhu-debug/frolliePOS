import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

async function seedOutlet(t: ReturnType<typeof convexTest>): Promise<Id<"outlets">> {
  return await t.run((ctx) =>
    ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any),
  );
}

async function seedStaff(t: ReturnType<typeof convexTest>): Promise<Id<"staff">> {
  return await t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "Test Staff",
      code: "S-T1",
      pin_hash: "x",
      role: "staff",
      active: true,
      created_at: Date.now(),
    }),
  );
}

async function seedManager(t: ReturnType<typeof convexTest>): Promise<Id<"staff">> {
  return await t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "Manager",
      code: "M-01",
      pin_hash: "x",
      role: "manager",
      active: true,
      created_at: Date.now(),
    }),
  );
}

describe("getRecentPinResetForStaff", () => {
  it("returns null when no rows exist for staff", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t);
    const result = await t.query(api.approvals.public.getRecentPinResetForStaff, { staffId });
    expect(result).toBeNull();
  });

  it("returns null for a pending row outside the recency window", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_approval_requests", {
        kind: "staff_pin_reset",
        subject_staff_id: staffId,
        triggered_by_event: "lockout",
        triggered_at: Date.now() - 11 * 60 * 1000, // > 10 min ago
        token_hash: "h-old",
        token_expires_at: Date.now() - 60_000,
        status: "pending",
        notification_channel: "telegram",
        outlet_id: outletId,
      } as any);
    });
    const result = await t.query(api.approvals.public.getRecentPinResetForStaff, { staffId });
    expect(result).toBeNull();
  });

  it("returns pending for a pending row within the window", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_approval_requests", {
        kind: "staff_pin_reset",
        subject_staff_id: staffId,
        triggered_by_event: "lockout",
        triggered_at: Date.now() - 60_000,
        token_hash: "h-pending",
        token_expires_at: Date.now() + 60_000,
        status: "pending",
        notification_channel: "telegram",
        outlet_id: outletId,
      } as any);
    });
    const result = await t.query(api.approvals.public.getRecentPinResetForStaff, { staffId });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("pending");
  });

  it("excludes resolved rows within the window", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t);
    const managerId = await seedManager(t);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_approval_requests", {
        kind: "staff_pin_reset",
        subject_staff_id: staffId,
        triggered_by_event: "lockout",
        triggered_at: Date.now() - 60_000,
        token_hash: "h-resolved",
        token_expires_at: Date.now() + 60_000,
        status: "resolved",
        resolved_at: Date.now(),
        resolved_by_manager_id: managerId,
        notification_channel: "telegram",
        outlet_id: outletId,
      } as any);
    });
    const result = await t.query(api.approvals.public.getRecentPinResetForStaff, { staffId });
    expect(result).toBeNull();
  });

  it("returns denied (not null) for a denied row within the window", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_approval_requests", {
        kind: "staff_pin_reset",
        subject_staff_id: staffId,
        triggered_by_event: "lockout",
        triggered_at: Date.now() - 60_000,
        token_hash: "h-denied",
        token_expires_at: Date.now() + 60_000,
        status: "denied",
        denied_at: Date.now() - 30_000,
        notification_channel: "telegram",
        outlet_id: outletId,
      } as any);
    });
    const result = await t.query(api.approvals.public.getRecentPinResetForStaff, { staffId });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("denied");
  });

  it("skips resolved, returns pending when both exist within window", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t);
    const managerId = await seedManager(t);
    const outletId = await seedOutlet(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      // resolved row — older
      await ctx.db.insert("pos_approval_requests", {
        kind: "staff_pin_reset",
        subject_staff_id: staffId,
        triggered_by_event: "lockout",
        triggered_at: now - 5 * 60 * 1000,
        token_hash: "h-resolved-2",
        token_expires_at: now + 60_000,
        status: "resolved",
        resolved_at: now - 4 * 60 * 1000,
        resolved_by_manager_id: managerId,
        notification_channel: "telegram",
        outlet_id: outletId,
      } as any);
      // pending row — newer
      await ctx.db.insert("pos_approval_requests", {
        kind: "staff_pin_reset",
        subject_staff_id: staffId,
        triggered_by_event: "lockout",
        triggered_at: now - 60_000,
        token_hash: "h-pending-2",
        token_expires_at: now + 60_000,
        status: "pending",
        notification_channel: "telegram",
        outlet_id: outletId,
      } as any);
    });
    const result = await t.query(api.approvals.public.getRecentPinResetForStaff, { staffId });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("pending");
  });
});

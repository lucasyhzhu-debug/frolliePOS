import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

async function seedStaff(t: ReturnType<typeof convexTest>): Promise<{
  staffId: Id<"staff">;
  mgrId: Id<"staff">;
}> {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Lucy",
      pin_hash: "old-hash",
      role: "staff",
      active: true,
      created_at: Date.now(),
    });
    const mgrId = await ctx.db.insert("staff", {
      name: "Lucas",
      pin_hash: "mgr-hash",
      role: "manager",
      active: true,
      created_at: Date.now(),
    });
    return { staffId, mgrId };
  });
}

describe("_createRequest_internal", () => {
  it("inserts a pending row with token_hash + token_expires_at (60-min) and returns {requestId}", async () => {
    const t = convexTest(schema);
    const { staffId } = await seedStaff(t);

    const now = Date.now();
    const result = await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "staff_pin_reset",
      subject_staff_id: staffId,
      triggered_by_event: "auth_lockout",
      triggered_at: now,
      token_hash: "abc123hash",
      token_expires_at: now + 60 * 60 * 1000,
    });

    expect(result).toHaveProperty("requestId");

    const row = await t.run((ctx) => ctx.db.get(result.requestId));
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.token_hash).toBe("abc123hash");
    expect(row!.token_expires_at).toBe(now + 60 * 60 * 1000);
    expect(row!.kind).toBe("staff_pin_reset");
    expect(row!.subject_staff_id).toBe(staffId);
    expect(row!.notified_at).toBeUndefined();
    expect(row!.resolved_at).toBeUndefined();
  });
});

describe("_markNotified_internal", () => {
  it("sets notified_at (truthy) on an existing approval request", async () => {
    const t = convexTest(schema);
    const { staffId } = await seedStaff(t);

    const now = Date.now();
    const { requestId } = await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "staff_pin_reset",
      subject_staff_id: staffId,
      triggered_by_event: "auth_lockout",
      triggered_at: now,
      token_hash: "notify-hash",
      token_expires_at: now + 60 * 60 * 1000,
    });

    await t.mutation(internal.approvals.internal._markNotified_internal, { requestId });

    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row!.notified_at).toBeTruthy();
    expect(typeof row!.notified_at).toBe("number");
  });
});

describe("_markResolved_internal", () => {
  it("flips status to 'resolved', sets resolved_by_manager_id and resolved_at", async () => {
    const t = convexTest(schema);
    const { staffId, mgrId } = await seedStaff(t);

    const now = Date.now();
    const { requestId } = await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "staff_pin_reset",
      subject_staff_id: staffId,
      triggered_by_event: "auth_lockout",
      triggered_at: now,
      token_hash: "resolve-hash",
      token_expires_at: now + 60 * 60 * 1000,
    });

    const r = await t.mutation(internal.approvals.internal._markResolved_internal, {
      idempotencyKey: "k-markresolved",
      requestId,
      resolved_by_manager_id: mgrId,
    });
    expect(r.resolved).toBe(true);

    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row!.status).toBe("resolved");
    expect(row!.resolved_by_manager_id).toBe(mgrId);
    expect(row!.resolved_at).toBeTruthy();
    expect(typeof row!.resolved_at).toBe("number");
  });
});

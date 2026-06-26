import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

async function seedOutlet(t: ReturnType<typeof convexTest>): Promise<Id<"outlets">> {
  return await t.run((ctx) =>
    ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any),
  );
}

async function seedStaff(t: ReturnType<typeof convexTest>): Promise<{
  staffId: Id<"staff">;
  mgrId: Id<"staff">;
}> {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Lucy",
      code: "S-0001",
      pin_hash: "old-hash",
      role: "staff",
      active: true,
      created_at: Date.now(),
    });
    const mgrId = await ctx.db.insert("staff", {
      name: "Lucas",
      code: "S-0002",
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
    const outletId = await seedOutlet(t);

    const now = Date.now();
    const result = await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "staff_pin_reset",
      subject_staff_id: staffId,
      triggered_by_event: "auth_lockout",
      triggered_at: now,
      token_hash: "abc123hash",
      token_expires_at: now + 60 * 60 * 1000,
      outletId,
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

describe("_createRequest_internal — manual_payment_override", () => {
  it("creates a manual_payment_override request and validates context", async () => {
    const t = convexTest(schema);
    const staff = await t.run((ctx) =>
      ctx.db.insert("staff", {
        name: "L",
        code: "S-0001",
        role: "manager",
        active: true,
        pin_hash: "x",
        created_at: Date.now(),
      }),
    );
    const outletId = await seedOutlet(t);
    const { requestId } = await t.mutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "manual_payment_override",
        requester_staff_id: staff,
        entity_type: "pos_transactions",
        entity_id: "txn_1",
        context: { txn_id: "txn_1", amount_idr: 50000, reason: "BCA cleared" },
        reason: "BCA cleared",
        triggered_by_event: "manual_payment_request",
        triggered_at: Date.now(),
        token_hash: "abc",
        token_expires_at: Date.now() + 3600_000,
        outletId,
      },
    );
    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row?.context).toMatchObject({ txn_id: "txn_1", amount_idr: 50000 });
  });

  it("rejects an invalid manual_payment context (non-integer amount_idr)", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    await expect(
      t.mutation(internal.approvals.internal._createRequest_internal, {
        kind: "manual_payment_override",
        entity_type: "pos_transactions",
        entity_id: "t1",
        context: { txn_id: "t1", amount_idr: 1.5, reason: "x" }, // non-integer
        triggered_by_event: "x",
        triggered_at: Date.now(),
        token_hash: "h",
        token_expires_at: Date.now() + 1,
        outletId,
      }),
    ).rejects.toThrow(/CONTEXT_INVALID/);
  });
});

describe("_markNotified_internal", () => {
  it("sets notified_at (truthy) on an existing approval request", async () => {
    const t = convexTest(schema);
    const { staffId } = await seedStaff(t);
    const outletId = await seedOutlet(t);

    const now = Date.now();
    const { requestId } = await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "staff_pin_reset",
      subject_staff_id: staffId,
      triggered_by_event: "auth_lockout",
      triggered_at: now,
      token_hash: "notify-hash",
      token_expires_at: now + 60 * 60 * 1000,
      outletId,
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
    const outletId = await seedOutlet(t);

    const now = Date.now();
    const { requestId } = await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "staff_pin_reset",
      subject_staff_id: staffId,
      triggered_by_event: "auth_lockout",
      triggered_at: now,
      token_hash: "resolve-hash",
      token_expires_at: now + 60 * 60 * 1000,
      outletId,
    });

    const r = await t.mutation(internal.approvals.internal._markResolved_internal, {
      idempotencyKey: "k-markresolved",
      requestId,
      resolved_by_manager_id: mgrId,
      source: "telegram_approval",
    });
    expect(r.resolved).toBe(true);

    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row!.status).toBe("resolved");
    expect(row!.resolved_by_manager_id).toBe(mgrId);
    expect(row!.resolved_at).toBeTruthy();
    expect(typeof row!.resolved_at).toBe("number");
  });
});

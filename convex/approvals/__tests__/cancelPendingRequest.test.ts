import { describe, test, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

// Seed a manager session: inserts a staff row with role="manager" and a live
// session. Returns staffId (manager) and sessionId.
async function seedManagerSession(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const outletId = await (ctx.db as any).insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    });
    const managerId = await ctx.db.insert("staff", {
      name: "Manager",
      code: "M-1",
      role: "manager",
      active: true,
      pin_hash: "x",
      created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: managerId,
      device_id: "d1",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    } as any);
    return { managerId, sessionId };
  });
}

// Seed a non-manager (staff role) session.
async function seedStaffSession(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const outletId = await (ctx.db as any).insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Cashier",
      code: "S-1",
      role: "staff",
      active: true,
      pin_hash: "x",
      created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: "d2",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    } as any);
    return { staffId, sessionId };
  });
}

// Insert a minimal pending approval request.
async function seedPendingRequest(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    // Reuse existing outlet if already seeded by seedManagerSession/seedStaffSession.
    const outlets = await (ctx.db as any).query("outlets").collect();
    const outletId =
      outlets[0]?._id ??
      (await (ctx.db as any).insert("outlets", { is_open: false,
        code: "PKW", name: "x", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      }));
    return await (ctx.db as any).insert("pos_approval_requests", {
      kind: "manual_payment_override",
      triggered_by_event: "test",
      triggered_at: Date.now(),
      token_hash: "h",
      token_expires_at: Date.now() + 60_000,
      status: "pending",
      notification_channel: "telegram",
      entity_type: "pos_transactions",
      entity_id: "fake-txn",
      context: { txn_id: "fake-txn", amount_idr: 50_000, reason: "test" },
      outlet_id: outletId,
    });
  });
}

describe("cancelPendingRequest", () => {
  test("manager cancels a pending request → status=denied, reason recorded", async () => {
    const t = convexTest(schema);
    const { managerId, sessionId } = await seedManagerSession(t);
    const requestId = await seedPendingRequest(t);

    const result = await t.mutation(api.approvals.public.cancelPendingRequest, {
      sessionId,
      requestId,
      reason: "test-cancel",
      idempotencyKey: "ck-1",
    });

    expect(result).toEqual({ denied: true });

    const row = await t.run(async (ctx) => ctx.db.get(requestId)) as any;
    expect(row?.status).toBe("denied");
    expect(row?.denied_by_manager_id).toBe(managerId);
    expect(row?.deny_reason).toBe("test-cancel");

    // Verify audit row records source: "booth_inline" (manager UI), not "system" (auto-deny)
    const audits = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("entity_id"), requestId)).collect()
    );
    const denyAudit = audits.find((a) => a.action.endsWith(".denied"));
    expect(denyAudit?.source).toBe("booth_inline");
    expect(denyAudit?.actor_id).toBe(managerId);
  });

  test("non-manager session is rejected with MANAGER_ONLY", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedStaffSession(t);
    const requestId = await seedPendingRequest(t);

    await expect(
      t.mutation(api.approvals.public.cancelPendingRequest, {
        sessionId,
        requestId,
        reason: "should not work",
        idempotencyKey: "ck-non-mgr",
      }),
    ).rejects.toThrow("MANAGER_ONLY");
  });

  test("idempotency replay returns same response without re-denying", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const requestId = await seedPendingRequest(t);

    const r1 = await t.mutation(api.approvals.public.cancelPendingRequest, {
      sessionId,
      requestId,
      reason: "test-cancel-replay",
      idempotencyKey: "ck-replay",
    });

    const r2 = await t.mutation(api.approvals.public.cancelPendingRequest, {
      sessionId,
      requestId,
      reason: "test-cancel-replay",
      idempotencyKey: "ck-replay",
    });

    expect(r2).toEqual(r1);

    // Only one manual_payment_override.denied audit row — no double-execution.
    const deniedAudits = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "manual_payment_override.denied"))
        .collect(),
    );
    expect(deniedAudits.length).toBe(1);
  });
});

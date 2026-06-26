import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";

it("accepts a manual_payment_override request with entity + denied lifecycle fields", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any);
    const staff = await ctx.db.insert("staff", {
      name: "L", code: "S-0001", role: "manager", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    const id = await ctx.db.insert("pos_approval_requests", {
      kind: "manual_payment_override",
      requester_staff_id: staff,
      entity_type: "pos_transactions",
      entity_id: "txn_123",
      context: { txn_id: "txn_123", amount_idr: 50000, reason: "BCA cleared" },
      reason: "BCA cleared",
      triggered_by_event: "manual_payment_request",
      triggered_at: Date.now(),
      token_hash: "deadbeef",
      token_expires_at: Date.now() + 3600_000,
      status: "pending",
      outlet_id: outletId,
    } as any);
    const row = await ctx.db.get(id);
    expect(row?.kind).toBe("manual_payment_override");
    expect(row?.entity_id).toBe("txn_123");
  });
});

it("failed_pin_attempts optional field round-trips", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any);
    return await ctx.db.insert("pos_approval_requests", {
      kind: "manual_payment_override",
      triggered_by_event: "test",
      triggered_at: Date.now(),
      token_hash: "deadbeef",
      token_expires_at: Date.now() + 60_000,
      status: "pending",
      notification_channel: "telegram",
      failed_pin_attempts: 3,
      outlet_id: outletId,
    } as any);
  });
  const row = await t.run(async (ctx) => ctx.db.get(id));
  expect(row?.failed_pin_attempts).toBe(3);
});

it("denied_by_manager_id accepts 'system' literal", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any);
    return await ctx.db.insert("pos_approval_requests", {
      kind: "staff_pin_reset",
      triggered_by_event: "test",
      triggered_at: Date.now(),
      token_hash: "deadbeef2",
      token_expires_at: Date.now() + 60_000,
      status: "denied",
      notification_channel: "telegram",
      denied_at: Date.now(),
      denied_by_manager_id: "system",
      deny_reason: "too_many_pin_attempts",
      outlet_id: outletId,
    } as any);
  });
  const row = await t.run(async (ctx) => ctx.db.get(id));
  expect(row?.denied_by_manager_id).toBe("system");
});

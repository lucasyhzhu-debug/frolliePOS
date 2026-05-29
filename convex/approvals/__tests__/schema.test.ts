import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";

it("accepts a manual_payment_override request with entity + denied lifecycle fields", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
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
    });
    const row = await ctx.db.get(id);
    expect(row?.kind).toBe("manual_payment_override");
    expect(row?.entity_id).toBe("txn_123");
  });
});

import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedPending(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const mgr = await ctx.db.insert("staff", { name: "M", code: "S-9", role: "manager", active: true, pin_hash: "x", created_at: Date.now() });
    const req = await ctx.db.insert("pos_approval_requests", {
      kind: "manual_payment_override", entity_type: "pos_transactions", entity_id: "t1",
      context: { txn_id: "t1", amount_idr: 5, reason: "r" }, triggered_by_event: "x",
      triggered_at: Date.now(), token_hash: "h", token_expires_at: Date.now() + 3600_000, status: "pending",
    });
    return { mgr, req };
  });
}

it("_markDenied_internal sets denied lifecycle + audits", async () => {
  const t = convexTest(schema);
  const { mgr, req } = await seedPending(t);
  await t.mutation(internal.approvals.internal._markDenied_internal, {
    idempotencyKey: "k1", requestId: req, denied_by_manager_id: mgr, deny_reason: "looks fraudulent",
  });
  const row = await t.run((ctx) => ctx.db.get(req));
  expect(row?.status).toBe("denied");
  expect(row?.deny_reason).toBe("looks fraudulent");
});

it("_listPendingByKind_internal returns live rows for (kind, entity_id)", async () => {
  const t = convexTest(schema);
  await seedPending(t);
  const rows = await t.query(internal.approvals.internal._listPendingByKind_internal, {
    kind: "manual_payment_override", entityId: "t1",
  });
  expect(rows.length).toBe(1);
});

it("_linkTelegramMessage_internal patches message id (best-effort)", async () => {
  const t = convexTest(schema);
  const { req } = await seedPending(t);
  await t.mutation(internal.approvals.internal._linkTelegramMessage_internal, {
    requestId: req, messageId: 42, chatId: "-1001",
  });
  const row = await t.run((ctx) => ctx.db.get(req));
  expect(row?.telegram_message_id).toBe(42);
});

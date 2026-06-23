import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedPending(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any);
    const mgr = await ctx.db.insert("staff", { name: "M", code: "S-9", role: "manager", active: true, pin_hash: "x", created_at: Date.now() });
    const req = await ctx.db.insert("pos_approval_requests", {
      kind: "manual_payment_override", entity_type: "pos_transactions", entity_id: "t1",
      context: { txn_id: "t1", amount_idr: 5, reason: "r" }, triggered_by_event: "x",
      triggered_at: Date.now(), token_hash: "h", token_expires_at: Date.now() + 3600_000, status: "pending",
      outlet_id: outletId,
    } as any);
    return { mgr, req, outletId };
  });
}

it("_markDenied_internal sets denied lifecycle + audits", async () => {
  const t = convexTest(schema);
  const { mgr, req } = await seedPending(t);
  await t.mutation(internal.approvals.internal._markDenied_internal, {
    idempotencyKey: "k1",
    requestId: req,
    denied_by_manager_id: mgr,
    deny_reason: "looks fraudulent",
    source: "telegram_approval",
  });
  const row = await t.run((ctx) => ctx.db.get(req));
  expect(row?.status).toBe("denied");
  expect(row?.deny_reason).toBe("looks fraudulent");

  // Source must thread through to the audit row (Fix I-5: symmetric to
  // _markResolved_internal — denied no longer hardcodes telegram_approval).
  const denyAudit = await t.run((ctx) =>
    ctx.db
      .query("audit_log")
      .filter((q) => q.eq(q.field("entity_id"), req))
      .filter((q) => q.eq(q.field("action"), "manual_payment_override.denied"))
      .first(),
  );
  expect(denyAudit?.source).toBe("telegram_approval");
});

it("_listPendingByKind_internal returns live rows for (kind, entity_id)", async () => {
  const t = convexTest(schema);
  const { outletId } = await seedPending(t);
  const rows = await t.query(internal.approvals.internal._listPendingByKind_internal, {
    kind: "manual_payment_override", entityId: "t1", outletId,
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

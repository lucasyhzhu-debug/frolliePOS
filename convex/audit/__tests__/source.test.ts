import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

it("accepts both wa_approval (legacy) and telegram_approval (new) sources", async () => {
  const t = convexTest(schema);
  const staff = await t.run((ctx) => ctx.db.insert("staff", {
    name: "L", code: "S-0001", role: "manager", active: true, pin_hash: "x", created_at: Date.now(),
  }));
  for (const source of ["wa_approval", "telegram_approval"] as const) {
    await t.mutation(internal.audit.internal.__test_log, {
      actor_id: staff, action: "approval.resolved",
      entity_type: "pos_approval_requests", entity_id: "r1", source,
    });
  }
  const rows = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(rows.map((r) => r.source).sort()).toEqual(["telegram_approval", "wa_approval"]);
});

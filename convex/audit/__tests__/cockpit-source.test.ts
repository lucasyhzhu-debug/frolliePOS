import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

test("logAudit persists source 'cockpit'", async () => {
  const t = convexTest(schema);
  // a thin internal test-shim that calls logAudit; or assert via a mutation that uses it.
  await t.run(async (ctx) => {
    const { logAudit } = await import("../internal");
    const staffId = await ctx.db.insert("staff", {
      name: "Owner", code: "O1", role: "owner", pin_hash: "x", active: true, created_at: Date.now(),
    } as any);
    await logAudit(ctx, {
      actor_id: staffId, action: "outlet.created", entity_type: "outlets",
      entity_id: "x", source: "cockpit", metadata: { mode: "blank" },
    });
    const row = await ctx.db.query("audit_log").first();
    expect(row?.source).toBe("cockpit");
  });
});

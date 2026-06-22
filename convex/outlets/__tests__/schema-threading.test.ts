import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";

test("operational rows accept outlet_id and the by_outlet index resolves", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null });
    const staffId = await ctx.db.insert("staff", { name: "M", code: "S-0001", pin_hash: "h", role: "manager", active: true, created_at: Date.now() });
    await ctx.db.insert("pos_transactions", { status: "draft", subtotal: 0, voucher_discount: 0, total: 0, flags: 0, staff_id: staffId, created_at: Date.now(), outlet_id: outletId } as any);
    const rows = await ctx.db.query("pos_transactions").withIndex("by_outlet_status_created", (q) => q.eq("outlet_id", outletId)).collect();
    expect(rows.length).toBe(1);
  });
});

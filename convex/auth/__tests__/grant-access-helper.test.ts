import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";

test("grantOutletAccessRow inserts once, dedups on re-run", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outlet = await ctx.db.insert("outlets", { code: "O", name: "O", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const staff = await ctx.db.insert("staff", { name: "S", code: "S1", role: "staff", pin_hash: "x", active: true, created_at: 1 } as any);
    const { grantOutletAccessRow } = await import("../grantAccess");
    const a = await grantOutletAccessRow(ctx, { staffId: staff, outletId: outlet, grantedBy: staff, now: 5 });
    const b = await grantOutletAccessRow(ctx, { staffId: staff, outletId: outlet, grantedBy: staff, now: 6 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.accessId).toBe(a.accessId);
    const rows = await ctx.db.query("staff_outlet_access").withIndex("by_staff_outlet", (q) => q.eq("staff_id", staff).eq("outlet_id", outlet)).collect();
    expect(rows.length).toBe(1);
  });
});

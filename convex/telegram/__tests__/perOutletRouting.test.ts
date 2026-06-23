import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";

test("telegramChats accepts outlet_id and by_role_outlet resolves", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "Frollie — Pakuwon", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null });
    await ctx.db.insert("telegramChats", { chatId: "-100123", chatType: "supergroup", title: "Mgr PKW", role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(), outlet_id: outletId });
    const rows = await ctx.db.query("telegramChats").withIndex("by_role_outlet", (q) => q.eq("role", "managers").eq("outlet_id", outletId)).collect();
    expect(rows.length).toBe(1);
  });
});

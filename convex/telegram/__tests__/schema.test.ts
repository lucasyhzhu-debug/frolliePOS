import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";

it("registers a telegram chat and looks it up by role (prod pattern)", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("telegramChats", {
      chatId: "-1001", chatType: "supergroup", title: "Frollie · Managers",
      role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
    });
    const rows = await ctx.db.query("telegramChats")
      .withIndex("by_role", (q) => q.eq("role", "managers"))
      .collect();
    const row = rows.find((r) => r.archivedAt === undefined);
    expect(row?.chatId).toBe("-1001");
  });
});

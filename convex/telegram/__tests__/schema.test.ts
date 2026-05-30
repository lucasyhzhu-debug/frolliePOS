import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";

it("registers a telegram chat and looks it up by role+archived", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("telegramChats", {
      chatId: "-1001", chatType: "supergroup", title: "Frollie · Managers",
      role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
    });
    const row = await ctx.db.query("telegramChats")
      .withIndex("by_role_archived", (q) => q.eq("role", "managers").eq("archivedAt", undefined))
      .first();
    expect(row?.chatId).toBe("-1001");
  });
});

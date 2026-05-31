import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";

it("registers a telegram chat and looks it up by role, excluding archived (prod pattern)", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    // Seed an active row AND an archived row under the same role; the
    // JS post-filter must skip the archived one. Without the archived
    // sibling the test passes even if the .find predicate were removed.
    await ctx.db.insert("telegramChats", {
      chatId: "-999", chatType: "supergroup", title: "Frollie · Managers (old)",
      role: "managers", archivedAt: Date.now() - 10_000,
      registeredAt: Date.now() - 20_000, lastSeenAt: Date.now() - 20_000,
    });
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

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

test("telegramChats accepts outlet_id and by_role_outlet resolves", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "Frollie — Pakuwon", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null });
    await ctx.db.insert("telegramChats", { chatId: "-100123", chatType: "supergroup", title: "Mgr PKW", role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(), outlet_id: outletId });
    const rows = await ctx.db.query("telegramChats").withIndex("by_role_outlet", (q) => q.eq("role", "managers").eq("outlet_id", outletId)).collect();
    expect(rows.length).toBe(1);
  });
});

test("getChatIdByRoleAndOutlet returns the per-outlet chat, null on miss", async () => {
  const t = convexTest(schema);
  const { a, chat } = await t.run(async (ctx) => {
    const a = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null });
    const chat = await ctx.db.insert("telegramChats", { chatId: "-100A", chatType: "supergroup", title: "Mgr A", role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(), outlet_id: a });
    return { a, chat };
  });
  expect(await t.query(internal.telegram.chatRegistry.internal.getChatIdByRoleAndOutlet, { role: "managers", outletId: a })).toBe("-100A");
  const b = await t.run((ctx) => ctx.db.insert("outlets", { code: "BLK", name: "y", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null }));
  expect(await t.query(internal.telegram.chatRegistry.internal.getChatIdByRoleAndOutlet, { role: "managers", outletId: b })).toBeNull();
});

test("getChatIdByRoleBareOrNull only matches outlet_id-absent rows", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("telegramChats", { chatId: "-100OWN", chatType: "supergroup", title: "Owners", role: "owners", registeredAt: Date.now(), lastSeenAt: Date.now() }); // no outlet_id
  });
  expect(await t.query(internal.telegram.chatRegistry.internal.getChatIdByRoleBareOrNull, { role: "owners" })).toBe("-100OWN");
  expect(await t.query(internal.telegram.chatRegistry.internal.getChatIdByRoleBareOrNull, { role: "managers" })).toBeNull();
});

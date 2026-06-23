import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";

test("staff accepts owner role + telegram_user_id; by_telegram_user_id resolves", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const id = await ctx.db.insert("staff", {
      name: "Owner", code: "S-9001", pin_hash: "h", role: "owner",
      active: true, created_at: Date.now(), telegram_user_id: 4242,
    } as any);
    const row = await ctx.db.query("staff")
      .withIndex("by_telegram_user_id", (q) => q.eq("telegram_user_id", 4242)).first();
    expect(row?._id).toBe(id);
  });
});

test("cockpit session inserts with NO outlet_id (C2)", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", { name: "O", code: "S-9002", pin_hash: "h", role: "owner", active: true, created_at: Date.now() } as any);
    const sid = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "owner-dev", kind: "cockpit",
      started_at: Date.now(), last_active_at: Date.now(), ended_at: null, end_reason: null,
    } as any);
    expect(await ctx.db.get(sid)).not.toBeNull();
  });
});

test("owner_auth_otp + bindings + attempts round-trip on their indexes", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", { name: "O", code: "S-9003", pin_hash: "h", role: "owner", active: true, created_at: Date.now() } as any);
    await ctx.db.insert("owner_auth_otp", { staff_id: staffId, code_hash: "h", expires_at: Date.now() + 1e5, fail_count: 0, consumed_at: null, created_at: Date.now(), device_id: "d" });
    await ctx.db.insert("owner_auth_bindings", { kind: "telegram_bind", staff_id: staffId, token_hash: "th", expires_at: Date.now() + 1e5, redeemed_at: null, created_at: Date.now() });
    await ctx.db.insert("owner_auth_attempts", { staff_id: staffId, request_count: 1, window_start_at: Date.now(), locked_until: null });
    const otp = await ctx.db.query("owner_auth_otp").withIndex("by_staff_active", (q) => q.eq("staff_id", staffId).eq("consumed_at", null)).first();
    expect(otp).not.toBeNull();
  });
});

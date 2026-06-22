import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { requireSession } from "../sessions";

test("requireSession returns the session's outlet_id when stamped", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null });
    const staffId = await ctx.db.insert("staff", { name: "M", code: "S-0001", pin_hash: "h", role: "manager", active: true, created_at: Date.now() });
    const sessionId = await ctx.db.insert("staff_sessions", { staff_id: staffId, device_id: "d1", started_at: Date.now(), ended_at: null, end_reason: null, outlet_id: outletId } as any);
    const r = await requireSession(ctx, sessionId);
    expect(r.outlet_id).toBe(outletId);
  });
});

test("requireSession falls back to the default outlet for an unstamped (pre-backfill) session", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null });
    const staffId = await ctx.db.insert("staff", { name: "M", code: "S-0001", pin_hash: "h", role: "manager", active: true, created_at: Date.now() });
    const sessionId = await ctx.db.insert("staff_sessions", { staff_id: staffId, device_id: "d1", started_at: Date.now(), ended_at: null, end_reason: null } as any);
    const r = await requireSession(ctx, sessionId);
    expect(r.outlet_id).toBe(outletId); // resolved via _getDefaultOutlet_internal
  });
});

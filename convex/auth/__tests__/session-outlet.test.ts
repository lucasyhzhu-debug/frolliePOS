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

test("requireSession throws NO_SESSION for a non-existent session id (Task 12 enforce: schema requires outlet_id)", async () => {
  // After Task 12 enforce, staff_sessions.outlet_id is required by the schema —
  // it is impossible to insert an unstamped session. This test verifies that
  // requireSession throws when the session row does not exist at all.
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
    const staffId = await ctx.db.insert("staff", { name: "M", code: "S-0001", pin_hash: "h", role: "manager", active: true, created_at: Date.now() });
    // Insert then delete to get a typed but dangling Id
    const sessionId = await ctx.db.insert("staff_sessions", { staff_id: staffId, device_id: "d1", started_at: Date.now(), ended_at: null, end_reason: null, outlet_id: outletId } as any);
    await ctx.db.delete(sessionId);
    await expect(requireSession(ctx, sessionId)).rejects.toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("_resolveSessionRole_internal", () => {
  it("returns staffId + role for a live session", async () => {
    const t = convexTest(schema);
    const { sessionId, staffId } = await t.run(async (ctx) => {
      const sid = await ctx.db.insert("staff", {
        name: "Sari", role: "manager", active: true, pin_hash: "x", code: "M1", created_at: 0,
      } as any);
      const sess = await ctx.db.insert("staff_sessions", {
        staff_id: sid, device_id: "d1", started_at: 0, ended_at: null, end_reason: null,
      } as any);
      return { sessionId: sess, staffId: sid };
    });
    const ok = await t.query(internal.auth.internal._resolveSessionRole_internal, { sessionId });
    expect(ok).toMatchObject({ staffId, role: "manager" });
    expect(ok?.deviceId).toBe("d1");
  });

  it("returns null when the session has ended", async () => {
    const t = convexTest(schema);
    const sessionId = await t.run(async (ctx) => {
      const sid = await ctx.db.insert("staff", {
        name: "Sari", role: "staff", active: true, pin_hash: "x", code: "S1", created_at: 0,
      } as any);
      return await ctx.db.insert("staff_sessions", {
        staff_id: sid, device_id: "d1", started_at: 0, ended_at: 1, end_reason: "manual_lock",
      } as any);
    });
    const out = await t.query(internal.auth.internal._resolveSessionRole_internal, { sessionId });
    expect(out).toBeNull();
  });

  it("returns null when the staff is inactive", async () => {
    const t = convexTest(schema);
    const sessionId = await t.run(async (ctx) => {
      const sid = await ctx.db.insert("staff", {
        name: "Old", role: "staff", active: false, pin_hash: "x", code: "X1", created_at: 0,
      } as any);
      return await ctx.db.insert("staff_sessions", {
        staff_id: sid, device_id: "d1", started_at: 0, ended_at: null, end_reason: null,
      } as any);
    });
    const out = await t.query(internal.auth.internal._resolveSessionRole_internal, { sessionId });
    expect(out).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

// verifyManagerPinOrThrow is exercised through createStaff (its first consumer,
// Task 4). Here we assert the helper's contract indirectly via createStaff —
// after Task 4 wires the gate. Until then the test should FAIL on either
// "managerPin arg not allowed" (current) or "NOT_MANAGER" (after T4).
describe("auth.verifyManagerPinOrThrow (via createStaff happy + reject)", () => {
  it("rejects a non-manager session", async () => {
    const t = convexTest(schema);
    const staffId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Sari",
      pin: "1111",
      role: "staff",
    });
    // staff_sessions schema requires ended_at + end_reason (v.union(_, v.null())).
    // requireSession (auth/sessions.ts) reads session + staff + outlet_id (v2.0
    // Task 12: SESSION_NO_OUTLET if absent), so the session must carry outlet_id.
    // No registered_devices row is required for the session gate.
    const sessionId = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as any);
      return ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "d1",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any);
    });
    await expect(
      t.action(api.auth.actions.createStaff, {
        idempotencyKey: "k1",
        sessionId,
        name: "New",
        role: "staff",
        pin: "2222",
        managerPin: "1111",
      } as any),
    ).rejects.toThrow(/NOT_MANAGER/);
  });
});

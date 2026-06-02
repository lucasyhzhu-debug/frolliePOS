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
    // requireSession (auth/sessions.ts:17-20) reads only session + staff,
    // so NO registered_devices row is required.
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "d1",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      }),
    );
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

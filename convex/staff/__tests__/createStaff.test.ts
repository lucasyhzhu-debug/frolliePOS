import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";
import { seedManagerSession } from "./_helpers";

describe("staff code allocation", () => {
  it("allocates the next sequential S-NNNN", async () => {
    const t = convexTest(schema);
    // Seed an existing S-0007 so the next must be S-0008.
    await t.run((ctx) => ctx.db.insert("staff", {
      name: "Existing", code: "S-0007", role: "staff", active: true,
      pin_hash: "x", created_at: 0,
    }));
    const { sessionId } = await seedManagerSession(t);  // helper: manager staff + session
    await t.mutation(internal.staff.internal._createStaffCommit_internal, {
      idempotencyKey: "k1", sessionId, name: "New", role: "staff", pin_hash: "h",
    });
    const created = await t.run((ctx) =>
      ctx.db.query("staff").filter((q) => q.eq(q.field("name"), "New")).first());
    expect(created!.code).toBe("S-0008");
  });

  // v2.0 Task 12 (ENFORCE): login asserts a staff_outlet_access row, so the
  // create-staff flow MUST grant the new staffer access to the creating
  // manager's outlet — else they'd hit NO_OUTLET_ACCESS at first login.
  it("grants the new staff access to the creating manager's outlet", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    const { _id: newId } = await t.mutation(
      internal.staff.internal._createStaffCommit_internal,
      { idempotencyKey: "k1", sessionId, name: "New", role: "staff", pin_hash: "h" },
    );
    const access = await t.run((ctx) =>
      ctx.db
        .query("staff_outlet_access")
        .withIndex("by_staff_outlet", (q) =>
          q.eq("staff_id", newId).eq("outlet_id", outletId),
        )
        .first());
    expect(access).not.toBeNull();
  });
});

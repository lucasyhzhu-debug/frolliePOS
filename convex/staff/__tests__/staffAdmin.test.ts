import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { seedManagerSession } from "./_helpers";

describe("staff.listStaff", () => {
  it("never returns pin_hash", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Sari",
      pin: "1111",
      role: "staff",
    });
    const rows = await t.query(api.staff.public.listStaff, { sessionId });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).not.toHaveProperty("pin_hash");
  });
});

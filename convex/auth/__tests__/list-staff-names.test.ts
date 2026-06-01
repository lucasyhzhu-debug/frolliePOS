import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("_listStaffNames_internal", () => {
  it("returns all staff projected to { _id, name }, including inactive", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const a = await ctx.db.insert("staff", { name: "Sari", role: "manager", active: true, pin_hash: "x", code: "M1", created_at: 0 } as any);
      const b = await ctx.db.insert("staff", { name: "Bayu", role: "staff", active: true, pin_hash: "x", code: "S1", created_at: 0 } as any);
      const c = await ctx.db.insert("staff", { name: "Old", role: "staff", active: false, pin_hash: "x", code: "X1", created_at: 0 } as any);
      return { a, b, c };
    });
    const rows = await t.query(internal.auth.internal._listStaffNames_internal, {});
    expect(rows).toHaveLength(3);
    const byName = Object.fromEntries(rows.map((r: any) => [r.name, r._id]));
    expect(byName.Sari).toBe(ids.a);
    expect(byName.Bayu).toBe(ids.b);
    expect(byName.Old).toBe(ids.c);
  });

  it("returns [] when no staff exist", async () => {
    const t = convexTest(schema);
    const rows = await t.query(internal.auth.internal._listStaffNames_internal, {});
    expect(rows).toEqual([]);
  });
});

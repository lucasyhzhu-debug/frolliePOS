import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("_listStaffCodes_internal", () => {
  it("returns all staff projected to { _id, code }, including inactive", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const a = await ctx.db.insert("staff", { name: "Sari", role: "manager", active: true, pin_hash: "x", code: "M-0001", created_at: 0 } as any);
      const b = await ctx.db.insert("staff", { name: "Bayu", role: "staff", active: false, pin_hash: "x", code: "S-0001", created_at: 0 } as any);
      return { a, b };
    });
    const rows = await t.query(internal.auth.internal._listStaffCodes_internal, {});
    expect(rows).toHaveLength(2);
    const codeById = Object.fromEntries(rows.map((r: any) => [String(r._id), r.code]));
    expect(codeById[String(ids.a)]).toBe("M-0001");
    expect(codeById[String(ids.b)]).toBe("S-0001");
  });

  it("returns [] when no staff exist", async () => {
    const t = convexTest(schema);
    const rows = await t.query(internal.auth.internal._listStaffCodes_internal, {});
    expect(rows).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("_listStaffForOutlet_internal", () => {
  it("returns only access-granted active staff", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", {
        code: "PKW",
        name: "x",
        timezone: "Asia/Jakarta",
        active: true,
        created_at: Date.now(),
        created_by: null,
      });
      const s1 = await ctx.db.insert("staff", {
        name: "A",
        code: "S-1",
        pin_hash: "h",
        role: "staff",
        active: true,
        created_at: Date.now(),
      });
      await ctx.db.insert("staff", {
        name: "B",
        code: "S-2",
        pin_hash: "h",
        role: "staff",
        active: true,
        created_at: Date.now(),
      });
      await ctx.db.insert("staff_outlet_access", {
        staff_id: s1,
        outlet_id: outletId,
        granted_at: Date.now(),
        granted_by: null,
      });
      const list = await ctx.runQuery(internal.auth.internal._listStaffForOutlet_internal, { outletId });
      expect(list.map((s: any) => s.name)).toEqual(["A"]);
    });
  });

  it("excludes inactive staff even with an access row", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", {
        code: "PKW2",
        name: "x",
        timezone: "Asia/Jakarta",
        active: true,
        created_at: Date.now(),
        created_by: null,
      });
      const s1 = await ctx.db.insert("staff", {
        name: "Inactive",
        code: "S-3",
        pin_hash: "h",
        role: "staff",
        active: false,
        created_at: Date.now(),
      });
      await ctx.db.insert("staff_outlet_access", {
        staff_id: s1,
        outlet_id: outletId,
        granted_at: Date.now(),
        granted_by: null,
      });
      const list = await ctx.runQuery(internal.auth.internal._listStaffForOutlet_internal, { outletId });
      expect(list).toHaveLength(0);
    });
  });
});

describe("_assertStaffHasOutletAccess_internal", () => {
  it("returns true when access row exists", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", {
        code: "PKW3",
        name: "x",
        timezone: "Asia/Jakarta",
        active: true,
        created_at: Date.now(),
        created_by: null,
      });
      const staffId = await ctx.db.insert("staff", {
        name: "C",
        code: "S-4",
        pin_hash: "h",
        role: "staff",
        active: true,
        created_at: Date.now(),
      });
      await ctx.db.insert("staff_outlet_access", {
        staff_id: staffId,
        outlet_id: outletId,
        granted_at: Date.now(),
        granted_by: null,
      });
      const result = await ctx.runQuery(internal.auth.internal._assertStaffHasOutletAccess_internal, { staffId, outletId });
      expect(result).toBe(true);
    });
  });

  it("throws NO_OUTLET_ACCESS when no row exists", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", {
        code: "PKW4",
        name: "x",
        timezone: "Asia/Jakarta",
        active: true,
        created_at: Date.now(),
        created_by: null,
      });
      const staffId = await ctx.db.insert("staff", {
        name: "D",
        code: "S-5",
        pin_hash: "h",
        role: "staff",
        active: true,
        created_at: Date.now(),
      });
      await expect(
        ctx.runQuery(internal.auth.internal._assertStaffHasOutletAccess_internal, { staffId, outletId }),
      ).rejects.toThrow("NO_OUTLET_ACCESS");
    });
  });
});

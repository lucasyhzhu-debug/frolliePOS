import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedOutlet(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as never),
  );
}

describe("catalog._getActiveSkus_internal", () => {
  it("returns active SKUs with _id, sku, name; excludes inactive", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => ctx.db.insert("pos_inventory_skus", {
      sku: "A", name: "Sku A", unit: "piece", low_threshold: 0, active: true, created_at: Date.now(), outlet_id: outletId,
    } as never));
    await t.run(async (ctx) => ctx.db.insert("pos_inventory_skus", {
      sku: "B", name: "Sku B", unit: "piece", low_threshold: 0, active: false, created_at: Date.now(), outlet_id: outletId,
    } as never));
    await t.run(async (ctx) => ctx.db.insert("pos_inventory_skus", {
      sku: "C", name: "Sku C", unit: "piece", low_threshold: 0, active: true, created_at: Date.now(), outlet_id: outletId,
    } as never));

    const rows = await t.query(internal.catalog.internal._getActiveSkus_internal, { outletId });
    expect(rows.map((r) => r.sku).sort()).toEqual(["A", "C"]);
    // Confirm shape: _id + sku + name
    for (const r of rows) {
      expect(typeof r._id).toBe("string");
      expect(typeof r.sku).toBe("string");
      expect(typeof r.name).toBe("string");
    }
  });

  it("returns empty array when no active SKUs", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => ctx.db.insert("pos_inventory_skus", {
      sku: "X", name: "X", unit: "piece", low_threshold: 0, active: false, created_at: Date.now(), outlet_id: outletId,
    } as never));
    const rows = await t.query(internal.catalog.internal._getActiveSkus_internal, { outletId });
    expect(rows).toEqual([]);
  });
});

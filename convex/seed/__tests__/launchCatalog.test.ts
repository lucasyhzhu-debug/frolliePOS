import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("seed/_seedLaunchCatalog_internal", () => {
  it("seeds 2 SKUs (dubai, water) with no stock-level rows (lazy-init)", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.seed.internal._seedLaunchCatalog_internal, {});

    const skus = await t.run((ctx) =>
      ctx.db.query("pos_inventory_skus").collect(),
    );
    expect(skus).toHaveLength(2);

    const dubai = skus.find((s) => s.sku === "dubai");
    const water = skus.find((s) => s.sku === "water");
    expect(dubai).toBeDefined();
    expect(water).toBeDefined();

    // Both use the only allowed unit literal; thresholds per launch defs
    expect(dubai!.unit).toBe("piece");
    expect(water!.unit).toBe("piece");
    expect(dubai!.low_threshold).toBe(4);
    expect(water!.low_threshold).toBe(6);
    expect(dubai!.code).toBe("DUBAI");
    expect(water!.code).toBe("WATER");

    // No stock-level rows: upsertStockLevel lazy-inits on first movement and
    // reads default absent rows to 0 — opening recount writes the real stock
    // as a logged movement (ADR-041, rule #8).
    const levels = await t.run((ctx) =>
      ctx.db.query("pos_stock_levels").collect(),
    );
    expect(levels).toHaveLength(0);
  });

  it("seeds 4 products with correct prices and pack labels", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.seed.internal._seedLaunchCatalog_internal, {});

    const products = await t.run((ctx) =>
      ctx.db.query("pos_products").collect(),
    );
    expect(products).toHaveLength(4);

    const byCode = Object.fromEntries(products.map((p) => [p.code, p]));
    expect(byCode["DUBAI_1PC"].price_idr).toBe(45000);
    expect(byCode["DUBAI_1PC"].pack_label).toBe("Single");
    expect(byCode["DUBAI_3PC"].price_idr).toBe(125000);
    expect(byCode["DUBAI_3PC"].pack_label).toBe("Triple");
    expect(byCode["DUBAI_8PC"].price_idr).toBe(320000);
    expect(byCode["DUBAI_8PC"].pack_label).toBe("Eight");
    expect(byCode["WATER_1BTL"].price_idr).toBe(5000);
    expect(byCode["WATER_1BTL"].pack_label).toBe("1 btl");
  });

  it("seeds correct component quantities: Single→1, Triple→3, Eight→8 dubai; water 1:1", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.seed.internal._seedLaunchCatalog_internal, {});

    const [products, skus, components] = await t.run((ctx) =>
      Promise.all([
        ctx.db.query("pos_products").collect(),
        ctx.db.query("pos_inventory_skus").collect(),
        ctx.db.query("pos_product_components").collect(),
      ]),
    );

    const byCode = Object.fromEntries(products.map((p) => [p.code, p]));
    const dubaiSku = skus.find((s) => s.sku === "dubai")!;
    const waterSku = skus.find((s) => s.sku === "water")!;

    const compByProduct = (productId: string) =>
      components.filter((c) => c.product_id === productId);

    const dubai1Comps = compByProduct(byCode["DUBAI_1PC"]._id);
    expect(dubai1Comps).toHaveLength(1);
    expect(dubai1Comps[0].inventory_sku_id).toBe(dubaiSku._id);
    expect(dubai1Comps[0].qty).toBe(1);

    const dubai3Comps = compByProduct(byCode["DUBAI_3PC"]._id);
    expect(dubai3Comps[0].qty).toBe(3);

    const dubai8Comps = compByProduct(byCode["DUBAI_8PC"]._id);
    expect(dubai8Comps[0].qty).toBe(8);

    const waterComps = compByProduct(byCode["WATER_1BTL"]._id);
    expect(waterComps).toHaveLength(1);
    expect(waterComps[0].inventory_sku_id).toBe(waterSku._id);
    expect(waterComps[0].qty).toBe(1);
  });

  it("second invocation throws catalog_already_populated", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.seed.internal._seedLaunchCatalog_internal, {});
    await expect(
      t.mutation(internal.seed.internal._seedLaunchCatalog_internal, {}),
    ).rejects.toThrow(/catalog_already_populated/);
  });

  it("throws catalog_already_populated when SKUs exist even with no products (partial-seed guard)", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_inventory_skus", {
        sku: "dubai", code: "DUBAI", name: "Dubai cookie", unit: "piece",
        low_threshold: 4, active: true, created_at: Date.now(),
      });
    });
    await expect(
      t.mutation(internal.seed.internal._seedLaunchCatalog_internal, {}),
    ).rejects.toThrow(/catalog_already_populated/);
  });

  it("writes an audit_log row with action seed.launch_catalog", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.seed.internal._seedLaunchCatalog_internal, {});

    const auditRows = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) =>
          q.eq("action", "seed.launch_catalog"),
        )
        .collect(),
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor_id).toBe("system");

    // metadata is stored as a JSON.stringify'd string — parse before asserting
    const meta = JSON.parse(auditRows[0].metadata as string);
    expect(meta.skus).toBe(2);
    expect(meta.products).toBe(4);
  });
});

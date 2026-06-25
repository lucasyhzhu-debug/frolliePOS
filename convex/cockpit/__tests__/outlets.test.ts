import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedSource(ctx: any) {
  const owner = await ctx.db.insert("staff", {
    name: "O",
    code: "O1",
    role: "owner",
    pin_hash: "x",
    active: true,
    created_at: 1,
  });
  const src = await ctx.db.insert("outlets", {
    code: "SRC",
    name: "Src",
    timezone: "Asia/Jakarta",
    active: true,
    created_at: 1,
    created_by: null,
  });
  const sku = await ctx.db.insert("pos_inventory_skus", {
    sku: "dubai",
    name: "Dubai",
    unit: "piece",
    low_threshold: 5,
    active: true,
    created_at: 1,
    outlet_id: src,
  });
  const prod = await ctx.db.insert("pos_products", {
    sku_family: "dubai",
    code: "DUBAI_8PC",
    name: "Dubai 8pcs",
    pack_label: "8pcs",
    price_idr: 100000,
    active: true,
    sort_order: 0,
    tax_rate: 0,
    created_at: 1,
    updated_at: 1,
    outlet_id: src,
  });
  await ctx.db.insert("pos_product_components", {
    product_id: prod,
    inventory_sku_id: sku,
    qty: 8,
    outlet_id: src,
  });
  await ctx.db.insert("pos_settings", {
    founders_summary_enabled: true,
    receipt_business_name: "Frollie",
    updated_at: 1,
    outlet_id: src,
  });
  // stock that must NOT be cloned:
  await ctx.db.insert("pos_stock_levels", {
    inventory_sku_id: sku,
    on_hand: 99,
    outlet_id: src,
    updated_at: 1,
  } as any);
  return { owner, src };
}

test("clone creates outlet with created_by, copies catalog, skips stock", async () => {
  const t = convexTest(schema);
  const { outlet_id } = await t.run(async (ctx) => {
    const { owner, src } = await seedSource(ctx);
    return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
      ownerStaffId: owner,
      mode: "clone",
      source_outlet_id: src,
      name: "Frollie Two",
      code: "TWO",
      timezone: "Asia/Jakarta",
      settings: {},
      staff_ids: [],
      provision_managers_chat: false,
    });
  });
  await t.run(async (ctx) => {
    const o = await ctx.db.get(outlet_id);
    expect(o?.created_by).not.toBeNull(); // owner stamped
    const prods = await ctx.db
      .query("pos_products")
      .withIndex("by_outlet_active_sort", (q) => q.eq("outlet_id", outlet_id))
      .collect();
    expect(prods.length).toBe(1); // catalog copied
    // pos_stock_levels index is by_outlet_sku (["outlet_id","inventory_sku_id"])
    const stock = await ctx.db
      .query("pos_stock_levels")
      .withIndex("by_outlet_sku", (q) => q.eq("outlet_id", outlet_id))
      .collect();
    expect(stock.length).toBe(0); // stock NOT copied
  });
});

test("blank mode creates outlet + settings, no catalog", async () => {
  const t = convexTest(schema);
  const { outlet_id } = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("staff", {
      name: "O",
      code: "O1",
      role: "owner",
      pin_hash: "x",
      active: true,
      created_at: 1,
    } as any);
    return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
      ownerStaffId: owner,
      mode: "blank",
      name: "Blank",
      code: "BLK",
      timezone: "Asia/Jakarta",
      settings: { receipt_business_name: "Blank Co" },
      staff_ids: [],
      provision_managers_chat: false,
    });
  });
  await t.run(async (ctx) => {
    const prods = await ctx.db
      .query("pos_products")
      .withIndex("by_outlet_active_sort", (q) => q.eq("outlet_id", outlet_id))
      .collect();
    expect(prods.length).toBe(0);
    const s = await ctx.db
      .query("pos_settings")
      .withIndex("by_outlet", (q) => q.eq("outlet_id", outlet_id))
      .first();
    expect(s?.receipt_business_name).toBe("Blank Co");
  });
});

test("duplicate code throws OUTLET_CODE_TAKEN, no partial outlet", async () => {
  const t = convexTest(schema);
  await expect(
    t.run(async (ctx) => {
      const owner = await ctx.db.insert("staff", {
        name: "O",
        code: "O1",
        role: "owner",
        pin_hash: "x",
        active: true,
        created_at: 1,
      } as any);
      await ctx.db.insert("outlets", {
        code: "DUP",
        name: "Existing",
        timezone: "Asia/Jakarta",
        active: true,
        created_at: 1,
        created_by: null,
      } as any);
      return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
        ownerStaffId: owner,
        mode: "blank",
        name: "X",
        code: "DUP",
        timezone: "Asia/Jakarta",
        settings: {},
        staff_ids: [],
        provision_managers_chat: false,
      });
    }),
  ).rejects.toThrow("OUTLET_CODE_TAKEN");
});

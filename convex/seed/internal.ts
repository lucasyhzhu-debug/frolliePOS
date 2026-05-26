import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { logAudit } from "../audit/internal";

export const _countStaff_internal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("staff").collect();
    return rows.length;
  },
});

export const _reset_internal = internalMutation({
  args: {
    staffPinHash: v.string(),
    mgrPinHash: v.string(),
    staffNames: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let wiped = 0;

    // Wipe order: children before parents to avoid orphaned references
    for (const table of [
      "audit_log", "pos_idempotency", "pos_auth_attempts",
      "staff_sessions", "registered_devices", "pending_device_setups",
      "pos_stock_levels", "pos_product_components", "pos_products", "pos_inventory_skus",
      "staff",
    ] as const) {
      const all = await ctx.db.query(table).collect();
      for (const r of all) { await ctx.db.delete(r._id); wiped++; }
    }

    let inserted = 0;

    // Staff: 4 crew (PIN 0000) + 1 manager (PIN 9999)
    for (const name of args.staffNames) {
      await ctx.db.insert("staff", {
        name, pin_hash: args.staffPinHash, role: "staff", active: true, created_at: now,
      });
      inserted++;
    }
    await ctx.db.insert("staff", {
      name: "Lucas", pin_hash: args.mgrPinHash, role: "manager", active: true, created_at: now,
    });
    inserted++;

    // Inventory SKUs + initial stock levels
    const skus: Record<string, any> = {};
    for (const [sku, name, hue, threshold, onHand] of [
      ["dubai",   "Dubai cookie",   30,  4, 18],
      ["choco",   "Choco cookie",   20,  4, 12],
      ["matcha",  "Matcha cookie",  110, 4,  8],
      ["lotus",   "Lotus cookie",    50, 4,  5],
      ["brownie", "Brownie mini",    15, 4, 24],
    ] as const) {
      const id = await ctx.db.insert("pos_inventory_skus", {
        sku, name, unit: "piece", low_threshold: threshold,
        initials: name.slice(0, 2), hue, active: true, created_at: now,
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: id, on_hand: onHand, updated_at: now,
      });
      skus[sku] = id;
      inserted += 2; // 1 SKU + 1 stock level
    }

    // Products + components
    // name, pack_label, price_idr, components[[sku, qty]], sort_order
    const products: Array<[string, string, number, Array<[string, number]>, number]> = [
      ["Dubai",     "1 pc",  45000, [["dubai", 1]],                                          1],
      ["Dubai",     "3 pcs", 125000, [["dubai", 3]],                                          2],
      ["Dubai",     "8 pcs", 340000, [["dubai", 8]],                                          3],
      ["Choco",     "1 pc",  25000, [["choco", 1]],                                          4],
      ["Matcha",    "1 pc",  25000, [["matcha", 1]],                                         5],
      ["Lotus",     "1 pc",  28000, [["lotus", 1]],                                          6],
      ["Mixed Box", "4 pcs", 95000, [["choco", 1], ["matcha", 1], ["lotus", 1], ["brownie", 1]], 7],
    ];

    for (const [name, pack, price, comps, order] of products) {
      const family = comps[0][0];
      const hue = family === "dubai" ? 30 : family === "choco" ? 20 : family === "matcha" ? 110 : family === "lotus" ? 50 : 15;
      const productId = await ctx.db.insert("pos_products", {
        sku_family: family,
        name,
        pack_label: pack,
        price_idr: price,
        initials: (name[0] + (pack.match(/\d+/)?.[0] ?? "")).slice(0, 2),
        hue,
        active: true,
        sort_order: order,
        tax_rate: 0,
        created_at: now,
        updated_at: now,
      });
      inserted++;
      for (const [skuKey, qty] of comps) {
        await ctx.db.insert("pos_product_components", {
          product_id: productId, inventory_sku_id: skus[skuKey], qty,
        });
        inserted++;
      }
    }

    await logAudit(ctx, {
      actor_id: "system",
      action: "seed.reset",
      entity_type: "system",
      source: "system",
      metadata: { wiped, inserted, staff_names: args.staffNames },
    });

    return { wiped, inserted };
  },
});

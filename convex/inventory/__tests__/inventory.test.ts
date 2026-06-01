import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

/** Insert a minimal staff row so pos_transactions.staff_id validates. */
async function seedStaffId(ctx: any) {
  return ctx.db.insert("staff", {
    name: "Test Staff",
    pin_hash: "$argon2id$dummy",
    role: "staff",
    active: true,
    created_at: Date.now(),
  });
}

/** Insert a minimal product row so pos_transaction_lines.product_id validates. */
async function seedProductId(ctx: any) {
  const now = Date.now();
  return ctx.db.insert("pos_products", {
    sku_family: "_seed", name: "Seed Product", pack_label: "1pc",
    price_idr: 0, tax_rate: 0, active: true, sort_order: 0,
    created_at: now, updated_at: now,
  });
}

describe("inventory/internal", () => {
  it("_recordSaleMovement_internal: writes one movement row per line, decrements on_hand, updates updated_at", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const staffId = await seedStaffId(ctx);
      const productId = await seedProductId(ctx);
      const skuId = await ctx.db.insert("pos_inventory_skus", {
        sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 5,
        active: true, created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment", subtotal: 0, voucher_discount: 0,
        total: 0, flags: 0, staff_id: staffId,
        created_at: Date.now(),
      });
      const lineId = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "DBP8", product_name_snapshot: "Dubai 8pc",
        unit_price_snapshot: 200_000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 200_000,
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuId, on_hand: 10, updated_at: Date.now() - 1000,
      });
      return { skuId, txnId, lineId };
    });

    await t.mutation(internal.inventory.internal._recordSaleMovement_internal, {
      transactionId: setup.txnId,
      lines: [{ lineId: setup.lineId, skuId: setup.skuId, qty: 8 }],
    });

    const result = await t.run(async (ctx) => {
      const movements = await ctx.db.query("pos_stock_movements").collect();
      const level = await ctx.db
        .query("pos_stock_levels")
        .withIndex("by_sku", (q) => q.eq("inventory_sku_id", setup.skuId))
        .first();
      return { movements, level };
    });

    expect(result.movements.length).toBe(1);
    expect(result.movements[0].qty).toBe(-8);
    expect(result.movements[0].source).toBe("sale");
    expect(result.level?.on_hand).toBe(2);
    expect(result.level?.updated_at).toBeGreaterThan(Date.now() - 5000);
  });

  it("_recordSaleMovement_internal: ADR-026 dedup — same line_id+sku_id call twice writes only one movement", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const staffId = await seedStaffId(ctx);
      const productId = await seedProductId(ctx);
      const skuId = await ctx.db.insert("pos_inventory_skus", {
        sku: "choco", name: "Choco", unit: "piece", low_threshold: 5,
        active: true, created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment", subtotal: 0, voucher_discount: 0,
        total: 0, flags: 0, staff_id: staffId, created_at: Date.now(),
      });
      const lineId = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "C1", product_name_snapshot: "Choco 1pc",
        unit_price_snapshot: 25_000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 25_000,
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuId, on_hand: 10, updated_at: Date.now(),
      });
      return { skuId, txnId, lineId };
    });

    const lines = [{ lineId: setup.lineId, skuId: setup.skuId, qty: 1 }];
    await t.mutation(internal.inventory.internal._recordSaleMovement_internal, {
      transactionId: setup.txnId, lines,
    });
    await t.mutation(internal.inventory.internal._recordSaleMovement_internal, {
      transactionId: setup.txnId, lines,
    });

    const movements = await t.run((ctx) => ctx.db.query("pos_stock_movements").collect());
    expect(movements.length).toBe(1);
  });

  it("_projectedOnHand_internal: returns on_hand - pending_qty per SKU", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const skuA = await ctx.db.insert("pos_inventory_skus", {
        sku: "a", name: "A", unit: "piece", low_threshold: 0,
        active: true, created_at: Date.now(),
      });
      const skuB = await ctx.db.insert("pos_inventory_skus", {
        sku: "b", name: "B", unit: "piece", low_threshold: 0,
        active: true, created_at: Date.now(),
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuA, on_hand: 10, updated_at: Date.now(),
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuB, on_hand: 5, updated_at: Date.now(),
      });
      return { skuA, skuB };
    });

    const projected = await t.query(internal.inventory.internal._projectedOnHand_internal, {
      skuQtys: [
        { skuId: setup.skuA, qty: 3 },
        { skuId: setup.skuB, qty: 7 },
      ],
    });

    expect(projected[setup.skuA]).toBe(7);
    expect(projected[setup.skuB]).toBe(-2);
  });
});

describe("inventory/schema v0.5.2", () => {
  it("pos_low_stock_alerts + pos_recount_state round-trip; recount source accepted", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const skuId = await ctx.db.insert("pos_inventory_skus", {
        sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 20, active: true, created_at: Date.now(),
      });
      const flag = await ctx.db.insert("pos_low_stock_alerts", {
        inventory_sku_id: skuId, alerted_at: Date.now(), updated_at: Date.now(),
      });
      expect((await ctx.db.get(flag))!.inventory_sku_id).toBe(skuId);

      const state = await ctx.db.insert("pos_recount_state", { last_recount_at: 123 });
      expect((await ctx.db.get(state))!.last_recount_at).toBe(123);

      const mv = await ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: skuId, qty: 5, source: "recount", created_at: Date.now(),
      });
      expect((await ctx.db.get(mv))!.source).toBe("recount");
    });
  });
});

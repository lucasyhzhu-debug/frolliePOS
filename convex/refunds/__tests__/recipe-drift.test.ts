import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { describe, it, expect } from "vitest";

/**
 * I3 (v0.5.1 PR B post-review): refund stock re-credit must use the SAME
 * components/qtys that were decremented at sale time — not the CURRENT
 * product recipe. If a manager edits a product's components between sale
 * and refund, the refund must still re-credit the ORIGINAL recipe.
 *
 * Pre-I3, _refundReCredit_internal called catalog._getComponentsForProducts_internal
 * with line.product_id, which always returned the LATEST components. Recipe
 * drift would silently corrupt stock counts.
 *
 * Post-I3, the function reads pos_stock_movements (immutable proof of what was
 * decremented at sale) and ratios down via line.qty. The current recipe is
 * never consulted — drift is impossible.
 */

describe("_refundReCredit_internal recipe-drift safety (I3)", () => {
  it("re-credits the components that were decremented at sale time, not the current recipe", async () => {
    const t = convexTest(schema);

    const seed = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { is_open: false, code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
      const staffId = await ctx.db.insert("staff", {
        code: "S-DRIFT", name: "Drift", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const mgrId = await ctx.db.insert("staff", {
        code: "M-DRIFT", name: "Mgr", role: "manager", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const skuA = await ctx.db.insert("pos_inventory_skus", {
        sku: "drift-a", code: "SKU-A", name: "SKU A",
        unit: "piece" as const, low_threshold: 0,
        active: true, created_at: Date.now(), outlet_id: outletId,
      } as any);
      const productId = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUBDRIFT", name: "Dubai Drift 1pc", pack_label: "1pc",
        price_idr: 50000, active: true, sort_order: 0, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(), outlet_id: outletId,
      } as any);
      // ORIGINAL recipe: 1 unit of product P consumes 2 of SKU-A.
      const compId = await ctx.db.insert("pos_product_components", {
        product_id: productId,
        inventory_sku_id: skuA,
        qty: 2,
        outlet_id: outletId,
      } as any);
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId, created_at: Date.now(), paid_at: Date.now(),
        receipt_number: "R-2026-DRIFT", receipt_token: "tok-drift", outlet_id: outletId,
      } as any);
      const lineId = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "DUBDRIFT", product_name_snapshot: "Dubai Drift 1pc",
        unit_price_snapshot: 50000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 50000, outlet_id: outletId,
      } as any);
      // Hand-write the historic sale movement (simulates _recordSaleMovement_internal
      // having run at paid-time): qty -2 (= component_qty * line_qty = 2 * 1).
      await ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: skuA,
        qty: -2,
        source: "sale",
        source_transaction_line_id: lineId,
        created_at: Date.now(),
        outlet_id: outletId,
      } as any);
      // Seed on_hand consistent with the sale: started at 10, now 8.
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuA, on_hand: 8, updated_at: Date.now(), outlet_id: outletId,
      } as any);

      return { staffId, mgrId, skuA, productId, compId, txnId, lineId };
    });

    // DRIFT: a manager bumps the recipe to consume 3 SKU-A per unit AFTER the sale.
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.compId, { qty: 3 });
    });

    // Refund the line. With I3, re-credit must use the immutable sale movement
    // (2 SKU-A), NOT the current recipe (3 SKU-A).
    await t.mutation(internal.refunds.internal._commitRefund_internal, {
      idempotencyKey: "drift-test-commit",
      transactionId: seed.txnId,
      lines: [{ line_id: seed.lineId, qty: 1 }],
      reason: "recipe drift safety check",
      requestedBy: seed.staffId,
      approverId: seed.mgrId,
      approvalSource: "booth_inline",
    });

    await t.run(async (ctx) => {
      // The refund movement must credit 2 (the original sale qty), not 3.
      const movements = await ctx.db
        .query("pos_stock_movements")
        .withIndex("by_line_and_sku", (q) =>
          q.eq("source_transaction_line_id", seed.lineId).eq("inventory_sku_id", seed.skuA),
        )
        .collect();
      const refundMovements = movements.filter((m) => m.source === "refund");
      expect(refundMovements.length).toBe(1);
      expect(refundMovements[0].qty).toBe(2);  // ← I3 fix: 2 (drift-safe), NOT 3

      // on_hand returns to 10 (8 + 2), NOT 11 (8 + 3).
      const level = await ctx.db
        .query("pos_stock_levels")
        .withIndex("by_sku", (q) => q.eq("inventory_sku_id", seed.skuA))
        .first();
      expect(level?.on_hand).toBe(10);
    });
  });
});

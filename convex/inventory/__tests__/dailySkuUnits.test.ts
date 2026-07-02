// convex/inventory/__tests__/dailySkuUnits.test.ts
//
// _dailySkuUnits_internal (v1.4.2) — per-SKU units sold in a day window for
// the EOD owners / managers Telegram summaries. Sums sale movements only
// (gross: refund re-credits excluded), scoped to the outlet + window, sorted
// by units desc. Archived SKUs still report (sold-then-archived-same-day).

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

async function seedOutlet(
  t: ReturnType<typeof convexTest>,
  code: string,
): Promise<Id<"outlets">> {
  return await t.run((ctx) =>
    ctx.db.insert("outlets", {
      is_open: false,
      code,
      name: code,
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    } as never),
  );
}

async function seedSku(
  t: ReturnType<typeof convexTest>,
  outletId: Id<"outlets">,
  sku: string,
  name: string,
  active = true,
): Promise<Id<"pos_inventory_skus">> {
  return await t.run((ctx) =>
    ctx.db.insert("pos_inventory_skus", {
      sku,
      name,
      unit: "piece",
      low_threshold: 5,
      active,
      created_at: Date.now(),
      outlet_id: outletId,
    }),
  );
}

async function seedMovement(
  t: ReturnType<typeof convexTest>,
  outletId: Id<"outlets">,
  skuId: Id<"pos_inventory_skus">,
  qty: number,
  source: "sale" | "refund" | "stock_in",
  createdAt: number,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("pos_stock_movements", {
      inventory_sku_id: skuId,
      qty,
      source,
      created_at: createdAt,
      outlet_id: outletId,
    });
  });
}

describe("inventory/internal._dailySkuUnits_internal", () => {
  it("sums sale movements per SKU in the window, sorted desc; excludes refunds, stock-in, out-of-window, other outlets", async () => {
    const t = convexTest(schema);
    const dayStartMs = 1_750_000_000_000;
    const dayEndMs = dayStartMs + 24 * 3600 * 1000;
    const inWindow = dayStartMs + 3600 * 1000;

    const outlet = await seedOutlet(t, "PKW");
    const other = await seedOutlet(t, "CIT");
    const dubai = await seedSku(t, outlet, "dubai", "Dubai Cookie");
    const matcha = await seedSku(t, outlet, "matcha", "Matcha Cookie");
    await seedSku(t, outlet, "quiet", "No Sales SKU");
    const otherDubai = await seedSku(t, other, "dubai", "Dubai Cookie");

    // dubai: 10×dubai-1 + 10×dubai-3 + 10×dubai-8 → 10 + 30 + 80 = 120 pcs
    await seedMovement(t, outlet, dubai, -10, "sale", inWindow);
    await seedMovement(t, outlet, dubai, -30, "sale", inWindow + 1);
    await seedMovement(t, outlet, dubai, -80, "sale", inWindow + 2);
    // matcha: 24 pcs
    await seedMovement(t, outlet, matcha, -24, "sale", inWindow);
    // noise: refund re-credit (gross — must NOT net down), stock-in, movements
    // outside the window, and a sale on a different outlet.
    await seedMovement(t, outlet, dubai, 8, "refund", inWindow + 3);
    await seedMovement(t, outlet, dubai, 100, "stock_in", inWindow + 4);
    await seedMovement(t, outlet, dubai, -50, "sale", dayStartMs - 1);
    await seedMovement(t, outlet, dubai, -50, "sale", dayEndMs);
    await seedMovement(t, other, otherDubai, -7, "sale", inWindow);

    const result = await t.query(
      internal.inventory.internal._dailySkuUnits_internal,
      { dayStartMs, dayEndMs, outletId: outlet },
    );

    expect(result).toEqual([
      { sku: "dubai", name: "Dubai Cookie", units: 120 },
      { sku: "matcha", name: "Matcha Cookie", units: 24 },
    ]);
    // Zero-unit SKUs are omitted entirely (renderer skips absent block).
    expect(result.find((r) => r.sku === "quiet")).toBeUndefined();
  });

  it("includes archived SKUs that sold before being archived", async () => {
    const t = convexTest(schema);
    const dayStartMs = 1_750_000_000_000;
    const dayEndMs = dayStartMs + 24 * 3600 * 1000;

    const outlet = await seedOutlet(t, "PKW");
    const retired = await seedSku(t, outlet, "retired", "Retired Mid-Day", false);
    await seedMovement(t, outlet, retired, -6, "sale", dayStartMs + 1000);

    const result = await t.query(
      internal.inventory.internal._dailySkuUnits_internal,
      { dayStartMs, dayEndMs, outletId: outlet },
    );

    expect(result).toEqual([{ sku: "retired", name: "Retired Mid-Day", units: 6 }]);
  });
});

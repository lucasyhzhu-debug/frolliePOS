import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedOutlet(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    } as any)
  ) as any;
}

async function seedSku(t: ReturnType<typeof convexTest>, sku: string, outletId: any, active = true) {
  return await t.run(async (ctx) => ctx.db.insert("pos_inventory_skus", {
    sku, name: `Sku ${sku}`, unit: "piece", low_threshold: 0, active, created_at: Date.now(),
    outlet_id: outletId,
  } as never));
}

describe("inventory._runStockRecon_internal", () => {
  it("no drift: no drift_log rows, no audit row, scanned counts SKUs", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const sku = await seedSku(t, "A", outletId);
    await t.run(async (ctx) => ctx.db.insert("pos_stock_movements", {
      inventory_sku_id: sku, qty: 5, source: "stock_in", created_at: 1, outlet_id: outletId,
    } as never));
    await t.run(async (ctx) => ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: sku, on_hand: 5, updated_at: Date.now(), outlet_id: outletId,
    } as never));

    const result = await t.mutation(internal.inventory.internal._runStockRecon_internal, { outletId });
    expect(result.scanned).toBe(1);
    expect(result.drifted).toHaveLength(0);
    const drifts = await t.run(async (ctx) => ctx.db.query("pos_stock_drift_log").collect());
    expect(drifts).toHaveLength(0);
  });

  it("drift: inserts drift_log + audit; returns drifted shape", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const sku = await seedSku(t, "A", outletId);
    await t.run(async (ctx) => ctx.db.insert("pos_stock_movements", {
      inventory_sku_id: sku, qty: 5, source: "stock_in", created_at: 1, outlet_id: outletId,
    } as never));
    await t.run(async (ctx) => ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: sku, on_hand: 7, updated_at: Date.now(), outlet_id: outletId,
    } as never)); // 2 above ledger

    const result = await t.mutation(internal.inventory.internal._runStockRecon_internal, { outletId });
    expect(result.scanned).toBe(1);
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0]).toMatchObject({ sku_code: "A", delta: 2 });
    const drifts = await t.run(async (ctx) => ctx.db.query("pos_stock_drift_log").collect());
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ cached_on_hand: 7, reconstructed_on_hand: 5, delta: 2 });
    const audits = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "stock.recon_drift")).collect(),
    );
    expect(audits).toHaveLength(1);
  });

  it("skip-on-empty: SKU with zero movements + on_hand=0 is scanned but no drift", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const sku = await seedSku(t, "Z", outletId);
    await t.run(async (ctx) => ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: sku, on_hand: 0, updated_at: Date.now(), outlet_id: outletId,
    } as never));
    const result = await t.mutation(internal.inventory.internal._runStockRecon_internal, { outletId });
    expect(result.scanned).toBe(1);
    expect(result.drifted).toHaveLength(0);
  });

  it("inactive SKUs are excluded from scan", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const skuA = await seedSku(t, "A", outletId, true);
    const skuB = await seedSku(t, "B", outletId, false);
    await t.run(async (ctx) => ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: skuA, on_hand: 5, updated_at: Date.now(), outlet_id: outletId,
    } as never));
    // skuB has wildly-drifted cache but is inactive — should not appear
    await t.run(async (ctx) => ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: skuB, on_hand: 999, updated_at: Date.now(), outlet_id: outletId,
    } as never));
    await t.run(async (ctx) => ctx.db.insert("pos_stock_movements", {
      inventory_sku_id: skuA, qty: 5, source: "stock_in", created_at: 1, outlet_id: outletId,
    } as never));

    const result = await t.mutation(internal.inventory.internal._runStockRecon_internal, { outletId });
    expect(result.scanned).toBe(1);
    expect(result.drifted).toHaveLength(0);
  });
});

describe("inventory._auditStockReconSkip_internal", () => {
  it("logs stock.recon_skip with reason", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.inventory.internal._auditStockReconSkip_internal, {
      reason: "no_drift", metadata: { scanned: 5 },
    });
    const audits = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "stock.recon_skip")).collect(),
    );
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata as string);
    expect(meta).toEqual({ reason: "no_drift", scanned: 5 });
  });
});

describe("inventory._resolveDrift_internal", () => {
  it("patches resolved fields + emits stock.recon_drift_resolved audit", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const sku = await seedSku(t, "A", outletId);
    const mgr = await t.run(async (ctx) => ctx.db.insert("staff", {
      name: "M", code: "S-0001", role: "manager", active: true, pin_hash: "x", created_at: Date.now(),
    } as never));
    const driftId = await t.run(async (ctx) => ctx.db.insert("pos_stock_drift_log", {
      inventory_sku_id: sku, sku_code: "A",
      cached_on_hand: 10, reconstructed_on_hand: 7, delta: 3,
      detected_at: Date.now(), outlet_id: outletId,
    } as never));

    await t.mutation(internal.inventory.internal._resolveDrift_internal, {
      driftId, resolved_by: mgr, note: "counted by Lucas", device_id: "dev-booth",
    });

    const row = await t.run(async (ctx) => ctx.db.get(driftId));
    expect(row?.resolved_at).toBeGreaterThan(0);
    expect(row?.resolved_by_staff_id).toBe(mgr);
    expect(row?.resolution_note).toBe("counted by Lucas");

    const audits = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "stock.recon_drift_resolved")).collect(),
    );
    expect(audits).toHaveLength(1);
  });

  it("idempotent: second resolve on already-resolved drift is no-op", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const sku = await seedSku(t, "A", outletId);
    const mgr = await t.run(async (ctx) => ctx.db.insert("staff", {
      name: "M", code: "S-0001", role: "manager", active: true, pin_hash: "x", created_at: Date.now(),
    } as never));
    const now = Date.now();
    const driftId = await t.run(async (ctx) => ctx.db.insert("pos_stock_drift_log", {
      inventory_sku_id: sku, sku_code: "A",
      cached_on_hand: 10, reconstructed_on_hand: 7, delta: 3,
      detected_at: now, resolved_at: now, resolved_by_staff_id: mgr, resolution_note: "x",
      outlet_id: outletId,
    } as never));
    await t.mutation(internal.inventory.internal._resolveDrift_internal, {
      driftId, resolved_by: mgr, note: "second attempt",
    });
    const audits = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "stock.recon_drift_resolved")).collect(),
    );
    expect(audits).toHaveLength(0); // already-resolved → no audit
  });

  it("rejects NOTE_TOO_LONG when note > 500 chars", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const sku = await seedSku(t, "A", outletId);
    const mgr = await t.run(async (ctx) => ctx.db.insert("staff", {
      name: "M", code: "S-0001", role: "manager", active: true, pin_hash: "x", created_at: Date.now(),
    } as never));
    const driftId = await t.run(async (ctx) => ctx.db.insert("pos_stock_drift_log", {
      inventory_sku_id: sku, sku_code: "A",
      cached_on_hand: 10, reconstructed_on_hand: 7, delta: 3,
      detected_at: Date.now(), outlet_id: outletId,
    } as never));
    await expect(t.mutation(internal.inventory.internal._resolveDrift_internal, {
      driftId, resolved_by: mgr, note: "a".repeat(501),
    })).rejects.toThrow(/NOTE_TOO_LONG/);
  });
});

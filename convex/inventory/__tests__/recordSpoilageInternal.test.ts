import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

/**
 * v0.6 Task S3 — single-writer internal mutation for spoilage.
 *
 * Covers: multi-line write inserts N movements + per-SKU on_hand decrement +
 * ONE stock.spoilage audit row whose metadata carries the line breakdown.
 * Also exercises the boundary validators (empty lines, blank/too-long reason,
 * non-positive qty) so neither caller (booth path S4, Telegram path S5) needs
 * to revalidate.
 *
 * audit_log.metadata is JSON.stringify'd by logAudit — parse before inspect.
 */
describe("inventory._recordSpoilage_internal", () => {
  it("inserts movements + decrements stock + emits one stock.spoilage audit", async () => {
    const t = convexTest(schema);
    const skuA = await t.run(async (ctx) =>
      ctx.db.insert("pos_inventory_skus", {
        sku: "a", name: "Sku A", unit: "piece", low_threshold: 0,
        active: true, created_at: Date.now(),
      }),
    );
    const skuB = await t.run(async (ctx) =>
      ctx.db.insert("pos_inventory_skus", {
        sku: "b", name: "Sku B", unit: "piece", low_threshold: 0,
        active: true, created_at: Date.now(),
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuA, on_hand: 10, updated_at: Date.now(),
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuB, on_hand: 5, updated_at: Date.now(),
      });
    });
    const mgr = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "M", code: "S-0001", pin_hash: "$argon2id$x", role: "manager",
        active: true, created_at: Date.now(),
      }),
    );

    await t.mutation(internal.inventory.internal._recordSpoilage_internal, {
      spoilage_event_id: "evt-1",
      lines: [
        { inventory_sku_id: skuA, qty: 3 },
        { inventory_sku_id: skuB, qty: 2 },
      ],
      reason: "expired batch",
      actor_id: mgr,
      source: "booth_inline",
      device_id: "dev",
    });

    const movs = await t.run(async (ctx) =>
      ctx.db.query("pos_stock_movements").collect(),
    );
    expect(movs).toHaveLength(2);
    expect(movs.find((m) => m.inventory_sku_id === skuA)).toMatchObject({
      qty: -3, source: "spoilage", spoilage_event_id: "evt-1", spoilage_reason: "expired batch",
    });
    expect(movs.find((m) => m.inventory_sku_id === skuB)).toMatchObject({
      qty: -2, source: "spoilage", spoilage_event_id: "evt-1",
    });

    const levelA = await t.run(async (ctx) =>
      ctx.db.query("pos_stock_levels").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuA)).first(),
    );
    expect(levelA?.on_hand).toBe(7); // 10 - 3
    const levelB = await t.run(async (ctx) =>
      ctx.db.query("pos_stock_levels").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuB)).first(),
    );
    expect(levelB?.on_hand).toBe(3); // 5 - 2

    const audits = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "stock.spoilage")).collect(),
    );
    expect(audits).toHaveLength(1); // ONE audit per event, not per line
    const meta = JSON.parse(audits[0].metadata as unknown as string) as Record<string, unknown>;
    expect(meta).toMatchObject({ event_id: "evt-1", total_qty: 5, line_count: 2 });
    expect(audits[0].source).toBe("booth_inline");
  });

  it("threads telegram_approval source onto the audit row", async () => {
    const t = convexTest(schema);
    const sku = await t.run(async (ctx) =>
      ctx.db.insert("pos_inventory_skus", {
        sku: "a", name: "A", unit: "piece", low_threshold: 0,
        active: true, created_at: Date.now(),
      }),
    );
    const mgr = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "M", code: "S-0001", pin_hash: "$argon2id$x", role: "manager",
        active: true, created_at: Date.now(),
      }),
    );
    await t.mutation(internal.inventory.internal._recordSpoilage_internal, {
      spoilage_event_id: "evt-tg",
      lines: [{ inventory_sku_id: sku, qty: 1 }],
      reason: "tg path",
      actor_id: mgr,
      source: "telegram_approval",
    });
    const audits = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "stock.spoilage")).collect(),
    );
    expect(audits[0].source).toBe("telegram_approval");
  });

  it("rejects empty lines", async () => {
    const t = convexTest(schema);
    const mgr = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "M", code: "S-0001", pin_hash: "$argon2id$x", role: "manager",
        active: true, created_at: Date.now(),
      }),
    );
    await expect(
      t.mutation(internal.inventory.internal._recordSpoilage_internal, {
        spoilage_event_id: "x",
        lines: [],
        reason: "x",
        actor_id: mgr,
        source: "booth_inline",
      }),
    ).rejects.toThrow(/LINES_EMPTY/);
  });

  it("rejects empty reason / too long reason / zero qty", async () => {
    const t = convexTest(schema);
    const sku = await t.run(async (ctx) =>
      ctx.db.insert("pos_inventory_skus", {
        sku: "a", name: "A", unit: "piece", low_threshold: 0,
        active: true, created_at: Date.now(),
      }),
    );
    const mgr = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "M", code: "S-0001", pin_hash: "$argon2id$x", role: "manager",
        active: true, created_at: Date.now(),
      }),
    );
    // Blank-after-trim reason
    await expect(
      t.mutation(internal.inventory.internal._recordSpoilage_internal, {
        spoilage_event_id: "x",
        lines: [{ inventory_sku_id: sku, qty: 1 }],
        reason: "   ",
        actor_id: mgr,
        source: "booth_inline",
      }),
    ).rejects.toThrow(/REASON_INVALID/);
    // Over 200 chars
    await expect(
      t.mutation(internal.inventory.internal._recordSpoilage_internal, {
        spoilage_event_id: "x",
        lines: [{ inventory_sku_id: sku, qty: 1 }],
        reason: "a".repeat(201),
        actor_id: mgr,
        source: "booth_inline",
      }),
    ).rejects.toThrow(/REASON_INVALID/);
    // Zero qty
    await expect(
      t.mutation(internal.inventory.internal._recordSpoilage_internal, {
        spoilage_event_id: "x",
        lines: [{ inventory_sku_id: sku, qty: 0 }],
        reason: "x",
        actor_id: mgr,
        source: "booth_inline",
      }),
    ).rejects.toThrow(/QTY_INVALID/);
  });
});

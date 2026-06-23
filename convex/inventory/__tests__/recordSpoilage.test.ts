import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

/**
 * v0.6 Task S4 — manager-PIN booth action `recordSpoilage`.
 *
 * Validates inputs, runs verifyManagerPinOrThrow (CLAUDE.md rule #18),
 * mints a spoilage_event_id via mintUrlSafeToken(16), and commits via
 * _recordSpoilage_internal (S3) with source="booth_inline". Wrapped in
 * withActionCache so a replay short-circuits BEFORE the argon2 verify.
 */
async function seedSku(t: ReturnType<typeof convexTest>, sku: string, outletId: any) {
  const skuId = await t.run(async (ctx) =>
    ctx.db.insert("pos_inventory_skus", {
      sku,
      name: `Sku ${sku}`,
      unit: "piece",
      low_threshold: 0,
      active: true,
      created_at: Date.now(),
      outlet_id: outletId,
    } as any),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: skuId,
      on_hand: 10,
      updated_at: Date.now(),
      outlet_id: outletId,
    } as any);
  });
  return skuId;
}

describe("inventory.actions.recordSpoilage", () => {
  it("happy path with correct PIN", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    const sku = await seedSku(t, "a", outletId);
    const r = await t.action(api.inventory.actions.recordSpoilage, {
      idempotencyKey: "k",
      sessionId,
      lines: [{ inventory_sku_id: sku, qty: 2 }],
      reason: "dropped",
      managerPin: "9999",
    });
    expect(r.line_count).toBe(1);
    expect(r.total_qty).toBe(2);
    expect(typeof r.event_id).toBe("string");
    expect(r.event_id.length).toBeGreaterThan(0);
  });

  it("wrong PIN rejected", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    const sku = await seedSku(t, "a", outletId);
    await expect(
      t.action(api.inventory.actions.recordSpoilage, {
        idempotencyKey: "k",
        sessionId,
        lines: [{ inventory_sku_id: sku, qty: 1 }],
        reason: "x",
        managerPin: "0000",
      }),
    ).rejects.toThrow(/INVALID_PIN/);
  });

  it("replay returns cached result, no second insert", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    const sku = await seedSku(t, "a", outletId);
    const args = {
      idempotencyKey: "rk",
      sessionId,
      lines: [{ inventory_sku_id: sku, qty: 1 }],
      reason: "x",
      managerPin: "9999",
    };
    const a = await t.action(api.inventory.actions.recordSpoilage, args);
    const b = await t.action(api.inventory.actions.recordSpoilage, args);
    expect(a.event_id).toBe(b.event_id);
    const movs = await t.run(async (ctx) =>
      ctx.db.query("pos_stock_movements").collect(),
    );
    expect(movs).toHaveLength(1);
  });

  it("rejects empty lines", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await expect(
      t.action(api.inventory.actions.recordSpoilage, {
        idempotencyKey: "k",
        sessionId,
        lines: [],
        reason: "x",
        managerPin: "9999",
      }),
    ).rejects.toThrow(/LINES_EMPTY/);
  });
});

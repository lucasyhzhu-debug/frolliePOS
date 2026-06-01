import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal, api } from "../../_generated/api";

// _checkLowStock_internal schedules _dispatchLowStockAlert_internal via runAfter(0)
// when on_hand crosses below low_threshold. The dispatch action calls Telegram —
// stub fetch + env vars so it's offline + deterministic, and drain the scheduler
// in tests that trip a dispatch so it doesn't fire after teardown.
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.TELEGRAM_CHAT_ID = "-1001234567";
  process.env.POS_BASE_URL = "https://pos.dev";
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes("telegram")) {
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return realFetch(url as RequestInfo);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// runAfter(0) uses setTimeout(0): yield once so the job moves from pending →
// inProgress, then drain. Same idiom as convex/auth/__tests__/auth.test.ts.
async function drainScheduled(t: ReturnType<typeof convexTest>) {
  await new Promise((r) => setTimeout(r, 0));
  await t.finishInProgressScheduledFunctions();
}

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

/** Insert a staff + an active staff_sessions row; returns both ids. */
async function seedStaffSession(t: any, role: "staff" | "manager" = "staff") {
  return t.run(async (ctx: any) => {
    const staffId = await ctx.db.insert("staff", {
      name: "S", pin_hash: "$argon2id$x", role, active: true, created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "dev-1", started_at: Date.now(), ended_at: null, end_reason: null,
    });
    return { staffId, sessionId };
  });
}

/** Insert a minimal inventory SKU with an explicit low_threshold. */
async function seedSkuWithThreshold(t: any, sku: string, low_threshold: number) {
  return t.run((ctx: any) =>
    ctx.db.insert("pos_inventory_skus", {
      sku, name: sku, unit: "piece", low_threshold, active: true, created_at: Date.now(),
    }),
  );
}

/**
 * Seed a staff + product + transaction + one line. Used by v0.5.2 low-stock-
 * injection test (Task 7). The two original _recordSaleMovement_internal tests
 * keep their inline seed bodies — leaving them alone keeps regression surface
 * zero.
 */
async function seedTxnAndLine(ctx: any) {
  const staffId = await seedStaffId(ctx);
  const productId = await seedProductId(ctx);
  const txnId = await ctx.db.insert("pos_transactions", {
    status: "awaiting_payment", subtotal: 0, voucher_discount: 0,
    total: 0, flags: 0, staff_id: staffId, created_at: Date.now(),
  });
  const lineId = await ctx.db.insert("pos_transaction_lines", {
    transaction_id: txnId, product_id: productId,
    product_code_snapshot: "DBP8", product_name_snapshot: "Dubai 8pc",
    unit_price_snapshot: 200_000, tax_rate_snapshot: 0,
    qty: 1, line_subtotal: 200_000,
  });
  return { txnId, lineId };
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
    // on_hand 10 → 2, threshold 5 → 2 < 5 schedules low-stock dispatch.
    await drainScheduled(t);
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

describe("catalog internals for inventory", () => {
  it("_getSkusByIds_internal returns name + low_threshold; _setLowThreshold_internal patches", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "x", 5);
    const got = await t.query(internal.catalog.internal._getSkusByIds_internal, { skuIds: [skuId] });
    expect(got[0]).toMatchObject({ skuId, name: "x", low_threshold: 5 });
    await t.mutation(internal.catalog.internal._setLowThreshold_internal, { skuId, lowThreshold: 25 });
    const got2 = await t.query(internal.catalog.internal._getSkusByIds_internal, { skuIds: [skuId] });
    expect(got2[0].low_threshold).toBe(25);
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

  describe("_applyLevelDelta_internal", () => {
    it("inserts when absent, patches when present", async () => {
      const t = convexTest(schema);
      const skuId = await t.run(async (ctx) =>
        ctx.db.insert("pos_inventory_skus", {
          sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 0, active: true, created_at: Date.now(),
        }),
      );
      await t.mutation(internal.inventory.internal._applyLevelDelta_internal, { skuId, delta: 10 });
      await t.mutation(internal.inventory.internal._applyLevelDelta_internal, { skuId, delta: -3 });
      const lvl = await t.run(async (ctx) =>
        ctx.db.query("pos_stock_levels").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).first(),
      );
      expect(lvl!.on_hand).toBe(7);
    });
  });
});

describe("_checkLowStock_internal", () => {
  it("inserts a flag row + schedules alert the first time on_hand < low_threshold", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "dubai", 20);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: skuId, on_hand: 3, updated_at: Date.now() });
    });
    await t.mutation(internal.inventory.internal._checkLowStock_internal, { skuId });
    const flag = await t.run(async (ctx) =>
      ctx.db.query("pos_low_stock_alerts").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).first(),
    );
    expect(flag).not.toBeNull();
    // dedup: second call does not add a second flag
    await t.mutation(internal.inventory.internal._checkLowStock_internal, { skuId });
    const flags = await t.run(async (ctx) =>
      ctx.db.query("pos_low_stock_alerts").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).collect(),
    );
    expect(flags).toHaveLength(1);
    // Drain the scheduled dispatch so it doesn't fire after teardown.
    await drainScheduled(t);
  });

  it("re-arms (deletes flag) when on_hand climbs back to/above low_threshold", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "dubai", 20);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: skuId, on_hand: 100, updated_at: Date.now() });
      await ctx.db.insert("pos_low_stock_alerts", { inventory_sku_id: skuId, alerted_at: 999, updated_at: 999 });
    });
    await t.mutation(internal.inventory.internal._checkLowStock_internal, { skuId });
    const flag = await t.run(async (ctx) =>
      ctx.db.query("pos_low_stock_alerts").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).first(),
    );
    expect(flag).toBeNull();
  });

  it("low_threshold 0: only negative on_hand alerts", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "dubai0", 0);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: skuId, on_hand: 0, updated_at: Date.now() });
    });
    await t.mutation(internal.inventory.internal._checkLowStock_internal, { skuId });
    const flag = await t.run(async (ctx) =>
      ctx.db.query("pos_low_stock_alerts").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).first(),
    );
    expect(flag).toBeNull(); // 0 < 0 is false
  });

  it("alerts when no level row exists yet (defaults to 0 < threshold)", async () => {
    const t = convexTest(schema);
    // global fetch stub from beforeEach still applies
    const skuId = await seedSkuWithThreshold(t, "fresh", 20);
    // NO pos_stock_levels insert — first-ever sale scenario
    await t.mutation(internal.inventory.internal._checkLowStock_internal, { skuId });
    const flag = await t.run(async (ctx) =>
      ctx.db.query("pos_low_stock_alerts").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).first(),
    );
    expect(flag).not.toBeNull();
    await drainScheduled(t);
  });
});

describe("_recordSaleMovement_internal — low-stock injection (v0.5.2)", () => {
  it("triggers one low-stock check per unique decremented SKU", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "dubai-decr", 20);
    const setup = await t.run(async (ctx) => {
      const seeded = await seedTxnAndLine(ctx);
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: skuId, on_hand: 21, updated_at: Date.now() });
      return seeded;
    });
    // 21 → 16 crosses threshold-20.
    await t.mutation(internal.inventory.internal._recordSaleMovement_internal, {
      transactionId: setup.txnId,
      lines: [{ lineId: setup.lineId, skuId, qty: 5 }],
    });
    const flag = await t.run(async (ctx) =>
      ctx.db.query("pos_low_stock_alerts").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).first(),
    );
    expect(flag).not.toBeNull();
    await drainScheduled(t);
  });

  it("two lines on the same SKU trigger ONE low-stock check (Set dedup)", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "dubai-dedup", 20);
    const setup = await t.run(async (ctx) => {
      const staffId = await seedStaffId(ctx);
      const productId = await seedProductId(ctx);
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment", subtotal: 0, voucher_discount: 0,
        total: 0, flags: 0, staff_id: staffId, created_at: Date.now(),
      });
      const lineA = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "A", product_name_snapshot: "A",
        unit_price_snapshot: 100, tax_rate_snapshot: 0, qty: 1, line_subtotal: 100,
      });
      const lineB = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "B", product_name_snapshot: "B",
        unit_price_snapshot: 100, tax_rate_snapshot: 0, qty: 1, line_subtotal: 100,
      });
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: skuId, on_hand: 25, updated_at: Date.now() });
      return { txnId, lineA, lineB };
    });
    // Two lines, same SKU. 25 → 20 → 18 crosses threshold-20 on the second decrement.
    await t.mutation(internal.inventory.internal._recordSaleMovement_internal, {
      transactionId: setup.txnId,
      lines: [
        { lineId: setup.lineA, skuId, qty: 5 },
        { lineId: setup.lineB, skuId, qty: 2 },
      ],
    });
    // Assert exactly one alert audit row (proves Set dedup — without it, two would fire).
    const audit = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "stock.low_stock_alerted")).collect(),
    );
    expect(audit).toHaveLength(1);
    // And exactly one flag row (which would be the case anyway because the flag is dedup-by-sku).
    const flags = await t.run(async (ctx) =>
      ctx.db.query("pos_low_stock_alerts").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).collect(),
    );
    expect(flags).toHaveLength(1);
    await drainScheduled(t);
  });
});

describe("recordRecount", () => {
  it("writes recount movement (signed delta), sets on_hand to entered, stamps recount-state", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "x", 0);
    const { sessionId } = await seedStaffSession(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: skuId, on_hand: 50, updated_at: Date.now() });
    });
    await t.mutation(api.inventory.public.recordRecount, {
      idempotencyKey: "rc-1", sessionId, counts: [{ skuId, entered: 30 }],
    });
    const lvl = await t.run(async (ctx) =>
      ctx.db.query("pos_stock_levels").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).first(),
    );
    expect(lvl!.on_hand).toBe(30);
    const mv = await t.run(async (ctx) =>
      ctx.db.query("pos_stock_movements").withIndex("by_sku_created", (q) => q.eq("inventory_sku_id", skuId)).collect(),
    );
    expect(mv.find((m: any) => m.source === "recount")!.qty).toBe(-20);
    const state = await t.run(async (ctx) => ctx.db.query("pos_recount_state").first());
    expect(state!.last_recount_at).toBeTypeOf("number");
    await drainScheduled(t);
  });

  it("skips SKUs where entered === on_hand", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "x", 0);
    const { sessionId } = await seedStaffSession(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: skuId, on_hand: 40, updated_at: Date.now() });
    });
    await t.mutation(api.inventory.public.recordRecount, {
      idempotencyKey: "rc-2", sessionId, counts: [{ skuId, entered: 40 }],
    });
    const mv = await t.run(async (ctx) =>
      ctx.db.query("pos_stock_movements").withIndex("by_sku_created", (q) => q.eq("inventory_sku_id", skuId)).collect(),
    );
    expect(mv.filter((m: any) => m.source === "recount")).toHaveLength(0);
    await drainScheduled(t);
  });

  it("first-ever count with no level row inserts on_hand = entered", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "x", 0);
    const { sessionId } = await seedStaffSession(t);
    await t.mutation(api.inventory.public.recordRecount, {
      idempotencyKey: "rc-4", sessionId, counts: [{ skuId, entered: 10 }],
    });
    const lvl = await t.run(async (ctx) =>
      ctx.db.query("pos_stock_levels").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).first(),
    );
    expect(lvl!.on_hand).toBe(10);
    await drainScheduled(t);
  });

  it("rejects negative entered", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "x", 0);
    const { sessionId } = await seedStaffSession(t);
    await expect(t.mutation(api.inventory.public.recordRecount, {
      idempotencyKey: "rc-3", sessionId, counts: [{ skuId, entered: -1 }],
    })).rejects.toThrow();
  });

  it("idempotent replay does not double-apply", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "x", 0);
    const { sessionId } = await seedStaffSession(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: skuId, on_hand: 50, updated_at: Date.now() });
    });
    const args = { idempotencyKey: "rc-dup", sessionId, counts: [{ skuId, entered: 30 }] };
    await t.mutation(api.inventory.public.recordRecount, args);
    await t.mutation(api.inventory.public.recordRecount, args);
    const lvl = await t.run(async (ctx) =>
      ctx.db.query("pos_stock_levels").withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId)).first(),
    );
    expect(lvl!.on_hand).toBe(30); // idempotent: still 30, not 10 (would be if double-applied)
    await drainScheduled(t);
  });
});

describe("setLowThreshold", () => {
  it("manager updates the catalog low_threshold", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "x", 5);
    const { sessionId } = await seedStaffSession(t, "manager");
    await t.mutation(api.inventory.public.setLowThreshold, {
      idempotencyKey: "lt-1", sessionId, skuId, lowThreshold: 25,
    });
    const got = await t.query(internal.catalog.internal._getSkusByIds_internal, { skuIds: [skuId] });
    expect(got[0].low_threshold).toBe(25);
  });
  it("rejects non-manager", async () => {
    const t = convexTest(schema);
    const skuId = await seedSkuWithThreshold(t, "x", 5);
    const { sessionId } = await seedStaffSession(t, "staff");
    await expect(t.mutation(api.inventory.public.setLowThreshold, {
      idempotencyKey: "lt-2", sessionId, skuId, lowThreshold: 25,
    })).rejects.toThrow();
  });
});

describe("listInventory", () => {
  it("returns status per active SKU (ok/low/negative)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedStaffSession(t);
    const okSku = await seedSkuWithThreshold(t, "ok", 20);
    const lowSku = await seedSkuWithThreshold(t, "low", 20);
    const negSku = await seedSkuWithThreshold(t, "neg", 20);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: okSku, on_hand: 100, updated_at: Date.now() });
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: lowSku, on_hand: 5, updated_at: Date.now() });
      await ctx.db.insert("pos_stock_levels", { inventory_sku_id: negSku, on_hand: -2, updated_at: Date.now() });
    });
    const rows = await t.query(api.inventory.public.listInventory, { sessionId });
    const byId: Record<string, "ok" | "low" | "negative"> = {};
    for (const r of rows) byId[r.skuId] = r.status;
    expect(byId[okSku]).toBe("ok");
    expect(byId[lowSku]).toBe("low");
    expect(byId[negSku]).toBe("negative");
  });
});

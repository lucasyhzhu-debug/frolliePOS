import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

/**
 * Helper: seeds a single product with a known `code` + a staff session,
 * returning the IDs needed by the snapshot test (Step 1 — Task 2).
 */
async function seedProductAndSession(
  t: ReturnType<typeof convexTest>,
  opts: { code: string; sku_family: string; price_idr: number },
): Promise<{ sessionId: Id<"staff_sessions">; productId: Id<"pos_products"> }> {
  return t.run(async (ctx) => {
    const staff = await ctx.db.insert("staff", {
      name: "T", code: "S-0001", pin_hash: "x", role: "staff", active: true, created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staff, device_id: "d1", started_at: Date.now(),
      ended_at: null, end_reason: null,
    });
    const skuId = await ctx.db.insert("pos_inventory_skus", {
      sku: opts.sku_family, name: opts.sku_family, unit: "piece",
      low_threshold: 0, active: true, created_at: Date.now(),
    });
    const productId = await ctx.db.insert("pos_products", {
      sku_family: opts.sku_family, code: opts.code, name: opts.code,
      pack_label: "1pc", price_idr: opts.price_idr,
      active: true, sort_order: 1, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(),
    });
    await ctx.db.insert("pos_product_components", {
      product_id: productId, inventory_sku_id: skuId, qty: 1,
    });
    await ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: skuId, on_hand: 100, updated_at: Date.now(),
    });
    return { sessionId, productId };
  });
}

async function seedCatalog(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const staff = await ctx.db.insert("staff", {
      name: "Lucas", code: "S-0002", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
    });
    const session = await ctx.db.insert("staff_sessions", {
      staff_id: staff, device_id: "dev-1", started_at: Date.now(),
      ended_at: null, end_reason: null,
    });
    const dubai = await ctx.db.insert("pos_inventory_skus", {
      sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 0,
      active: true, created_at: Date.now(),
    });
    const p8 = await ctx.db.insert("pos_products", {
      sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pc", pack_label: "8pc",
      price_idr: 200_000, active: true, sort_order: 1, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(),
    });
    await ctx.db.insert("pos_product_components", {
      product_id: p8, inventory_sku_id: dubai, qty: 8,
    });
    await ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: dubai, on_hand: 100, updated_at: Date.now(),
    });
    return { staff, session, dubai, p8 };
  });
}

describe("transactions/public.commitCart", () => {
  it("intent=draft creates row with status=draft, snapshots prices+names", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    const r = await t.mutation(api.transactions.public.commitCart, {
      sessionId: s.session,
      idempotencyKey: `k-${Date.now()}`,
      intent: "draft",
      lines: [{ productId: s.p8, qty: 2 }],
    });
    const txn = await t.run((ctx) => ctx.db.get(r.transactionId));
    expect(txn?.status).toBe("draft");
    expect(txn?.subtotal).toBe(400_000);
    expect(txn?.total).toBe(400_000);
    expect(txn?.voucher_discount).toBe(0);

    const lines = await t.run((ctx) =>
      ctx.db.query("pos_transaction_lines")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", r.transactionId))
        .collect(),
    );
    expect(lines.length).toBe(1);
    expect(lines[0].product_name_snapshot).toBe("Dubai 8pc");
    expect(lines[0].unit_price_snapshot).toBe(200_000);
    expect(lines[0].qty).toBe(2);
  });

  it("intent=charge creates row with status=awaiting_payment", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    const r = await t.mutation(api.transactions.public.commitCart, {
      sessionId: s.session,
      idempotencyKey: `k-${Date.now()}-2`,
      intent: "charge",
      lines: [{ productId: s.p8, qty: 1 }],
    });
    const txn = await t.run((ctx) => ctx.db.get(r.transactionId));
    expect(txn?.status).toBe("awaiting_payment");
  });

  it("applies voucher: WELCOME10 on 100k cart → discount 10k, total 90k", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    await t.run((ctx) => ctx.db.insert("pos_vouchers", {
      code: "WELCOME10", type: "percentage", value: 10, used_count: 0,
      active: true, created_at: Date.now(),
    }));
    const p1pc = await t.run((ctx) => ctx.db.insert("pos_products", {
      sku_family: "dubai", code: "DUBAI_1PC", name: "Dubai 1pc", pack_label: "1pc",
      price_idr: 100_000, active: true, sort_order: 2, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(),
    }));
    await t.run((ctx) => ctx.db.insert("pos_product_components", {
      product_id: p1pc, inventory_sku_id: s.dubai, qty: 1,
    }));

    const r = await t.mutation(api.transactions.public.commitCart, {
      sessionId: s.session,
      idempotencyKey: `k-${Date.now()}-3`,
      intent: "charge",
      lines: [{ productId: p1pc, qty: 1 }],
      voucherCode: "WELCOME10",
    });
    const txn = await t.run((ctx) => ctx.db.get(r.transactionId));
    expect(txn?.subtotal).toBe(100_000);
    expect(txn?.voucher_discount).toBe(10_000);
    expect(txn?.total).toBe(90_000);
    expect(txn?.voucher_code_snapshot).toBe("WELCOME10");
  });

  it("sets NEG_STOCK flag when projected on_hand goes negative", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    // Drain dubai to 4
    await t.run(async (ctx) => {
      const lvl = await ctx.db.query("pos_stock_levels").first();
      await ctx.db.patch(lvl!._id, { on_hand: 4 });
    });
    const r = await t.mutation(api.transactions.public.commitCart, {
      sessionId: s.session,
      idempotencyKey: `k-${Date.now()}-4`,
      intent: "charge",
      lines: [{ productId: s.p8, qty: 1 }], // needs 8 from dubai SKU
    });
    expect(r.flags & 1).toBe(1); // NEG_STOCK bit set
  });

  it("rejects empty cart", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    await expect(
      t.mutation(api.transactions.public.commitCart, {
        sessionId: s.session, idempotencyKey: `k-empty-${Date.now()}`,
        intent: "draft", lines: [],
      }),
    ).rejects.toThrow();
  });

  it("returns voucher_rejected when voucher is INACTIVE", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    await t.run((ctx) => ctx.db.insert("pos_vouchers", {
      code: "INACTIVE_V", type: "amount", value: 1000, used_count: 0,
      active: false, created_at: Date.now(),
    }));
    const r = await t.mutation(api.transactions.public.commitCart, {
      sessionId: s.session,
      idempotencyKey: `k-inactive-${Date.now()}`,
      intent: "charge",
      lines: [{ productId: s.p8, qty: 1 }],
      voucherCode: "INACTIVE_V",
    });
    expect(r.voucher_rejected).toEqual({ code: "INACTIVE_V", reason: "INACTIVE" });
    expect(r.totals.discount).toBe(0);
  });

  it("returns voucher_rejected when voucher is EXPIRED", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    await t.run((ctx) => ctx.db.insert("pos_vouchers", {
      code: "OLD_V", type: "amount", value: 1000, used_count: 0, active: true,
      expires_at: Date.now() - 1000, created_at: Date.now(),
    }));
    const r = await t.mutation(api.transactions.public.commitCart, {
      sessionId: s.session,
      idempotencyKey: `k-expired-${Date.now()}`,
      intent: "charge",
      lines: [{ productId: s.p8, qty: 1 }],
      voucherCode: "OLD_V",
    });
    expect(r.voucher_rejected?.reason).toBe("EXPIRED");
    expect(r.voucher_rejected?.code).toBe("OLD_V");
    expect(r.totals.discount).toBe(0);
  });

  it("returns voucher_rejected when subtotal < min_cart_value", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    // p8 price is 200_000; set min above that
    await t.run((ctx) => ctx.db.insert("pos_vouchers", {
      code: "BIG_V", type: "amount", value: 1000, used_count: 0, active: true,
      min_cart_value: 9_999_999, created_at: Date.now(),
    }));
    const r = await t.mutation(api.transactions.public.commitCart, {
      sessionId: s.session,
      idempotencyKey: `k-min-${Date.now()}`,
      intent: "charge",
      lines: [{ productId: s.p8, qty: 1 }],
      voucherCode: "BIG_V",
    });
    expect(r.voucher_rejected?.reason).toBe("MIN_CART_VALUE");
    expect(r.voucher_rejected?.code).toBe("BIG_V");
    expect(r.totals.discount).toBe(0);
  });

  it("happy voucher path: voucher_rejected is absent", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    await t.run((ctx) => ctx.db.insert("pos_vouchers", {
      code: "OK_V", type: "amount", value: 500, used_count: 0,
      active: true, created_at: Date.now(),
    }));
    const r = await t.mutation(api.transactions.public.commitCart, {
      sessionId: s.session,
      idempotencyKey: `k-ok-${Date.now()}`,
      intent: "charge",
      lines: [{ productId: s.p8, qty: 1 }],
      voucherCode: "OK_V",
    });
    expect(r.voucher_rejected).toBeUndefined();
    expect(r.totals.discount).toBe(500);
  });

  it("snapshots product.code (never sku_family) onto the line", async () => {
    const t = convexTest(schema);
    const { sessionId, productId } = await seedProductAndSession(t, {
      code: "DUBAI_8PC", sku_family: "dubai", price_idr: 320000,
    });
    const { transactionId } = await t.mutation(api.transactions.public.commitCart, {
      idempotencyKey: "k1", sessionId, intent: "draft",
      lines: [{ productId, qty: 1 }],
    });
    const line = await t.run((ctx) =>
      ctx.db.query("pos_transaction_lines")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", transactionId))
        .first());
    expect(line!.product_code_snapshot).toBe("DUBAI_8PC");
  });

  it("idempotency: same key returns same txn (no duplicate)", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    const key = `k-idem-${Date.now()}`;
    const r1 = await t.mutation(api.transactions.public.commitCart, {
      sessionId: s.session, idempotencyKey: key, intent: "draft",
      lines: [{ productId: s.p8, qty: 1 }],
    });
    const r2 = await t.mutation(api.transactions.public.commitCart, {
      sessionId: s.session, idempotencyKey: key, intent: "draft",
      lines: [{ productId: s.p8, qty: 99 }], // different lines — should be ignored
    });
    expect(r1.transactionId).toBe(r2.transactionId);
    const lines = await t.run((ctx) =>
      ctx.db.query("pos_transaction_lines")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", r1.transactionId))
        .collect(),
    );
    expect(lines.length).toBe(1);
    expect(lines[0].qty).toBe(1); // first call wins
  });
});

describe("SEC-02: commitCart quantity guard", () => {
  it.each([-1, 0, 1.5])("rejects qty %s before any write", async (badQty) => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    await expect(
      t.mutation(api.transactions.public.commitCart, {
        idempotencyKey: `qtytest-${badQty}`,
        sessionId: s.session,
        // intent is a REQUIRED arg (v.union("draft","charge")) — omitting it
        // makes Convex reject on validation BEFORE the QTY_INVALID guard.
        intent: "charge",
        lines: [{ productId: s.p8, qty: badQty }],
      }),
    ).rejects.toThrow("QTY_INVALID");
    const txns = await t.run((ctx) => ctx.db.query("pos_transactions").collect());
    expect(txns.length).toBe(0); // nothing written
  });

  it("rejects a mixed positive/negative cart (stock-credit vector)", async () => {
    const t = convexTest(schema);
    const s = await seedCatalog(t);
    // Seed a second product so the cart has two distinct lines.
    const p1pc = await t.run((ctx) => ctx.db.insert("pos_products", {
      sku_family: "dubai", code: "DUBAI_1PC", name: "Dubai 1pc", pack_label: "1pc",
      price_idr: 100_000, active: true, sort_order: 2, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(),
    }));
    await t.run((ctx) => ctx.db.insert("pos_product_components", {
      product_id: p1pc, inventory_sku_id: s.dubai, qty: 1,
    }));
    await expect(
      t.mutation(api.transactions.public.commitCart, {
        idempotencyKey: "qtytest-mixed",
        sessionId: s.session,
        intent: "charge",
        lines: [{ productId: s.p8, qty: 100 }, { productId: p1pc, qty: -90 }],
      }),
    ).rejects.toThrow("QTY_INVALID");
    const moves = await t.run((ctx) => ctx.db.query("pos_stock_movements").collect());
    expect(moves.length).toBe(0);
  });
});

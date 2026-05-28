import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

async function seedCatalog(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const staff = await ctx.db.insert("staff", {
      name: "Lucas", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
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
      sku_family: "dubai", name: "Dubai 8pc", pack_label: "8pc",
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
      sku_family: "dubai", name: "Dubai 1pc", pack_label: "1pc",
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

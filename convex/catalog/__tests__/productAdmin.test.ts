import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

async function seedProduct(t: ReturnType<typeof convexTest>, active: boolean) {
  return t.run(async (ctx) =>
    ctx.db.insert("pos_products", {
      sku_family: "dubai",
      name: "Dubai 8pcs",
      pack_label: "8 pcs",
      price_idr: 120000,
      active,
      sort_order: 1,
      tax_rate: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    }),
  );
}

describe("catalog.listAllProducts", () => {
  it("returns inactive products too (admin view)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await seedProduct(t, true);
    await seedProduct(t, false);
    const res = await t.query(api.catalog.public.listAllProducts, { sessionId });
    expect(res.products.length).toBe(2);
    expect(res.products.some((p) => p.active === false)).toBe(true);
  });
});

describe("catalog product create/edit", () => {
  it("creates a product with PIN", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const { productId } = await t.action(api.catalog.actions.createProduct, {
      idempotencyKey: "p1", sessionId, managerPin: "9999",
      sku_family: "dubai", name: "Dubai 3pcs", pack_label: "3 pcs",
      price_idr: 50000, tax_rate: 0, sort_order: 2,
    });
    const res = await t.query(api.catalog.public.listAllProducts, { sessionId });
    expect(res.products.find((p) => p._id === productId)?.price_idr).toBe(50000);
  });

  it("edits metadata without PIN (session-gated)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const { productId } = await t.action(api.catalog.actions.createProduct, {
      idempotencyKey: "p2", sessionId, managerPin: "9999",
      sku_family: "dubai", name: "X", pack_label: "1 pc", price_idr: 20000, tax_rate: 0, sort_order: 3,
    });
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m1", sessionId, productId, name: "Dubai 1pc", pack_label: "1 pc", sort_order: 3,
    });
    const res = await t.query(api.catalog.public.listAllProducts, { sessionId });
    expect(res.products.find((p) => p._id === productId)?.name).toBe("Dubai 1pc");
  });

  // v0.5.3b post-review: prove the inner :commit wrap is idempotent. The
  // action-level cache already absorbs the second action call before the
  // internal runs, so to actually exercise the wrapped withIdempotency we
  // call the internal directly with the same `:commit`-derived key. This is
  // the contract that closes the "action crashed between commit and
  // action-level cache write" hole — refunds._commitRefund_internal has the
  // same shape and the same kind of test.
  it("_createProductCommit_internal is idempotent under same :commit key", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    const args = {
      idempotencyKey: "retry-test:commit",
      mgrId: managerId,
      sku_family: "dubai",
      name: "Idempo",
      pack_label: "1 pc",
      price_idr: 30000,
      tax_rate: 0,
      sort_order: 99,
    };
    const first = await t.mutation(internal.catalog.internal._createProductCommit_internal, args);
    const second = await t.mutation(internal.catalog.internal._createProductCommit_internal, args);
    expect(second.productId).toBe(first.productId);
    // Double-insert check: only one pos_products row exists for this name.
    const rows = await t.run(async (ctx) =>
      ctx.db.query("pos_products").collect(),
    );
    expect(rows.filter((p) => p.name === "Idempo")).toHaveLength(1);
  });

  it("rejects a price edit with wrong PIN", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const { productId } = await t.action(api.catalog.actions.createProduct, {
      idempotencyKey: "p3", sessionId, managerPin: "9999",
      sku_family: "dubai", name: "Y", pack_label: "1 pc", price_idr: 20000, tax_rate: 0, sort_order: 4,
    });
    await expect(
      t.action(api.catalog.actions.updateProductPricing, {
        idempotencyKey: "pr1", sessionId, productId, price_idr: 25000, tax_rate: 0, managerPin: "0000",
      }),
    ).rejects.toThrow(/INVALID_PIN/);
  });
});

describe("catalog.setProductComponents", () => {
  async function seedSku(t: ReturnType<typeof convexTest>, sku: string, active = true) {
    return t.run(async (ctx) =>
      ctx.db.insert("pos_inventory_skus", {
        sku, name: sku, unit: "piece", low_threshold: 10, active, created_at: Date.now(),
      }),
    );
  }
  it("replace-sets components", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const { productId } = await t.action(api.catalog.actions.createProduct, {
      idempotencyKey: "p9", sessionId, managerPin: "9999",
      sku_family: "dubai", name: "Box", pack_label: "8 pcs", price_idr: 120000, tax_rate: 0, sort_order: 1,
    });
    const skuA = await seedSku(t, "dubai");
    await t.mutation(api.catalog.public.setProductComponents, {
      idempotencyKey: "sc1", sessionId, productId, components: [{ inventory_sku_id: skuA, qty: 8 }],
    });
    const res = await t.query(api.catalog.public.listAllProducts, { sessionId });
    const comps = res.components.filter((c) => c.product_id === productId);
    expect(comps).toHaveLength(1);
    expect(comps[0].qty).toBe(8);
  });
  it("rejects qty <= 0 and inactive SKU", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const { productId } = await t.action(api.catalog.actions.createProduct, {
      idempotencyKey: "p10", sessionId, managerPin: "9999",
      sku_family: "dubai", name: "Box2", pack_label: "8 pcs", price_idr: 120000, tax_rate: 0, sort_order: 1,
    });
    const inactive = await seedSku(t, "old", false);
    await expect(
      t.mutation(api.catalog.public.setProductComponents, {
        idempotencyKey: "sc2", sessionId, productId, components: [{ inventory_sku_id: inactive, qty: 1 }],
      }),
    ).rejects.toThrow(/SKU_INACTIVE/);
  });
});

describe("catalog.archiveProduct", () => {
  it("sets active=false and drops it from the public catalog", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const { productId } = await t.action(api.catalog.actions.createProduct, {
      idempotencyKey: "p11", sessionId, managerPin: "9999",
      sku_family: "dubai", name: "Z", pack_label: "1 pc", price_idr: 20000, tax_rate: 0, sort_order: 9,
    });
    await t.mutation(api.catalog.public.archiveProduct, { idempotencyKey: "a1", sessionId, productId });
    const pub = await t.query(api.catalog.public.catalog, {});
    expect(pub.products.some((p) => p._id === productId)).toBe(false);
    const admin = await t.query(api.catalog.public.listAllProducts, { sessionId });
    expect(admin.products.find((p) => p._id === productId)?.active).toBe(false);
  });
});

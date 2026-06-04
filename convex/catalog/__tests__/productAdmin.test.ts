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

describe("_createProductCommit_internal — bundled withInventorySku", () => {
  it("creates product + SKU + component link at qty 1 (fresh SKU)", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    const res = await t.mutation(internal.catalog.internal._createProductCommit_internal, {
      idempotencyKey: "bundle-fresh-1:commit",
      mgrId: managerId,
      deviceId: "d",
      sku_family: "matcha",
      name: "Matcha 1pc",
      pack_label: "1 pc",
      price_idr: 20000,
      tax_rate: 0,
      sort_order: 10,
      withInventorySku: true,
      inventorySkuLowThreshold: 3,
      inventorySkuComponentQty: 1,
    });
    expect(res.productId).toBeDefined();
    expect(res.inventorySkuId).toBeDefined();
    expect(res.skuCreated).toBe(true);
    expect(res.componentQty).toBe(1);
    const sku = await t.run(async (ctx) => ctx.db.get(res.inventorySkuId!));
    expect(sku).toMatchObject({ sku: "matcha", low_threshold: 3, active: true });
    const comps = await t.run(async (ctx) =>
      ctx.db.query("pos_product_components").filter((q) => q.eq(q.field("product_id"), res.productId)).collect(),
    );
    expect(comps).toHaveLength(1);
    expect(comps[0]).toMatchObject({ inventory_sku_id: res.inventorySkuId, qty: 1 });
    const audits = await t.run(async (ctx) => ctx.db.query("audit_log").collect());
    const verbs = audits.map((a) => a.action).filter((v) => v.startsWith("product.") || v.startsWith("inventory_sku."));
    expect(verbs).toEqual(expect.arrayContaining(["product.created", "inventory_sku.created", "product.components_set"]));
  });

  it("creates product + SKU + component link at qty 3 (multi-pack, fresh SKU)", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    const res = await t.mutation(internal.catalog.internal._createProductCommit_internal, {
      idempotencyKey: "bundle-fresh-3:commit",
      mgrId: managerId,
      deviceId: "d",
      sku_family: "dubai",
      name: "Dubai 3pcs",
      pack_label: "3 pcs",
      price_idr: 50000,
      tax_rate: 0,
      sort_order: 11,
      withInventorySku: true,
      inventorySkuLowThreshold: 8,
      inventorySkuComponentQty: 3,
    });
    expect(res.skuCreated).toBe(true);
    expect(res.componentQty).toBe(3);
    const comps = await t.run(async (ctx) =>
      ctx.db.query("pos_product_components").filter((q) => q.eq(q.field("product_id"), res.productId)).collect(),
    );
    expect(comps[0].qty).toBe(3);
  });

  it("reuses an existing SKU when slug matches (Dubai 3pcs → existing dubai)", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    const existingSkuId = await t.run(async (ctx) =>
      ctx.db.insert("pos_inventory_skus", {
        sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 0, active: true, created_at: Date.now(),
      }),
    );
    const res = await t.mutation(internal.catalog.internal._createProductCommit_internal, {
      idempotencyKey: "bundle-reuse:commit",
      mgrId: managerId,
      deviceId: "d",
      sku_family: "dubai",
      name: "Dubai 3pcs",
      pack_label: "3 pcs",
      price_idr: 50000,
      tax_rate: 0,
      sort_order: 12,
      withInventorySku: true,
      inventorySkuLowThreshold: 99, // ignored — existing row's threshold wins
      inventorySkuComponentQty: 3,
    });
    expect(res.inventorySkuId).toBe(existingSkuId);
    expect(res.skuCreated).toBe(false);
    expect(res.componentQty).toBe(3);
    const skuRows = await t.run(async (ctx) =>
      ctx.db.query("pos_inventory_skus").filter((q) => q.eq(q.field("sku"), "dubai")).collect(),
    );
    expect(skuRows).toHaveLength(1);
    // No inventory_sku.created audit row when reusing.
    const audits = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "inventory_sku.created")).collect(),
    );
    expect(audits).toHaveLength(0);
  });

  it("rejects sku_family that fails slug regex", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    await expect(
      t.mutation(internal.catalog.internal._createProductCommit_internal, {
        idempotencyKey: "bundle-bad-fam:commit",
        mgrId: managerId, deviceId: "d", sku_family: "Dubai Mall", name: "Bad", pack_label: "1 pc",
        price_idr: 20000, tax_rate: 0, sort_order: 1,
        withInventorySku: true, inventorySkuLowThreshold: 0, inventorySkuComponentQty: 1,
      }),
    ).rejects.toThrow(/SKU_FAMILY_NOT_SLUGGABLE/);
    // Transaction rollback: no product row written.
    const products = await t.run(async (ctx) =>
      ctx.db.query("pos_products").filter((q) => q.eq(q.field("name"), "Bad")).collect(),
    );
    expect(products).toHaveLength(0);
  });

  it.each([0, -1, 1.5])("rejects invalid inventorySkuComponentQty=%s", async (bad) => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    await expect(
      t.mutation(internal.catalog.internal._createProductCommit_internal, {
        idempotencyKey: `bundle-qty:${bad}:commit`,
        mgrId: managerId, deviceId: "d", sku_family: "ok", name: "Ok", pack_label: "1 pc",
        price_idr: 20000, tax_rate: 0, sort_order: 1,
        withInventorySku: true, inventorySkuLowThreshold: 0, inventorySkuComponentQty: bad,
      }),
    ).rejects.toThrow(/QTY_INVALID/);
  });

  it("rejects bundled call with missing inventorySkuLowThreshold", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    await expect(
      t.mutation(internal.catalog.internal._createProductCommit_internal, {
        idempotencyKey: "bundle-miss-lt:commit",
        mgrId: managerId, deviceId: "d", sku_family: "ok", name: "Ok", pack_label: "1 pc",
        price_idr: 20000, tax_rate: 0, sort_order: 1,
        withInventorySku: true, inventorySkuComponentQty: 1,
        // inventorySkuLowThreshold intentionally omitted
      }),
    ).rejects.toThrow(/LOW_THRESHOLD_INVALID/);
  });

  it("unbundled call (no withInventorySku) is unchanged — back-compat", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    const res = await t.mutation(internal.catalog.internal._createProductCommit_internal, {
      idempotencyKey: "unbundled:commit",
      mgrId: managerId, deviceId: "d", sku_family: "dubai", name: "Plain", pack_label: "1 pc",
      price_idr: 20000, tax_rate: 0, sort_order: 1,
    });
    expect(res.productId).toBeDefined();
    expect(res.inventorySkuId).toBeUndefined();
    expect(res.skuCreated).toBeUndefined();
    expect(res.componentQty).toBeUndefined();
    const comps = await t.run(async (ctx) =>
      ctx.db.query("pos_product_components").filter((q) => q.eq(q.field("product_id"), res.productId)).collect(),
    );
    expect(comps).toHaveLength(0);
  });

  it("is idempotent under the same :commit key (bundled path)", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    const args = {
      idempotencyKey: "bundle-replay:commit",
      mgrId: managerId, deviceId: "d", sku_family: "matcha", name: "Matcha 1pc", pack_label: "1 pc",
      price_idr: 20000, tax_rate: 0, sort_order: 1,
      withInventorySku: true, inventorySkuLowThreshold: 3, inventorySkuComponentQty: 1,
    };
    const first = await t.mutation(internal.catalog.internal._createProductCommit_internal, args);
    const second = await t.mutation(internal.catalog.internal._createProductCommit_internal, args);
    expect(second.productId).toBe(first.productId);
    expect(second.inventorySkuId).toBe(first.inventorySkuId);
    const products = await t.run(async (ctx) =>
      ctx.db.query("pos_products").filter((q) => q.eq(q.field("name"), "Matcha 1pc")).collect(),
    );
    expect(products).toHaveLength(1);
  });
});

describe("catalog.createProduct — bundled SKU via action", () => {
  it("forwards the bundled args + PIN gate + idempotency cache", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const res = await t.action(api.catalog.actions.createProduct, {
      idempotencyKey: "act-bundle-1",
      sessionId,
      managerPin: "9999",
      sku_family: "matcha",
      name: "Matcha 1pc",
      pack_label: "1 pc",
      price_idr: 20000,
      tax_rate: 0,
      sort_order: 1,
      withInventorySku: true,
      inventorySkuLowThreshold: 3,
      inventorySkuComponentQty: 1,
    });
    expect(res.productId).toBeDefined();
    expect(res.inventorySkuId).toBeDefined();
    expect(res.skuCreated).toBe(true);
    expect(res.componentQty).toBe(1);
  });

  it("rejects bundled call with wrong PIN — no rows written", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await expect(
      t.action(api.catalog.actions.createProduct, {
        idempotencyKey: "act-bundle-badpin",
        sessionId,
        managerPin: "0000",
        sku_family: "matcha",
        name: "Bad",
        pack_label: "1 pc",
        price_idr: 20000,
        tax_rate: 0,
        sort_order: 1,
        withInventorySku: true,
        inventorySkuLowThreshold: 3,
        inventorySkuComponentQty: 1,
      }),
    ).rejects.toThrow(/INVALID_PIN/);
    const products = await t.run(async (ctx) =>
      ctx.db.query("pos_products").filter((q) => q.eq(q.field("name"), "Bad")).collect(),
    );
    expect(products).toHaveLength(0);
  });
});

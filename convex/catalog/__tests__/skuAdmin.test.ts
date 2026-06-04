import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

describe("_createInventorySkuCommit_internal", () => {
  it("inserts an SKU row + audit row on happy path", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    const res = await t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, {
      idempotencyKey: "sku-happy:commit",
      mgrId: managerId,
      deviceId: "dev-booth-device",
      sku: "matcha",
      name: "Matcha cookies",
      low_threshold: 5,
    });
    expect(res.skuId).toBeDefined();
    const sku = await t.run(async (ctx) => ctx.db.get(res.skuId));
    expect(sku).toMatchObject({ sku: "matcha", name: "Matcha cookies", low_threshold: 5, unit: "piece", active: true });
    const audits = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "inventory_sku.created")).collect(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ source: "booth_inline", entity_type: "inventory_sku", device_id: "dev-booth-device" });
  });

  it("treats whitespace `code` as not-provided", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    const { skuId } = await t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, {
      idempotencyKey: "sku-blank-code:commit",
      mgrId: managerId,
      deviceId: "dev-booth-device",
      sku: "lotus",
      name: "Lotus",
      low_threshold: 0,
      code: "   ",
    });
    const sku = await t.run(async (ctx) => ctx.db.get(skuId));
    expect(sku?.code).toBeUndefined();
  });

  it("rejects duplicate sku", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    await t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, {
      idempotencyKey: "dup1:commit", mgrId: managerId, deviceId: "d", sku: "choco", name: "Choco", low_threshold: 0,
    });
    await expect(
      t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, {
        idempotencyKey: "dup2:commit", mgrId: managerId, deviceId: "d", sku: "choco", name: "Choco 2", low_threshold: 0,
      }),
    ).rejects.toThrow(/SKU_EXISTS/);
  });

  it("rejects duplicate code when provided", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    await t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, {
      idempotencyKey: "c1:commit", mgrId: managerId, deviceId: "d", sku: "a", name: "A", low_threshold: 0, code: "X1",
    });
    await expect(
      t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, {
        idempotencyKey: "c2:commit", mgrId: managerId, deviceId: "d", sku: "b", name: "B", low_threshold: 0, code: "X1",
      }),
    ).rejects.toThrow(/CODE_EXISTS/);
  });

  it.each([
    ["UPPER", "SKU_INVALID"],
    ["has space", "SKU_INVALID"],
    ["a".repeat(33), "SKU_INVALID"],
    ["", "SKU_INVALID"],
  ])("rejects bad sku shape: %s", async (badSku, code) => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    await expect(
      t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, {
        idempotencyKey: `bad:${badSku}:commit`, mgrId: managerId, deviceId: "d", sku: badSku, name: "N", low_threshold: 0,
      }),
    ).rejects.toThrow(new RegExp(code));
  });

  it("rejects empty / too-long name", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    await expect(
      t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, {
        idempotencyKey: "n1:commit", mgrId: managerId, deviceId: "d", sku: "x", name: "", low_threshold: 0,
      }),
    ).rejects.toThrow(/NAME_INVALID/);
    await expect(
      t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, {
        idempotencyKey: "n2:commit", mgrId: managerId, deviceId: "d", sku: "y", name: "z".repeat(81), low_threshold: 0,
      }),
    ).rejects.toThrow(/NAME_INVALID/);
  });

  it.each([-1, 1.5, Number.NaN])("rejects bad low_threshold: %s", async (bad) => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    await expect(
      t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, {
        idempotencyKey: `lt:${bad}:commit`, mgrId: managerId, deviceId: "d", sku: "ok", name: "OK", low_threshold: bad as number,
      }),
    ).rejects.toThrow(/LOW_THRESHOLD_INVALID/);
  });

  it("is idempotent under the same :commit key", async () => {
    const t = convexTest(schema);
    const { managerId } = await seedManagerSession(t);
    const args = {
      idempotencyKey: "replay:commit",
      mgrId: managerId,
      deviceId: "d",
      sku: "replay",
      name: "Replay",
      low_threshold: 0,
    };
    const first = await t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, args);
    const second = await t.mutation(internal.catalog.internal._createInventorySkuCommit_internal, args);
    expect(second.skuId).toBe(first.skuId);
    const rows = await t.run(async (ctx) => ctx.db.query("pos_inventory_skus").collect());
    expect(rows.filter((s) => s.sku === "replay")).toHaveLength(1);
    const audits = await t.run(async (ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "inventory_sku.created")).collect(),
    );
    expect(audits).toHaveLength(1);
  });
});

describe("catalog.actions.createInventorySku", () => {
  it("creates an SKU with a valid manager PIN", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const res = await t.action(api.catalog.actions.createInventorySku, {
      idempotencyKey: "act-happy",
      sessionId,
      managerPin: "9999",
      sku: "brownie",
      name: "Brownie",
      low_threshold: 3,
    });
    expect(res.skuId).toBeDefined();
  });

  it("rejects with INVALID_PIN on wrong manager PIN", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await expect(
      t.action(api.catalog.actions.createInventorySku, {
        idempotencyKey: "act-badpin",
        sessionId,
        managerPin: "0000",
        sku: "brownie",
        name: "Brownie",
        low_threshold: 3,
      }),
    ).rejects.toThrow(/INVALID_PIN/);
  });

  it("action-level replay returns the cached result without double-inserting", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const args = {
      idempotencyKey: "act-replay",
      sessionId,
      managerPin: "9999",
      sku: "replay-action",
      name: "Replay Action",
      low_threshold: 0,
    };
    const first = await t.action(api.catalog.actions.createInventorySku, args);
    const second = await t.action(api.catalog.actions.createInventorySku, args);
    expect(second.skuId).toBe(first.skuId);
    const rows = await t.run(async (ctx) => ctx.db.query("pos_inventory_skus").collect());
    expect(rows.filter((s) => s.sku === "replay-action")).toHaveLength(1);
  });

  it("new SKU appears in listAllProducts.skus", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const { skuId } = await t.action(api.catalog.actions.createInventorySku, {
      idempotencyKey: "act-list",
      sessionId,
      managerPin: "9999",
      sku: "vanilla",
      name: "Vanilla",
      low_threshold: 0,
    });
    const res = await t.query(api.catalog.public.listAllProducts, { sessionId });
    expect(res.skus.some((s) => s._id === skuId)).toBe(true);
  });
});

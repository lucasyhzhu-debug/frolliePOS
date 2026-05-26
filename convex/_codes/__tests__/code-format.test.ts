// Format conformance for the three stable string identifiers introduced in
// v0.2.1 (ADR-034): staffCode, componentCode (inventory SKU), productCode.
//
// Each test spins up a fresh convex-test instance, runs the dev seed action
// (which is the canonical population path), then asserts the resulting rows'
// `code` field matches the documented format and is unique across the table.
//
// These are CONFORMANCE tests, not feature tests — they exist to lock the
// `code` allocation strategy in seed (Task F3) so future edits can't silently
// drift the format. When Task F6 lands and makes `code` required at the
// schema layer, these will already be passing.

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

const STAFF_CODE = /^S-\d{4}$/;
const COMPONENT_CODE = /^[A-Z][A-Z0-9_]*$/;
const PRODUCT_CODE = /^[A-Z][A-Z0-9_]*_\d+PC$/;

describe("stable string identifier formats (ADR-034)", () => {
  it("seeded staff codes match S-NNNN", async () => {
    const t = convexTest(schema);
    await t.action(internal.seed.actions.reset, {});
    const staff = await t.run(async (ctx) => ctx.db.query("staff").collect());
    expect(staff.length).toBeGreaterThan(0);
    for (const s of staff) {
      expect(s.code).toMatch(STAFF_CODE);
    }
  });

  it("seeded component codes match UPPERCASE_SNAKE", async () => {
    const t = convexTest(schema);
    await t.action(internal.seed.actions.reset, {});
    const skus = await t.run(async (ctx) => ctx.db.query("pos_inventory_skus").collect());
    expect(skus.length).toBeGreaterThan(0);
    for (const sku of skus) {
      expect(sku.code).toMatch(COMPONENT_CODE);
    }
  });

  it("seeded product codes match <PREFIX>_<N>PC", async () => {
    const t = convexTest(schema);
    await t.action(internal.seed.actions.reset, {});
    const products = await t.run(async (ctx) => ctx.db.query("pos_products").collect());
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect(p.code).toMatch(PRODUCT_CODE);
    }
  });

  it("staff codes are unique", async () => {
    const t = convexTest(schema);
    await t.action(internal.seed.actions.reset, {});
    const staff = await t.run(async (ctx) => ctx.db.query("staff").collect());
    const codes = staff.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("component codes are unique", async () => {
    const t = convexTest(schema);
    await t.action(internal.seed.actions.reset, {});
    const skus = await t.run(async (ctx) => ctx.db.query("pos_inventory_skus").collect());
    const codes = skus.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("product codes are unique", async () => {
    const t = convexTest(schema);
    await t.action(internal.seed.actions.reset, {});
    const products = await t.run(async (ctx) => ctx.db.query("pos_products").collect());
    const codes = products.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

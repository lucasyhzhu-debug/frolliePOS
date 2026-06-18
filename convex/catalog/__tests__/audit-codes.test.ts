// convex/catalog/__tests__/audit-codes.test.ts
import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";

describe("_auditMissingCodes_internal", () => {
  // pos_products.code is now required (v1.1 schema flip — Task 2). A product
  // without code can no longer be inserted at runtime, so productsMissing will
  // always be empty. The test still exercises staffMissing (staff.code is still
  // optional) and confirms the audit query returns empty arrays when all rows
  // have codes.
  it("reports staff rows with a missing code", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_products", { sku_family: "x", code: "X_1PC", name: "Ok", pack_label: "1", price_idr: 1, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 }); // code present — required
      await ctx.db.insert("staff", { name: "NoCode", role: "staff", active: true, pin_hash: "x", created_at: 0 } as any); // code omitted — staff.code still optional
    });
    const out = await t.query(internal.catalog.internal._auditMissingCodes_internal, {});
    expect(out.productsMissing).toHaveLength(0); // code is required — schema guarantees no gaps
    expect(out.staffMissing).toHaveLength(1);
  });
  it("is empty when every row has a code", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_products", { sku_family: "x", code: "X_1PC", name: "Ok", pack_label: "1", price_idr: 1, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 });
      await ctx.db.insert("staff", { name: "Ok", code: "S-0001", role: "staff", active: true, pin_hash: "x", created_at: 0 });
    });
    const out = await t.query(internal.catalog.internal._auditMissingCodes_internal, {});
    expect(out.productsMissing).toHaveLength(0);
    expect(out.staffMissing).toHaveLength(0);
  });
});

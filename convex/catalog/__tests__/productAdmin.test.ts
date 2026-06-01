import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
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

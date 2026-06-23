import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

describe("settings.receiptConfig", () => {
  it("returns defaults when no row exists", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const cfg = await t.query(api.settings.public.getReceiptConfig, { sessionId });
    expect(cfg.business_name).toBe("FROLLIE");
    expect(cfg.logo_url).toBeNull();
  });

  it("persists an update and reads it back", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await t.mutation(api.settings.public.updateReceiptConfig, {
      idempotencyKey: "rc1",
      sessionId,
      business_name: "Frollie Booth",
      address: "Pakuwon",
      contact: "+62 8...",
      instagram_handle: "@frollie.id",
      footer_text: "Makasih!",
    });
    const cfg = await t.query(api.settings.public.getReceiptConfig, { sessionId });
    expect(cfg.business_name).toBe("Frollie Booth");
    expect(cfg.footer_text).toBe("Makasih!");
  });

  it("rendered receipt reflects configured branding", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    // Configure branding before rendering.
    await t.mutation(api.settings.public.updateReceiptConfig, {
      idempotencyKey: "rc3",
      sessionId,
      business_name: "Frollie Pakuwon",
      address: "A",
      contact: "C",
      instagram_handle: "@frollie.id",
      footer_text: "Terima kasih ya!",
    });
    // Seed a paid txn + line with a known receipt_token (pattern copied from
    // convex/receipts/__tests__/http.test.ts / refund-projection.test.ts).
    const token = "tok-branding-render";
    await t.run(async (ctx: any) => {
      const staffId = await ctx.db.insert("staff", {
        code: "S-BR", name: "BR", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const productId = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUB1", name: "Dubai 1pc", pack_label: "1pc",
        price_idr: 50000, active: true, sort_order: 0, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
        outlet_id: outletId,
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId,
        created_at: Date.now(), paid_at: Date.now(),
        receipt_number: "R-2026-BR",
        receipt_token: token,
        outlet_id: outletId,
      });
      await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "DUB1", product_name_snapshot: "Dubai 1pc",
        unit_price_snapshot: 50000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 50000,
        outlet_id: outletId,
      });
    });
    const res = await t.fetch(`/r/${token}`, { method: "GET" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Frollie Pakuwon");
    expect(html).toContain("Terima kasih ya!");
  });

  it("purges the receipt html cache on config update", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    // Seed a fake cache row.
    await t.run(async (ctx: any) => {
      await ctx.db.insert("pos_receipt_html_cache", {
        token: "tok1",
        html: "<html>old</html>",
        expires_at: Date.now() + 1000,
        outlet_id: outletId,
      });
    });
    await t.mutation(api.settings.public.updateReceiptConfig, {
      idempotencyKey: "rc2",
      sessionId,
      business_name: "New",
      address: "A",
      contact: "C",
      instagram_handle: "@x",
      footer_text: "F",
    });
    const remaining = await t.run(async (ctx) =>
      ctx.db.query("pos_receipt_html_cache").collect(),
    );
    expect(remaining).toHaveLength(0);
  });
});

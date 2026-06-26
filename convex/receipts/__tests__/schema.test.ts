import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";

describe("pos_receipt_html_cache schema", () => {
  it("inserts and reads back via by_token index", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx: any) => {
      const outletId = await ctx.db.insert("outlets", { is_open: false,
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as any);
      await ctx.db.insert("pos_receipt_html_cache", {
        token: "tok-abc-123",
        html: "<p>hi</p>",
        expires_at: Date.now() + 86400_000,
        outlet_id: outletId,
      });
      const row = await ctx.db
        .query("pos_receipt_html_cache")
        .withIndex("by_token", (q: any) => q.eq("token", "tok-abc-123"))
        .unique();
      expect(row?.html).toBe("<p>hi</p>");
    });
  });

  it("pos_transactions.receipt_token is optional (existing rows still validate)", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx: any) => {
      const outletId = await ctx.db.insert("outlets", { is_open: false,
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as any);
      // Insert a pos_transactions row WITHOUT receipt_token — mirrors a pre-v0.5.1 row.
      // If schema required the field, this would throw.
      const staffId = await ctx.db.insert("staff", {
        code: "S-T1", name: "Tester", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0,
        staff_id: staffId,
        created_at: Date.now(),
        paid_at: Date.now(),
        outlet_id: outletId,
      });
      const row = await ctx.db.get(txnId);
      expect(row?.receipt_token).toBeUndefined();
    });
  });
});

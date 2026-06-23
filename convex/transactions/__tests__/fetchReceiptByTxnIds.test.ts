import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { seedStaff, seedDefaultOutlet } from "./_helpers";

describe("transactions._fetchReceiptByTxnIds_internal", () => {
  it("returns receipt_number map for paid txns, null for missing", async () => {
    const t = convexTest(schema);
    const outletId = await seedDefaultOutlet(t);
    const staffId = await seedStaff(t, { name: "Sari", role: "staff", code: "S1" });

    const paidId = await t.run(async (ctx) =>
      ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 10_000,
        voucher_discount: 0,
        total: 10_000,
        flags: 0,
        staff_id: staffId,
        receipt_number: "R-2026-0042",
        created_at: 1000,
        paid_at: 1500,
        outlet_id: outletId,
      } as any),
    );

    const draftId = await t.run(async (ctx) =>
      ctx.db.insert("pos_transactions", {
        status: "draft",
        subtotal: 5_000,
        voucher_discount: 0,
        total: 5_000,
        flags: 0,
        staff_id: staffId,
        created_at: 1000,
        outlet_id: outletId,
      } as any),
    );

    const result = await t.query(
      internal.transactions.internal._fetchReceiptByTxnIds_internal,
      { txnIds: [paidId, draftId] },
    );

    expect(result[paidId]).toBe("R-2026-0042");
    expect(result[draftId]).toBeNull();
  });

  it("returns empty record for empty input", async () => {
    const t = convexTest(schema);
    const result = await t.query(
      internal.transactions.internal._fetchReceiptByTxnIds_internal,
      { txnIds: [] },
    );
    expect(result).toEqual({});
  });
});

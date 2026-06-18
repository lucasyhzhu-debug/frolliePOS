// convex/api/v1/__tests__/pagination.test.ts
// Seed 3 paid txns where TWO share the exact same paid_at ms, straddling a
// page boundary at limit=2. Walk pages via nextCursor until null. Assert:
//   - every receiptNumber appears exactly once (no dupes, no gaps)
//   - the two same-ms rows are split correctly across the boundary by _creationTime
import { convexTest } from "convex-test";
import schema from "../../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../../_generated/api";

describe("cursor pagination", () => {
  it("walks all rows once across a same-millisecond page boundary", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "staff", active: true, pin_hash: "x", created_at: 0 });
      const mk = async (rn: string, paidAt: number) => {
        await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 1, voucher_discount: 0, total: 1, flags: 0, staff_id: s, created_at: 0, paid_at: paidAt, receipt_number: rn });
      };
      await mk("R-2026-0001", 100);
      await mk("R-2026-0002", 200);   // same ms as next
      await mk("R-2026-0003", 200);
    });
    const seen: string[] = [];
    let cursor: { orderKeyMs: number; creationTime: number } | undefined;
    for (let i = 0; i < 10; i++) {
      const out = await t.query(internal.transactions.internal._listPaidTxnsForApi_internal, {
        afterPaidAtMs: cursor?.orderKeyMs, afterCreationTime: cursor?.creationTime, limit: 2 });
      out.rows.forEach((r: any) => seen.push(r.receiptNumber));
      if (!out.nextCursor) break;
      const { decodeCursor } = await import("../../../lib/apiCursor");
      cursor = decodeCursor(out.nextCursor);
    }
    expect(seen.sort()).toEqual(["R-2026-0001", "R-2026-0002", "R-2026-0003"]);
    expect(new Set(seen).size).toBe(3);  // no duplicates
  });
});

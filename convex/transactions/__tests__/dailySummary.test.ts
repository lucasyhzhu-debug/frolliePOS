import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

it("aggregates paid txns inside the WIB day window", async () => {
  const t = convexTest(schema);
  const now = Date.now();
  await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "L",
      pin_hash: "x",
      role: "staff",
      active: true,
      created_at: now,
    });

    const base = {
      subtotal: 100_000,
      voucher_discount: 0,
      total: 100_000,
      staff_id: staffId,
      created_at: now,
    };

    // In-window: paid, flags=0 (row 1)
    await ctx.db.insert("pos_transactions", {
      ...base,
      status: "paid",
      flags: 0,
      paid_at: now,
    });

    // In-window: paid, flags=0 (row 2)
    await ctx.db.insert("pos_transactions", {
      ...base,
      status: "paid",
      flags: 0,
      paid_at: now,
    });

    // In-window: paid, flags=1 (NEG_STOCK bit → flagged)
    await ctx.db.insert("pos_transactions", {
      ...base,
      status: "paid",
      flags: 1,
      paid_at: now,
    });

    // In-window but NOT paid (awaiting_payment — must NOT count)
    await ctx.db.insert("pos_transactions", {
      ...base,
      status: "awaiting_payment",
      flags: 0,
    });

    // Out-of-window: paid but paid_at is 2 days ago
    await ctx.db.insert("pos_transactions", {
      ...base,
      status: "paid",
      flags: 0,
      paid_at: now - 2 * 86_400_000,
    });
  });

  const res = await t.query(
    internal.transactions.internal._dailySalesSummary_internal,
    { dayStartMs: now - 60_000, dayEndMs: now + 86_400_000 },
  );

  expect(res.txnCount).toBe(3); // 3 paid in-window
  expect(res.totalSalesIdr).toBe(300_000); // 3 × 100_000
  expect(res.flaggedCount).toBe(1); // the one with flags=1
});

it("returns zeros when no paid txns in the window", async () => {
  const t = convexTest(schema);
  const res = await t.query(
    internal.transactions.internal._dailySalesSummary_internal,
    { dayStartMs: 0, dayEndMs: 1 },
  );
  expect(res.totalSalesIdr).toBe(0);
  expect(res.txnCount).toBe(0);
  expect(res.flaggedCount).toBe(0);
});

it("includes cross-midnight late-paid sales (created day N, paid day N+1)", async () => {
  // Regression test: the prior by_status_created + 1h-backstop implementation
  // silently dropped rows where created_at was >1h before dayStartMs even when
  // paid_at fell inside the window. by_status_paid_at scopes on paid_at directly.
  const t = convexTest(schema);
  const dayStart = 1_700_000_000_000;
  const dayEnd = dayStart + 86_400_000;
  const created = dayStart - 6 * 60 * 60 * 1000; // 6h BEFORE the day starts
  const paid = dayStart + 30 * 60 * 1000;        // 30m INTO the day

  await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "L", pin_hash: "x", role: "staff", active: true, created_at: created,
    });
    await ctx.db.insert("pos_transactions", {
      subtotal: 80_000, voucher_discount: 0, total: 80_000,
      staff_id: staffId, status: "paid", flags: 0,
      created_at: created, paid_at: paid,
    });
  });

  const res = await t.query(
    internal.transactions.internal._dailySalesSummary_internal,
    { dayStartMs: dayStart, dayEndMs: dayEnd },
  );
  expect(res.txnCount).toBe(1);
  expect(res.totalSalesIdr).toBe(80_000);
});

/**
 * Tests for _manualBcaReconciliation_internal
 *
 * Contract: query pos_transactions via by_status_paid_at (status="paid",
 * paid_at in [dayStartMs, dayEndMs)), JS-filter confirmed_via === "manual_bca",
 * sort chronological by paid_at, resolve staff names resilently (fallback
 * "Staff" on missing), reduce totalIdr.
 *
 * Optional-field filter gotcha: confirmed_via is optional — we collect then
 * filter in JS, never q.eq on the optional field (MEMORY).
 */
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

const DAY_START = 1_700_000_000_000;
const DAY_END = DAY_START + 86_400_000;

it("counts and itemises only manual_bca txns in the window, chronologically", async () => {
  const t = convexTest(schema);

  let staffAId!: string;
  let staffBId!: string;

  await t.run(async (ctx) => {
    staffAId = await ctx.db.insert("staff", {
      name: "Alice",
      code: "S-ALC",
      pin_hash: "x",
      role: "staff" as const,
      active: true,
      created_at: DAY_START,
    } as any);
    staffBId = await ctx.db.insert("staff", {
      name: "Bob",
      code: "S-BOB",
      pin_hash: "x",
      role: "staff" as const,
      active: true,
      created_at: DAY_START,
    } as any);

    const base = {
      subtotal: 100_000,
      voucher_discount: 0,
      total: 100_000,
      flags: 0,
      created_at: DAY_START,
    };

    // IN-WINDOW, manual_bca — should appear (paid_at = T+1h, "Alice")
    await ctx.db.insert("pos_transactions", {
      ...base,
      total: 75_000,
      subtotal: 75_000,
      staff_id: staffAId,
      status: "paid",
      paid_at: DAY_START + 3_600_000, // T+1h
      confirmed_via: "manual_bca",
      receipt_number: "R-2023-0001",
    } as any);

    // IN-WINDOW, manual_bca — should appear (paid_at = T+2h, "Bob")
    await ctx.db.insert("pos_transactions", {
      ...base,
      total: 50_000,
      subtotal: 50_000,
      staff_id: staffBId,
      status: "paid",
      paid_at: DAY_START + 7_200_000, // T+2h
      confirmed_via: "manual_bca",
      receipt_number: "R-2023-0002",
    } as any);

    // IN-WINDOW, webhook — must NOT appear (different confirmed_via)
    await ctx.db.insert("pos_transactions", {
      ...base,
      staff_id: staffAId,
      status: "paid",
      paid_at: DAY_START + 1_000,
      confirmed_via: "webhook",
      receipt_number: "R-2023-0003",
    } as any);

    // IN-WINDOW, manual — must NOT appear
    await ctx.db.insert("pos_transactions", {
      ...base,
      staff_id: staffAId,
      status: "paid",
      paid_at: DAY_START + 2_000,
      confirmed_via: "manual",
      receipt_number: "R-2023-0004",
    } as any);

    // OUT-OF-WINDOW, manual_bca — must NOT appear (paid_at before dayStart)
    await ctx.db.insert("pos_transactions", {
      ...base,
      staff_id: staffAId,
      status: "paid",
      paid_at: DAY_START - 1,
      confirmed_via: "manual_bca",
      receipt_number: "R-2023-0005",
    } as any);

    // OUT-OF-WINDOW, manual_bca — must NOT appear (paid_at >= dayEnd)
    await ctx.db.insert("pos_transactions", {
      ...base,
      staff_id: staffAId,
      status: "paid",
      paid_at: DAY_END,
      confirmed_via: "manual_bca",
      receipt_number: "R-2023-0006",
    } as any);

    // IN-WINDOW, awaiting_payment with confirmed_via absent — must NOT appear (not paid)
    await ctx.db.insert("pos_transactions", {
      ...base,
      staff_id: staffAId,
      status: "awaiting_payment",
      created_at: DAY_START + 500,
    } as any);
  });

  const res = await t.query(
    internal.transactions.internal._manualBcaReconciliation_internal,
    { dayStartMs: DAY_START, dayEndMs: DAY_END },
  );

  expect(res.count).toBe(2);
  expect(res.totalIdr).toBe(125_000); // 75_000 + 50_000

  // Chronological order: T+1h Alice first, T+2h Bob second
  expect(res.items).toHaveLength(2);
  expect(res.items[0].staffName).toBe("Alice");
  expect(res.items[0].total).toBe(75_000);
  expect(res.items[0].receiptNumber).toBe("R-2023-0001");
  expect(res.items[1].staffName).toBe("Bob");
  expect(res.items[1].total).toBe(50_000);
  expect(res.items[1].receiptNumber).toBe("R-2023-0002");
  // paid_at is a number
  expect(typeof res.items[0].paidAt).toBe("number");
});

it("returns empty tally when no manual_bca txns in window", async () => {
  const t = convexTest(schema);

  const res = await t.query(
    internal.transactions.internal._manualBcaReconciliation_internal,
    { dayStartMs: DAY_START, dayEndMs: DAY_END },
  );

  expect(res.count).toBe(0);
  expect(res.totalIdr).toBe(0);
  expect(res.items).toHaveLength(0);
});

it("falls back to 'Staff' when staff row is missing (resilient for EOD cron)", async () => {
  const t = convexTest(schema);

  await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Temp",
      code: "S-TMP",
      pin_hash: "x",
      role: "staff" as const,
      active: true,
      created_at: DAY_START,
    } as any);

    await ctx.db.insert("pos_transactions", {
      subtotal: 30_000,
      voucher_discount: 0,
      total: 30_000,
      flags: 0,
      staff_id: staffId,
      created_at: DAY_START,
      status: "paid",
      paid_at: DAY_START + 1_000,
      confirmed_via: "manual_bca",
      receipt_number: "R-2023-0010",
    } as any);

    // Delete the staff row to simulate hard-delete (resilience test)
    await ctx.db.delete(staffId);
  });

  const res = await t.query(
    internal.transactions.internal._manualBcaReconciliation_internal,
    { dayStartMs: DAY_START, dayEndMs: DAY_END },
  );

  expect(res.count).toBe(1);
  expect(res.items[0].staffName).toBe("Staff"); // resilient fallback
  expect(res.items[0].total).toBe(30_000);
});

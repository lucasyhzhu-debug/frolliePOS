/**
 * Triple-review FIX 2 (spec §2): stale-shift auto-close on open-from-CLOSED.
 *
 * When the latest shift event is a non-closed event from a PRIOR WIB day,
 * completeStartOfDay must:
 *   (a) record a `signoff_close` event with `stale_autoclose: true` for the
 *       DISPLACED staff, carrying that shift's summary (non-zero sales),
 *   (b) schedule the displaced staff's Founders summary (_sendSignoffSummary),
 *   (c) then open today's shift for the incoming staff.
 *
 * Telegram is stubbed; the scheduled summary is drained so it resolves offline.
 */

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { wibDayWindow } from "../../lib/time";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

setupTelegramStub();

async function seedStaff(
  t: ReturnType<typeof convexTest>,
  name: string,
  code: string,
): Promise<Id<"staff">> {
  return t.run((ctx) =>
    ctx.db.insert("staff", {
      name,
      code,
      role: "staff",
      pin_hash: "x",
      active: true,
      must_change_pin: false,
      created_at: 0,
    } as any),
  );
}

test("completeStartOfDay auto-closes a prior-WIB-day open shift, fires its summary, then opens for the new staff", async () => {
  const t = convexTest(schema);

  const staffA = await seedStaff(t, "Budi", "S-0002"); // displaced (forgot to close)
  const staffB = await seedStaff(t, "Sari", "S-0003"); // morning arrival

  const now = Date.now();
  const priorStart = now - 2 * 86_400_000; // 2 WIB days ago — definitely stale

  // Seed a prior-day start_of_day event for staff A (booth left OPEN overnight).
  await t.run((ctx) =>
    ctx.db.insert("pos_shift_events", {
      device_id: "d1",
      type: "start_of_day",
      staff_id: staffA,
      shift_started_at: priorStart,
      shift_ended_at: null,
      steps: [],
      count_changed: null,
      takeover: null,
      outgoing_uncounted: null,
      stale_autoclose: null,
      linked_event_id: null,
      summary: null,
      created_at: priorStart,
    }),
  );

  // A PAID transaction inside the stale shift window (priorStart .. WIB end-of-day).
  const paidAt = priorStart + 3_600_000; // +1h, same WIB day as priorStart
  await t.run((ctx) =>
    ctx.db.insert("pos_transactions", {
      status: "paid",
      flags: 0,
      subtotal: 75_000,
      voucher_discount: 0,
      total: 75_000,
      staff_id: staffA,
      paid_at: paidAt,
      created_at: paidAt,
    } as any),
  );

  // Staff B signs in to the (stale) booth and completes start-of-day.
  const bSession = await t.run((ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: staffB,
      device_id: "d1",
      started_at: now,
      ended_at: null,
      end_reason: null,
    }),
  );
  const res = await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "sod-stale-1",
    sessionId: bSession,
    steps: [],
    countChanged: undefined,
  });
  expect(res.ok).toBe(true);

  // (a) A stale_autoclose signoff_close event exists for staff A with non-zero sales.
  const events = await t.run((ctx) =>
    ctx.db
      .query("pos_shift_events")
      .withIndex("by_device_created", (q) => q.eq("device_id", "d1"))
      .order("asc")
      .collect(),
  );
  const stale = events.find(
    (e) => e.type === "signoff_close" && e.stale_autoclose === true,
  );
  expect(stale).toBeDefined();
  expect(String(stale!.staff_id)).toBe(String(staffA));
  expect(stale!.summary?.totalSalesIdr).toBe(75_000);
  expect(stale!.summary?.txnCount).toBe(1);
  // Window end clamps to the stale day's WIB end (event had no shift_ended_at).
  expect(stale!.shift_ended_at).toBe(wibDayWindow(priorStart).dayEndMs);

  // (b) A _sendSignoffSummary was scheduled.
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  const summaryJob = jobs.find((j) =>
    (j.name as string).includes("_sendSignoffSummary"),
  );
  expect(summaryJob).toBeDefined();

  // (c) Booth is now OPEN for staff B.
  const booth = await t.query(api.shifts.public.boothState, { deviceId: "d1" });
  expect(booth.state).toBe("open");
  expect(String(booth.staffId)).toBe(String(staffB));

  await drainScheduled(t);
});

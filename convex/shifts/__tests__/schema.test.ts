import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import type { Id } from "../../_generated/dataModel";

test("pos_shift_events round-trips a start_of_day row", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any);
    const staffId = await ctx.db.insert("staff", {
      name: "Budi",
      code: "S-0002",
      role: "staff",
      pin_hash: "x",
      active: true,
      must_change_pin: false,
      created_at: 0,
    } as any);
    return ctx.db.insert("pos_shift_events", {
      device_id: "dev-booth-device",
      type: "start_of_day",
      staff_id: staffId,
      shift_started_at: 1000,
      shift_ended_at: null,
      steps: [{ key: "count", label: "Hitung stok", type: "count", confirmed_at: 1000 }],
      count_changed: 1,
      takeover: null,
      outgoing_uncounted: null,
      stale_autoclose: null,
      linked_event_id: null,
      summary: null,
      created_at: 1000,
      outlet_id: outletId,
    });
  }) as Id<"pos_shift_events">;
  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.type).toBe("start_of_day");
});

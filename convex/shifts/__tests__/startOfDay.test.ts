import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

async function seedActiveSession(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Budi",
      code: "S-0002",
      role: "staff",
      pin_hash: "x",
      active: true,
      must_change_pin: false,
      created_at: 0,
    } as any);
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: "d1",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
    });
    return { staffId, sessionId };
  });
}

test("completeStartOfDay records an open event for the device", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedActiveSession(t);
  const res = await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1",
    sessionId,
    steps: [{ key: "count", label: "Hitung stok", type: "count", confirmed_at: Date.now() }],
    countChanged: 1,
  });
  expect(res.ok).toBe(true);
  expect(typeof res.eventId).toBe("string");
  expect((await t.query(api.shifts.public.boothState, { deviceId: "d1" })).state).toBe("open");
});

test("completeStartOfDay rejects an ended session", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedActiveSession(t);
  await t.run((ctx) =>
    ctx.db.patch(sessionId as Id<"staff_sessions">, {
      ended_at: Date.now(),
      end_reason: "manual_lock",
    }),
  );
  await expect(
    t.mutation(api.shifts.public.completeStartOfDay, {
      idempotencyKey: "k2",
      sessionId,
      steps: [],
      countChanged: undefined,
    }),
  ).rejects.toThrow(/NO_SESSION/);
});

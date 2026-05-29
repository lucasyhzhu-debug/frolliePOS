import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";

it("defaults founders_summary_enabled to true when the row is absent", async () => {
  const t = convexTest(schema);
  const s = await t.query(api.settings.public.getSettings, {});
  expect(s.founders_summary_enabled).toBe(true);
});

it("manager toggles the flag; staff is rejected", async () => {
  const t = convexTest(schema);
  const { mgr, staff } = await t.run(async (ctx) => ({
    mgr: await ctx.db.insert("staff_sessions", {
      staff_id: await ctx.db.insert("staff", {
        name: "M",
        code: "S-1",
        role: "manager",
        active: true,
        pin_hash: "x",
        created_at: Date.now(),
      }),
      device_id: "d",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
    }),
    staff: await ctx.db.insert("staff_sessions", {
      staff_id: await ctx.db.insert("staff", {
        name: "S",
        code: "S-2",
        role: "staff",
        active: true,
        pin_hash: "x",
        created_at: Date.now(),
      }),
      device_id: "d",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
    }),
  }));
  await t.mutation(api.settings.public.setFoundersSummaryEnabled, {
    sessionId: mgr,
    enabled: false,
  });
  expect(
    (await t.query(api.settings.public.getSettings, {})).founders_summary_enabled,
  ).toBe(false);
  await expect(
    t.mutation(api.settings.public.setFoundersSummaryEnabled, {
      sessionId: staff,
      enabled: true,
    }),
  ).rejects.toThrow(/MANAGER_ONLY/);
});

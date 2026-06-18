import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

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
    idempotencyKey: "toggle-1",
    sessionId: mgr,
    enabled: false,
  });
  expect(
    (await t.query(api.settings.public.getSettings, {})).founders_summary_enabled,
  ).toBe(false);
  await expect(
    t.mutation(api.settings.public.setFoundersSummaryEnabled, {
      idempotencyKey: "toggle-2",
      sessionId: staff,
      enabled: true,
    }),
  ).rejects.toThrow(/MANAGER_ONLY/);
});

describe("txn_ticker_enabled", () => {
  it("defaults txn_ticker_enabled true when row absent", async () => {
    const t = convexTest(schema);
    const s = await t.query(internal.settings.internal._getSettings_internal, {});
    expect(s.txn_ticker_enabled).toBe(true);
  });

  it("returns false when row has txn_ticker_enabled: false", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_settings", {
        founders_summary_enabled: true,
        txn_ticker_enabled: false,
        updated_at: Date.now(),
      });
    });
    const s = await t.query(internal.settings.internal._getSettings_internal, {});
    expect(s.txn_ticker_enabled).toBe(false);
  });
});

it("setFoundersSummaryEnabled replays the cached result for the same idempotencyKey without re-auditing", async () => {
  const t = convexTest(schema);
  const mgr = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "M", code: "S-1", role: "manager", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    return await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d",
      started_at: Date.now(), ended_at: null, end_reason: null,
    });
  });
  const r1 = await t.mutation(api.settings.public.setFoundersSummaryEnabled, {
    idempotencyKey: "replay-1", sessionId: mgr, enabled: false,
  });
  const r2 = await t.mutation(api.settings.public.setFoundersSummaryEnabled, {
    idempotencyKey: "replay-1", sessionId: mgr, enabled: false,
  });
  expect(r2).toEqual(r1);
  // Only ONE audit row for a same-key retry (ADR-013 + ADR-007).
  const audits = await t.run((ctx) =>
    ctx.db
      .query("audit_log")
      .filter((q) => q.eq(q.field("action"), "settings.founders_summary_toggled"))
      .collect(),
  );
  expect(audits.length).toBe(1);
});

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

async function makeOutlet(t: ReturnType<typeof convexTest>): Promise<Id<"outlets">> {
  return t.run((ctx: any) =>
    ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any),
  ) as Promise<Id<"outlets">>;
}

it("defaults founders_summary_enabled to true when the row is absent", async () => {
  const t = convexTest(schema);
  const s = await t.query(api.settings.public.getSettings, {});
  expect(s.founders_summary_enabled).toBe(true);
});

it("manager toggles the flag; staff is rejected", async () => {
  const t = convexTest(schema);
  const outletId = await makeOutlet(t);
  const { mgr, staff } = await t.run(async (ctx: any) => ({
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
      outlet_id: outletId,
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
      outlet_id: outletId,
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
    const outletId = await makeOutlet(t);
    const s = await t.query(internal.settings.internal._getSettings_internal, { outletId });
    expect(s.txn_ticker_enabled).toBe(true);
  });

  it("returns false when row has txn_ticker_enabled: false", async () => {
    const t = convexTest(schema);
    const outletId = await makeOutlet(t);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("pos_settings", {
        founders_summary_enabled: true,
        txn_ticker_enabled: false,
        updated_at: Date.now(),
        outlet_id: outletId,
      });
    });
    const s = await t.query(internal.settings.internal._getSettings_internal, { outletId });
    expect(s.txn_ticker_enabled).toBe(false);
  });
});

it("getSettings surfaces txn_ticker_enabled (default true when row absent)", async () => {
  const t = convexTest(schema);
  const s = await t.query(api.settings.public.getSettings, {});
  expect(s.txn_ticker_enabled).toBe(true);
});

describe("setTxnTickerEnabled", () => {
  async function seedSessions(t: ReturnType<typeof convexTest>) {
    const outletId = await makeOutlet(t);
    return await t.run(async (ctx: any) => ({
      mgr: await ctx.db.insert("staff_sessions", {
        staff_id: await ctx.db.insert("staff", {
          name: "M", code: "S-1", role: "manager", active: true,
          pin_hash: "x", created_at: Date.now(),
        }),
        device_id: "d", started_at: Date.now(), ended_at: null, end_reason: null,
        outlet_id: outletId,
      }),
      staff: await ctx.db.insert("staff_sessions", {
        staff_id: await ctx.db.insert("staff", {
          name: "S", code: "S-2", role: "staff", active: true,
          pin_hash: "x", created_at: Date.now(),
        }),
        device_id: "d", started_at: Date.now(), ended_at: null, end_reason: null,
        outlet_id: outletId,
      }),
    }));
  }

  it("manager flips the flag; staff is rejected", async () => {
    const t = convexTest(schema);
    const { mgr, staff } = await seedSessions(t);
    await t.mutation(api.settings.public.setTxnTickerEnabled, {
      idempotencyKey: "tk-1", sessionId: mgr, enabled: false,
    });
    expect((await t.query(api.settings.public.getSettings, {})).txn_ticker_enabled).toBe(false);
    await t.mutation(api.settings.public.setTxnTickerEnabled, {
      idempotencyKey: "tk-2", sessionId: mgr, enabled: true,
    });
    expect((await t.query(api.settings.public.getSettings, {})).txn_ticker_enabled).toBe(true);
    await expect(
      t.mutation(api.settings.public.setTxnTickerEnabled, {
        idempotencyKey: "tk-3", sessionId: staff, enabled: false,
      }),
    ).rejects.toThrow(/MANAGER_ONLY/);
  });

  it("insert branch defaults founders_summary_enabled to true (not clobbered)", async () => {
    const t = convexTest(schema);
    const { mgr } = await seedSessions(t);
    await t.mutation(api.settings.public.setTxnTickerEnabled, {
      idempotencyKey: "tk-ins", sessionId: mgr, enabled: false,
    });
    const s = await t.query(api.settings.public.getSettings, {});
    expect(s.txn_ticker_enabled).toBe(false);
    expect(s.founders_summary_enabled).toBe(true);
  });

  it("replays cached result for the same idempotencyKey without re-auditing", async () => {
    const t = convexTest(schema);
    const { mgr } = await seedSessions(t);
    const r1 = await t.mutation(api.settings.public.setTxnTickerEnabled, {
      idempotencyKey: "tk-replay", sessionId: mgr, enabled: false,
    });
    const r2 = await t.mutation(api.settings.public.setTxnTickerEnabled, {
      idempotencyKey: "tk-replay", sessionId: mgr, enabled: false,
    });
    expect(r2).toEqual(r1);
    const audits = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .filter((q) => q.eq(q.field("action"), "settings.txn_ticker_toggled"))
        .collect(),
    );
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0].metadata as string)).toEqual({ enabled: false });
  });
});

it("setFoundersSummaryEnabled replays the cached result for the same idempotencyKey without re-auditing", async () => {
  const t = convexTest(schema);
  const outletId = await makeOutlet(t);
  const mgr = await t.run(async (ctx: any) => {
    const staffId = await ctx.db.insert("staff", {
      name: "M", code: "S-1", role: "manager", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    return await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d",
      started_at: Date.now(), ended_at: null, end_reason: null,
      outlet_id: outletId,
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

it("_getSettings_internal returns manual_bca defaults when row absent", async () => {
  const t = convexTest(schema);
  const outletId = await makeOutlet(t);
  const s = await t.query(internal.settings.internal._getSettings_internal, { outletId });
  expect(s.manual_bca.enabled).toBe(true);
  expect(s.manual_bca.bank_name).toBe("BCA");
  expect(s.manual_bca.account_name).toBe("EXAMPLE COMPANY");
  expect(s.manual_bca.account_number).toBe("0000000000");
});

// ─── manual-BCA config (v1.2 #10 T4) ────────────────────────────────────────
describe("manual-BCA", () => {
  async function seedSessions(t: ReturnType<typeof convexTest>) {
    const outletId = await makeOutlet(t);
    return t.run(async (ctx: any) => {
      const mgrStaffId = await ctx.db.insert("staff", {
        name: "M", code: "S-M1", role: "manager", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const staffStaffId = await ctx.db.insert("staff", {
        name: "S", code: "S-S1", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const mgr = await ctx.db.insert("staff_sessions", {
        staff_id: mgrStaffId, device_id: "d",
        started_at: Date.now(), ended_at: null, end_reason: null,
        outlet_id: outletId,
      });
      const staff = await ctx.db.insert("staff_sessions", {
        staff_id: staffStaffId, device_id: "d",
        started_at: Date.now(), ended_at: null, end_reason: null,
        outlet_id: outletId,
      });
      return { mgr, staff };
    });
  }

  it("getManualBcaConfig returns defaults (manager-only)", async () => {
    const t = convexTest(schema);
    const { mgr, staff } = await seedSessions(t);
    const cfg = await t.query(api.settings.public.getManualBcaConfig, { sessionId: mgr });
    expect(cfg.enabled).toBe(true);
    expect(cfg.bank_name).toBe("BCA");
    expect(cfg.account_name).toBe("EXAMPLE COMPANY");
    expect(cfg.account_number).toBe("0000000000");
    await expect(
      t.query(api.settings.public.getManualBcaConfig, { sessionId: staff }),
    ).rejects.toThrow("MANAGER_ONLY");
  });

  it("getManualBcaAccount is readable by any active staff", async () => {
    const t = convexTest(schema);
    const { mgr, staff } = await seedSessions(t);
    const cfgMgr = await t.query(api.settings.public.getManualBcaAccount, { sessionId: mgr });
    expect(cfgMgr.account_number).toBe("0000000000");
    const cfgStaff = await t.query(api.settings.public.getManualBcaAccount, { sessionId: staff });
    expect(cfgStaff.account_number).toBe("0000000000");
  });

  it("_updateManualBcaConfig_internal persists + audits as system; validates fields", async () => {
    const t = convexTest(schema);
    const { mgr } = await seedSessions(t);

    // The account is written ONLY via the internal mutation (ops/dashboard) — no
    // session, no public writer (a money destination must not be client-editable).
    await t.mutation(internal.settings.internal._updateManualBcaConfig_internal, {
      enabled: false,
      bank_name: "BNI",
      account_name: "PT Test",
      account_number: "1234567890",
    });
    const cfg = await t.query(api.settings.public.getManualBcaConfig, { sessionId: mgr });
    expect(cfg.enabled).toBe(false);
    expect(cfg.bank_name).toBe("BNI");
    expect(cfg.account_number).toBe("1234567890");

    // audit row emitted with the system actor + backend marker
    const audits = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .filter((q) => q.eq(q.field("action"), "settings.manual_bca_updated"))
        .collect(),
    );
    expect(audits.length).toBe(1);
    expect(audits[0].actor_id).toBe("system");
    expect(JSON.parse(audits[0].metadata as string)).toEqual({ enabled: false, via: "backend" });

    // FIELD_TOO_LONG enforced for account_name > 120 chars
    await expect(
      t.mutation(internal.settings.internal._updateManualBcaConfig_internal, {
        enabled: true, bank_name: "B", account_name: "x".repeat(121), account_number: "0",
      }),
    ).rejects.toThrow(/FIELD_TOO_LONG/);

    // FIELD_REQUIRED enforced for a blank/whitespace-only account_number
    await expect(
      t.mutation(internal.settings.internal._updateManualBcaConfig_internal, {
        enabled: true, bank_name: "BCA", account_name: "EXAMPLE COMPANY", account_number: "   ",
      }),
    ).rejects.toThrow(/FIELD_REQUIRED:account_number/);
  });
});

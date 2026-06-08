import { describe, it, expect } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

type T = TestConvex<typeof schema>;

async function rowFor(t: T, date: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("pos_settlements")
      .withIndex("by_settlement_key", (q) =>
        q.eq("settlement_key", `settle-${date}`),
      )
      .first(),
  );
}

describe("settlements._upsertSettlementDay_internal", () => {
  it("inserts a poll row, then re-runs in place (no duplicate)", async () => {
    const t = convexTest(schema);
    const args = {
      settlement_date: "2026-06-05",
      gross_amount: 135000,
      mdr_amount: 945,
      net_amount: 134055,
      transaction_count: 2,
      source: "xendit_poll" as const,
      payload: "[]",
    };
    await t.mutation(
      internal.settlements.internal._upsertSettlementDay_internal,
      args,
    );
    await t.mutation(
      internal.settlements.internal._upsertSettlementDay_internal,
      { ...args, gross_amount: 200000, net_amount: 199055 },
    );
    const all = await t.run((ctx) =>
      ctx.db.query("pos_settlements").collect(),
    );
    expect(all).toHaveLength(1);
    expect(all[0].gross_amount).toBe(200000);
  });

  it("poll over manual: overwrites amounts, flips source, preserves created_at, audits supersede", async () => {
    const t = convexTest(schema);
    // Seed a manager staff row — code is optional; created_at is required
    const staffId = await t.run((ctx) =>
      ctx.db.insert("staff", {
        name: "M",
        code: "S-0001",
        role: "manager",
        active: true,
        pin_hash: "x",
        created_at: 1,
      }),
    );
    await t.mutation(
      internal.settlements.internal._upsertSettlementDay_internal,
      {
        settlement_date: "2026-06-05",
        gross_amount: 100000,
        mdr_amount: 700,
        net_amount: 99300,
        transaction_count: 1,
        source: "manual",
        entered_by: staffId,
      },
    );
    const before = await rowFor(t, "2026-06-05");
    await t.mutation(
      internal.settlements.internal._upsertSettlementDay_internal,
      {
        settlement_date: "2026-06-05",
        gross_amount: 135000,
        mdr_amount: 945,
        net_amount: 134055,
        transaction_count: 2,
        source: "xendit_poll",
        payload: "[]",
      },
    );
    const after = await rowFor(t, "2026-06-05");
    expect(after!.source).toBe("xendit_poll");
    expect(after!.gross_amount).toBe(135000);
    expect(after!.created_at).toBe(before!.created_at);
    // The stale manual entered_by must be cleared when flipping to a poll row —
    // a machine-sourced row should not carry a phantom human actor.
    expect(after!.entered_by).toBeUndefined();
    const audits = await t.run((ctx) => ctx.db.query("audit_log").collect());
    expect(
      audits.some((a) => a.action === "settlement.poll_superseded_manual"),
    ).toBe(true);
  });

  it("manual over poll: patches in place, audits settlement.upserted (NOT the supersede verb)", async () => {
    const t = convexTest(schema);
    const staffId = await t.run((ctx) =>
      ctx.db.insert("staff", {
        name: "M",
        code: "S-0001",
        role: "manager",
        active: true,
        pin_hash: "x",
        created_at: 1,
      }),
    );
    // Poll lands first, then a manager hand-corrects the same day.
    await t.mutation(
      internal.settlements.internal._upsertSettlementDay_internal,
      {
        settlement_date: "2026-06-05",
        gross_amount: 135000,
        mdr_amount: 945,
        net_amount: 134055,
        transaction_count: 2,
        source: "xendit_poll",
        payload: "[]",
      },
    );
    await t.mutation(
      internal.settlements.internal._upsertSettlementDay_internal,
      {
        settlement_date: "2026-06-05",
        gross_amount: 100000,
        mdr_amount: 700,
        net_amount: 99300,
        transaction_count: 1,
        source: "manual",
        entered_by: staffId,
      },
    );
    const after = await rowFor(t, "2026-06-05");
    expect(after!.source).toBe("manual");
    expect(after!.gross_amount).toBe(100000);
    const all = await t.run((ctx) =>
      ctx.db.query("pos_settlements").collect(),
    );
    expect(all).toHaveLength(1); // patched in place, no duplicate
    const audits = await t.run((ctx) => ctx.db.query("audit_log").collect());
    // manual-over-poll is a plain upsert — the supersede verb is poll-over-manual only.
    expect(
      audits.some((a) => a.action === "settlement.poll_superseded_manual"),
    ).toBe(false);
    expect(audits.some((a) => a.action === "settlement.upserted")).toBe(true);
  });
});

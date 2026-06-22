// convex/migrations/__tests__/backfill.test.ts
//
// Tests for Stream 9 Steps 0 & 2: seedDefaultOutlet + backfillOutletId.
//
// Coverage:
//   (a) seedDefaultOutlet is idempotent — calling it twice yields no second PKW row
//   (b) backfill stamps operational rows AND skips exclusion-list tables (C1 test)
//   (c) active staff_sessions are stamped
//   (d) assertZeroNullOutletIds flips true after backfill

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

// ── (a) seedDefaultOutlet idempotency ────────────────────────────────────────

describe("seedDefaultOutlet", () => {
  it("is idempotent — calling twice yields exactly one PKW row", async () => {
    const t = convexTest(schema);

    const id1 = await t.mutation(internal.migrations.internal.seedDefaultOutlet, {});
    const id2 = await t.mutation(internal.migrations.internal.seedDefaultOutlet, {});

    expect(id1).toBe(id2);

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("outlets").collect();
      const pkwRows = rows.filter((r) => r.code === "PKW");
      expect(pkwRows).toHaveLength(1);
      expect(pkwRows[0].name).toBe("Frollie — Pakuwon");
      expect(pkwRows[0].timezone).toBe("Asia/Jakarta");
      expect(pkwRows[0].active).toBe(true);
      expect(pkwRows[0].created_by).toBeNull();
    });
  });
});

// ── (b) C1: exclusion-list tables are never touched ──────────────────────────

describe("backfillOutletId — C1 exclusion-list", () => {
  it("does NOT stamp outlet_id on pos_settlements or audit_log rows", async () => {
    const t = convexTest(schema);

    // Seed a pos_settlements row without outlet_id (exclusion-list table).
    let settlementId: string;
    let auditLogId: string;

    await t.run(async (ctx) => {
      const now = Date.now();
      settlementId = await ctx.db.insert("pos_settlements", {
        settlement_key: "settle-2026-06-22",
        settlement_date: "2026-06-22",
        gross_amount: 100000,
        mdr_amount: 500,
        net_amount: 99500,
        transaction_count: 1,
        source: "manual",
        created_at: now,
      }) as unknown as string;

      auditLogId = await ctx.db.insert("audit_log", {
        actor_id: "system",
        action: "test.event",
        entity_type: "test",
        source: "system",
        created_at: now,
      }) as unknown as string;
    });

    // Run the backfill action.
    await t.action(internal.migrations.internal.backfillOutletId, {});

    // Assert those rows still have NO outlet_id.
    await t.run(async (ctx) => {
      const settlement = await ctx.db.get(settlementId as any);
      expect((settlement as any)?.outlet_id).toBeUndefined();

      const auditRow = await ctx.db.get(auditLogId as any);
      expect((auditRow as any)?.outlet_id).toBeUndefined();
    });
  });
});

// ── (c) active staff_sessions are stamped ────────────────────────────────────

describe("backfillOutletId — staff_sessions", () => {
  it("stamps active staff_sessions with the default outlet id", async () => {
    const t = convexTest(schema);

    let sessionId: string;

    await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        name: "Test",
        code: "S-0001",
        pin_hash: "x",
        role: "staff",
        active: true,
        created_at: Date.now(),
      });

      // Active session (no outlet_id yet — pre-backfill state)
      sessionId = await ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-001",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        // outlet_id intentionally absent
      }) as unknown as string;
    });

    await t.action(internal.migrations.internal.backfillOutletId, {});

    await t.run(async (ctx) => {
      const session = await ctx.db.get(sessionId as any);
      expect((session as any)?.outlet_id).toBeDefined();
    });
  });
});

// ── (d) assertZeroNullOutletIds flips true after backfill ───────────────────

describe("assertZeroNullOutletIds", () => {
  it("returns false before backfill when a row has no outlet_id", async () => {
    const t = convexTest(schema);

    await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        name: "A",
        code: "S-0002",
        pin_hash: "x",
        role: "staff",
        active: true,
        created_at: Date.now(),
      });

      await ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-002",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        // outlet_id absent
      });
    });

    const result = await t.query(
      internal.migrations.internal.assertZeroNullOutletIds,
      {},
    );
    expect(result).toBe(false);
  });

  it("returns true after backfill when all rows have outlet_id", async () => {
    const t = convexTest(schema);

    await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        name: "B",
        code: "S-0003",
        pin_hash: "x",
        role: "staff",
        active: true,
        created_at: Date.now(),
      });

      // Insert a session without outlet_id
      await ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-003",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        // outlet_id absent
      });
    });

    // Run backfill
    await t.action(internal.migrations.internal.backfillOutletId, {});

    // Assert complete
    const result = await t.query(
      internal.migrations.internal.assertZeroNullOutletIds,
      {},
    );
    expect(result).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

// seedManagerSession seeds a manager with PIN "9999" (mirrored by vouchers/createVoucher.test.ts).
const base = (sessionId: string, over: Record<string, unknown> = {}) => ({
  idempotencyKey: "k1", sessionId, settlementDate: "2026-06-05",
  grossAmount: 135000, mdrAmount: 945, transactionCount: 2,
  bcaAccountLast4: "1234", managerPin: "9999", ...over,
});

describe("settlements.enterSettlementManually", () => {
  it("happy path: writes a manual row with server-computed net + manager attribution", async () => {
    const t = convexTest(schema);
    const { sessionId, managerId } = await seedManagerSession(t);
    await t.action(api.settlements.actions.enterSettlementManually, base(sessionId) as never);
    const row = await t.run((ctx) => ctx.db.query("pos_settlements").first());
    expect(row!.source).toBe("manual");
    expect(row!.net_amount).toBe(135000 - 945); // server-computed
    expect(row!.bca_account_destination).toBe("1234");
    expect(row!.entered_by).toBe(managerId);
  });

  it("rejects a non-manager / dead session before the cache lookup (ADR-046)", async () => {
    const t = convexTest(schema);
    await expect(
      t.action(api.settlements.actions.enterSettlementManually, base("staff_sessions:nope" as never) as never),
    ).rejects.toThrow();
  });

  it("wrong PIN rejected", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await expect(
      t.action(api.settlements.actions.enterSettlementManually, base(sessionId, { managerPin: "1111", idempotencyKey: "k2" }) as never),
    ).rejects.toThrow();
  });

  it("net < 0 (mdr > gross) rejected", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await expect(
      t.action(api.settlements.actions.enterSettlementManually, base(sessionId, { mdrAmount: 200000, idempotencyKey: "k3" }) as never),
    ).rejects.toThrow(/NET_INVALID/);
  });

  it("idempotent replay returns without a second row", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await t.action(api.settlements.actions.enterSettlementManually, base(sessionId) as never);
    await t.action(api.settlements.actions.enterSettlementManually, base(sessionId) as never); // same key k1
    const rows = await t.run((ctx) => ctx.db.query("pos_settlements").collect());
    expect(rows).toHaveLength(1);
  });

  it("impossible calendar date rejected (passes regex, fails round-trip)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await expect(
      t.action(api.settlements.actions.enterSettlementManually, base(sessionId, { settlementDate: "2026-13-45", idempotencyKey: "k4" }) as never),
    ).rejects.toThrow(/DATE_INVALID/);
  });

  it("degenerate zero-gross / zero-count entry rejected", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await expect(
      t.action(api.settlements.actions.enterSettlementManually, base(sessionId, { grossAmount: 0, mdrAmount: 0, transactionCount: 0, idempotencyKey: "k5" }) as never),
    ).rejects.toThrow(/AMOUNT_INVALID/);
  });
});

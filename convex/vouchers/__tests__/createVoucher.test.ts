import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

describe("vouchers.actions.createVoucher", () => {
  it("happy path inserts row with manager attribution", async () => {
    const t = convexTest(schema);
    const { sessionId, managerId } = await seedManagerSession(t);
    const id = await t.action(api.vouchers.actions.createVoucher, {
      idempotencyKey: "k1",
      sessionId,
      code: "WELCOME10",
      type: "percentage",
      value: 10,
      managerPin: "9999",
    });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.code).toBe("WELCOME10");
    expect(row?.created_by_staff_id).toBe(managerId);
    expect(row?.used_count).toBe(0);
    expect(row?.active).toBe(true);
  });

  it("rejects CODE_EXISTS on duplicate code (different idempotencyKey)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await t.action(api.vouchers.actions.createVoucher, {
      idempotencyKey: "k1",
      sessionId,
      code: "X10",
      type: "amount",
      value: 5000,
      managerPin: "9999",
    });
    await expect(
      t.action(api.vouchers.actions.createVoucher, {
        idempotencyKey: "k2",
        sessionId,
        code: "X10",
        type: "amount",
        value: 6000,
        managerPin: "9999",
      }),
    ).rejects.toThrow(/CODE_EXISTS/);
  });

  it("rejects wrong PIN with INVALID_PIN", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await expect(
      t.action(api.vouchers.actions.createVoucher, {
        idempotencyKey: "k",
        sessionId,
        code: "X20",
        type: "amount",
        value: 5000,
        managerPin: "0000",
      }),
    ).rejects.toThrow(/INVALID_PIN/);
  });

  it("replay with same idempotencyKey returns cached id (no second insert)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const a = await t.action(api.vouchers.actions.createVoucher, {
      idempotencyKey: "kk",
      sessionId,
      code: "REPLAY",
      type: "amount",
      value: 1000,
      managerPin: "9999",
    });
    const b = await t.action(api.vouchers.actions.createVoucher, {
      idempotencyKey: "kk",
      sessionId,
      code: "REPLAY",
      type: "amount",
      value: 1000,
      managerPin: "9999",
    });
    expect(a).toBe(b);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("pos_vouchers").collect(),
    );
    // Only one row should exist for code REPLAY.
    expect(rows.filter((v) => v.code === "REPLAY")).toHaveLength(1);
  });

  it("rejects lowercase / invalid-shape code with CODE_INVALID", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    // Lowercase-with-space; upcased to "BAD CODE" → fails regex.
    await expect(
      t.action(api.vouchers.actions.createVoucher, {
        idempotencyKey: "k",
        sessionId,
        code: "bad code",
        type: "amount",
        value: 100,
        managerPin: "9999",
      }),
    ).rejects.toThrow(/CODE_INVALID/);
  });
});

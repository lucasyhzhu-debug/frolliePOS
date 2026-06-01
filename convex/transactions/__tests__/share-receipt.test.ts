import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedStaff, seedSession } from "./_helpers";

async function seedPaidTxn(t: ReturnType<typeof convexTest>, args: { staffId: any; total?: number }) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("pos_transactions", {
      status: "paid",
      subtotal: args.total ?? 10_000,
      voucher_discount: 0,
      total: args.total ?? 10_000,
      flags: 0,
      staff_id: args.staffId,
      created_at: 1000,
      paid_at: 1500,
    } as any);
  });
}

async function seedDraftTxn(t: ReturnType<typeof convexTest>, args: { staffId: any }) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("pos_transactions", {
      status: "draft",
      subtotal: 10_000, voucher_discount: 0, total: 10_000,
      flags: 0, staff_id: args.staffId, created_at: 1000,
    } as any);
  });
}

describe("shareReceipt", () => {
  it("mints a token for a paid txn without one", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "Sari", role: "staff", code: "S1" });
    const sessionId = await seedSession(t, staffId);
    const txnId = await seedPaidTxn(t, { staffId });
    const r = await t.mutation(api.transactions.public.shareReceipt, {
      idempotencyKey: "k1", sessionId, txnId,
    });
    expect(r.token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(r.token.length).toBeGreaterThanOrEqual(40); // 32 bytes b64url ≥ 43
    const stored = await t.run(async (ctx) => (await ctx.db.get(txnId))?.receipt_token);
    expect(stored).toBe(r.token);
  });

  it("re-tap with a different idempotencyKey returns the same token", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "Sari", role: "staff", code: "S1" });
    const sessionId = await seedSession(t, staffId);
    const txnId = await seedPaidTxn(t, { staffId });
    const a = await t.mutation(api.transactions.public.shareReceipt, {
      idempotencyKey: "k-first", sessionId, txnId,
    });
    const b = await t.mutation(api.transactions.public.shareReceipt, {
      idempotencyKey: "k-second", sessionId, txnId,
    });
    expect(b.token).toBe(a.token);
  });

  it("idempotency cache: same key returns cached result on replay", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "Sari", role: "staff", code: "S1" });
    const sessionId = await seedSession(t, staffId);
    const txnId = await seedPaidTxn(t, { staffId });
    const a = await t.mutation(api.transactions.public.shareReceipt, {
      idempotencyKey: "same-key", sessionId, txnId,
    });
    const b = await t.mutation(api.transactions.public.shareReceipt, {
      idempotencyKey: "same-key", sessionId, txnId,
    });
    expect(b.token).toBe(a.token);
  });

  it("rejects an invalid session (authCheck)", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "Sari", role: "staff", code: "S1" });
    const txnId = await seedPaidTxn(t, { staffId });
    // Build a sessionId that does not exist (insert+delete).
    const goneId = await t.run(async (ctx) => {
      const sess = await ctx.db.insert("staff_sessions", { staff_id: staffId, device_id: "d1", started_at: 0, ended_at: null, end_reason: null } as any);
      await ctx.db.delete(sess);
      return sess;
    });
    await expect(
      t.mutation(api.transactions.public.shareReceipt, {
        idempotencyKey: "k-bad", sessionId: goneId, txnId,
      })
    ).rejects.toThrow(/SESSION_INVALID/);
  });

  it("rejects a non-paid (draft) txn", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "Sari", role: "staff", code: "S1" });
    const sessionId = await seedSession(t, staffId);
    const draftId = await seedDraftTxn(t, { staffId });
    await expect(
      t.mutation(api.transactions.public.shareReceipt, {
        idempotencyKey: "k-draft", sessionId, txnId: draftId,
      })
    ).rejects.toThrow(/TXN_NOT_PAID/);
  });

  it("rejects a missing txn", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "Sari", role: "staff", code: "S1" });
    const sessionId = await seedSession(t, staffId);
    const goneTxnId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 10_000, voucher_discount: 0, total: 10_000,
        flags: 0, staff_id: staffId, created_at: 0, paid_at: 0,
      } as any);
      await ctx.db.delete(id);
      return id;
    });
    await expect(
      t.mutation(api.transactions.public.shareReceipt, {
        idempotencyKey: "k-missing", sessionId, txnId: goneTxnId,
      })
    ).rejects.toThrow(/TXN_NOT_FOUND/);
  });
});

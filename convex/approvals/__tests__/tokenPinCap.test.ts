import { describe, test, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { TOKEN_PIN_ATTEMPT_CAP } from "../lib";

async function seedPendingManualPayment(t: any) {
  return await t.run(async (ctx: any) => {
    return await ctx.db.insert("pos_approval_requests", {
      kind: "manual_payment_override",
      triggered_by_event: "test",
      triggered_at: Date.now(),
      token_hash: "test-hash",
      token_expires_at: Date.now() + 60 * 60_000,
      status: "pending",
      notification_channel: "telegram",
      entity_type: "pos_transactions",
      entity_id: "fake-txn",
      context: { amount_idr: 100_000, reason: "test" },
    });
  });
}

describe("token PIN cap", () => {
  test("4 failures keep request pending; 5th flips to denied", async () => {
    const t = convexTest(schema);
    const requestId = await seedPendingManualPayment(t);

    for (let i = 1; i <= 4; i++) {
      const r = await t.mutation(
        internal.approvals.internal._recordTokenPinFailure_internal as any,
        { requestId },
      );
      expect(r.capped).toBe(false);
      const row = await t.run(async (ctx: any) => ctx.db.get(requestId));
      expect(row.failed_pin_attempts).toBe(i);
      expect(row.status).toBe("pending");
    }

    const r5 = await t.mutation(
      internal.approvals.internal._recordTokenPinFailure_internal as any,
      { requestId },
    );
    expect(r5.capped).toBe(true);
    const row = await t.run(async (ctx: any) => ctx.db.get(requestId));
    expect(row.status).toBe("denied");
    expect(row.denied_by_manager_id).toBe("system");
    expect(row.deny_reason).toBe("too_many_pin_attempts");
    expect(row.failed_pin_attempts).toBe(TOKEN_PIN_ATTEMPT_CAP);
  });

  test("5th failure writes audit row with source=system, reason=too_many_pin_attempts", async () => {
    const t = convexTest(schema);
    const requestId = await seedPendingManualPayment(t);
    for (let i = 1; i <= 5; i++) {
      await t.mutation(
        internal.approvals.internal._recordTokenPinFailure_internal as any,
        { requestId },
      );
    }
    const audits = await t.run(async (ctx: any) =>
      ctx.db.query("audit_log").filter((q: any) => q.eq(q.field("entity_id"), requestId)).collect(),
    );
    const denyAudit = audits.find((a: any) => a.action.endsWith(".denied"));
    expect(denyAudit?.source).toBe("system");
    expect(denyAudit?.reason).toBe("too_many_pin_attempts");
    expect(JSON.parse(denyAudit?.metadata)?.failed_pin_attempts).toBe(5);
  });

  test("failed attempt on terminal request is no-op", async () => {
    const t = convexTest(schema);
    const requestId = await seedPendingManualPayment(t);
    await t.run(async (ctx: any) => ctx.db.patch(requestId, { status: "resolved", resolved_at: Date.now() }));
    const r = await t.mutation(
      internal.approvals.internal._recordTokenPinFailure_internal as any,
      { requestId },
    );
    expect(r.capped).toBe(false);
    const row = await t.run(async (ctx: any) => ctx.db.get(requestId));
    expect(row.status).toBe("resolved"); // unchanged
    expect(row.failed_pin_attempts).toBeUndefined(); // never incremented past terminal
  });

  test("concurrent approve-vs-cap-trip race — one wins cleanly", async () => {
    const t = convexTest(schema);
    // convex-test serializes mutations sequentially against the same row;
    // this verifies the serialization invariant: the second writer observes
    // the terminal state set by the first and throws cleanly. Not a true
    // concurrency test (convex-test can't simulate that) — see commit notes.
    // Create a real staff ID so the _markResolved_internal validator accepts it.
    const managerId = await t.run(async (ctx: any) =>
      ctx.db.insert("staff", {
        name: "Race Mgr",
        code: "RACE01",
        role: "manager",
        pin_hash: "placeholder",
        active: true,
        created_at: Date.now(),
      }),
    );
    const requestId = await seedPendingManualPayment(t);
    await t.run(async (ctx: any) => ctx.db.patch(requestId, { failed_pin_attempts: 4 }));

    const denyAttempt = t.mutation(
      internal.approvals.internal._recordTokenPinFailure_internal as any,
      { requestId },
    );
    const resolveAttempt = t.mutation(
      internal.approvals.internal._markResolved_internal as any,
      {
        idempotencyKey: "race-test",
        requestId,
        resolved_by_manager_id: managerId,
        source: "telegram_approval",
      },
    );

    const [a, b] = await Promise.allSettled([denyAttempt, resolveAttempt]);
    const errored = [a, b].filter((r) => r.status === "rejected");
    expect(errored.length).toBe(1);
    const errMsg = (errored[0] as PromiseRejectedResult).reason.message;
    expect(errMsg).toMatch(/REQUEST_RESOLVED|REQUEST_NOT_FOUND/);
  });

  test("F4: cap-trip on already-resolved row returns {capped:false} (does not throw REQUEST_REVOKED)", async () => {
    // F4 regression: _recordTokenPinFailure_internal was returning {capped:true}
    // unconditionally after the delegate call even when the delegate returned
    // {denied:false} (row already terminal). Now propagates the delegate flag.
    const t = convexTest(schema);
    const requestId = await seedPendingManualPayment(t);
    // Pre-stage 4 failures
    await t.run(async (ctx: any) => ctx.db.patch(requestId, { failed_pin_attempts: 4 }));
    // Flip to resolved BEFORE the 5th failure attempt
    await t.run(async (ctx: any) =>
      ctx.db.patch(requestId, { status: "resolved", resolved_at: Date.now() }),
    );
    // 5th failure should return {capped:false} because delegate returned {denied:false}
    const r = await t.mutation(
      internal.approvals.internal._recordTokenPinFailure_internal as any,
      { requestId },
    );
    expect(r.capped).toBe(false);
    // Row should stay resolved (no double-flip)
    const row = await t.run(async (ctx: any) => ctx.db.get(requestId));
    expect(row.status).toBe("resolved");
  });

  test("legitimate-fumble path — 4 attacker failures + 1 manager fumble = auto-revoke", async () => {
    const t = convexTest(schema);
    const requestId = await seedPendingManualPayment(t);
    for (let i = 1; i <= 5; i++) {
      await t.mutation(
        internal.approvals.internal._recordTokenPinFailure_internal as any,
        { requestId },
      );
    }
    const row = await t.run(async (ctx: any) => ctx.db.get(requestId));
    expect(row.status).toBe("denied");
    const audits = await t.run(async (ctx: any) =>
      ctx.db.query("audit_log").filter((q: any) => q.eq(q.field("entity_id"), requestId)).collect(),
    );
    const deny = audits.find((a: any) => a.action.endsWith(".denied"));
    expect(JSON.parse(deny?.metadata)?.failed_pin_attempts).toBe(5);
  });
});

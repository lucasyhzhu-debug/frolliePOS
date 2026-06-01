import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { createHash } from "node:crypto";
import schema from "../../schema";
import { api } from "../../_generated/api";

/**
 * B28a I2: the refund branch of getByToken used to defensively default
 * `receipt_number ?? ""`, `total_refund ?? 0`, etc. — masking corrupt rows
 * behind silent "Refund of Rp 0 approved" UI. validateContext("refund", ...)
 * GUARANTEES these fields at write time; if any are absent at read time the
 * row was corrupted post-insert. The branch now throws CONTEXT_CORRUPTED
 * (distinct prefix from CONTEXT_INVALID — write-time vs read-time failures).
 *
 * Pre-fix: the receipt_number ?? "" branch returned successfully with empty
 * receipt_number and the manager would tap-through on a malformed card.
 * Post-fix: getByToken throws → /approve UI shows the generic error
 * surface, alerting the manager and triggering an investigate.
 */

function sha256HexNode(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("getByToken — refund branch corruption guards (B28a I2)", () => {
  it("throws CONTEXT_CORRUPTED: receipt_number when missing", async () => {
    const t = convexTest(schema);
    const rawToken = "tok-corrupted-rn";
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_approval_requests", {
        kind: "refund",
        entity_type: "pos_transactions",
        entity_id: "t1",
        // Intentionally missing receipt_number — simulates a corrupt row
        // (validateContext at write time would have rejected this).
        context: {
          txn_id: "t1",
          lines: [
            { line_id: "ln1", product_name: "Dubai", refund_qty: 1, refund_amount: 50000 },
          ],
          total_refund: 50000,
          reason: "wrong flavour",
        },
        reason: "wrong flavour",
        triggered_by_event: "manual_payment_request",
        triggered_at: Date.now(),
        token_hash: sha256HexNode(rawToken),
        token_expires_at: Date.now() + 3600_000,
        status: "pending",
      });
    });

    await expect(
      t.query(api.approvals.public.getByToken, { rawToken }),
    ).rejects.toThrow(/CONTEXT_CORRUPTED: receipt_number/);
  });

  it("throws CONTEXT_CORRUPTED: total_refund when zero/missing", async () => {
    const t = convexTest(schema);
    const rawToken = "tok-corrupted-tr";
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_approval_requests", {
        kind: "refund",
        entity_type: "pos_transactions",
        entity_id: "t1",
        context: {
          txn_id: "t1",
          receipt_number: "R-2026-0001",
          lines: [
            { line_id: "ln1", product_name: "Dubai", refund_qty: 1, refund_amount: 50000 },
          ],
          total_refund: 0, // corrupted — validateContext would have rejected
          reason: "wrong flavour",
        },
        reason: "wrong flavour",
        triggered_by_event: "manual_payment_request",
        triggered_at: Date.now(),
        token_hash: sha256HexNode(rawToken),
        token_expires_at: Date.now() + 3600_000,
        status: "pending",
      });
    });

    await expect(
      t.query(api.approvals.public.getByToken, { rawToken }),
    ).rejects.toThrow(/CONTEXT_CORRUPTED: total_refund/);
  });

  it("succeeds on a well-formed refund context", async () => {
    const t = convexTest(schema);
    const rawToken = "tok-refund-ok";
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_approval_requests", {
        kind: "refund",
        entity_type: "pos_transactions",
        entity_id: "t1",
        context: {
          txn_id: "t1",
          receipt_number: "R-2026-0001",
          lines: [
            { line_id: "ln1", product_name: "Dubai", refund_qty: 1, refund_amount: 50000 },
          ],
          total_refund: 50000,
          reason: "wrong flavour",
        },
        reason: "wrong flavour",
        triggered_by_event: "manual_payment_request",
        triggered_at: Date.now(),
        token_hash: sha256HexNode(rawToken),
        token_expires_at: Date.now() + 3600_000,
        status: "pending",
      });
    });

    const res = await t.query(api.approvals.public.getByToken, { rawToken });
    expect(res?.kind).toBe("refund");
    if (res?.kind !== "refund") throw new Error("expected refund kind");
    expect(res.display.receipt_number).toBe("R-2026-0001");
    expect(res.display.total_refund).toBe(50000);
    expect(res.display.lines).toHaveLength(1);
    // line_id is stripped from the public surface (refunds-internal).
    expect((res.display.lines[0] as { line_id?: string }).line_id).toBeUndefined();
  });
});

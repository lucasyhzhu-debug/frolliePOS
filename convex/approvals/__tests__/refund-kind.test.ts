import { describe, it, expect } from "vitest";
import { validateContext, KIND_AUDIT, KIND_TEMPLATE } from "../kinds";

/**
 * Pure unit tests for the refund-kind additions to APPROVAL_KINDS (v0.5.1 PR B).
 * No DB / no convex-test runtime — validateContext is a plain function.
 */

const VALID_REFUND_CONTEXT = {
  txn_id: "t1",
  receipt_number: "R-2026-0001",
  lines: [
    { line_id: "ln1", product_name: "Dubai 1pc", refund_qty: 1, refund_amount: 50000 },
  ],
  total_refund: 50000,
  reason: "wrong flavour",
};

describe("validateContext('refund', …)", () => {
  it("returns the normalized refund context on valid input", () => {
    const ctx = validateContext("refund", VALID_REFUND_CONTEXT);
    expect(ctx).toEqual(VALID_REFUND_CONTEXT);
  });

  it("rejects missing txn_id", () => {
    expect(() =>
      validateContext("refund", { ...VALID_REFUND_CONTEXT, txn_id: "" }),
    ).toThrow(/CONTEXT_INVALID: txn_id/);
    expect(() =>
      validateContext("refund", { ...VALID_REFUND_CONTEXT, txn_id: undefined }),
    ).toThrow(/CONTEXT_INVALID: txn_id/);
  });

  it("rejects missing receipt_number", () => {
    expect(() =>
      validateContext("refund", { ...VALID_REFUND_CONTEXT, receipt_number: "" }),
    ).toThrow(/CONTEXT_INVALID: receipt_number/);
  });

  it("rejects empty lines array", () => {
    expect(() =>
      validateContext("refund", { ...VALID_REFUND_CONTEXT, lines: [] }),
    ).toThrow(/CONTEXT_INVALID: lines/);
  });

  it("rejects line missing line_id", () => {
    expect(() =>
      validateContext("refund", {
        ...VALID_REFUND_CONTEXT,
        lines: [{ ...VALID_REFUND_CONTEXT.lines[0], line_id: "" }],
      }),
    ).toThrow(/CONTEXT_INVALID: line.line_id/);
  });

  it("rejects refund_qty <= 0", () => {
    expect(() =>
      validateContext("refund", {
        ...VALID_REFUND_CONTEXT,
        lines: [{ ...VALID_REFUND_CONTEXT.lines[0], refund_qty: 0 }],
      }),
    ).toThrow(/CONTEXT_INVALID: line.refund_qty/);
    expect(() =>
      validateContext("refund", {
        ...VALID_REFUND_CONTEXT,
        lines: [{ ...VALID_REFUND_CONTEXT.lines[0], refund_qty: -1 }],
      }),
    ).toThrow(/CONTEXT_INVALID: line.refund_qty/);
  });

  it("rejects total_refund <= 0", () => {
    expect(() =>
      validateContext("refund", { ...VALID_REFUND_CONTEXT, total_refund: 0 }),
    ).toThrow(/CONTEXT_INVALID: total_refund/);
    expect(() =>
      validateContext("refund", { ...VALID_REFUND_CONTEXT, total_refund: -1 }),
    ).toThrow(/CONTEXT_INVALID: total_refund/);
  });

  it("rejects empty/whitespace reason", () => {
    expect(() =>
      validateContext("refund", { ...VALID_REFUND_CONTEXT, reason: "" }),
    ).toThrow(/CONTEXT_INVALID: reason/);
    expect(() =>
      validateContext("refund", { ...VALID_REFUND_CONTEXT, reason: "   " }),
    ).toThrow(/CONTEXT_INVALID: reason/);
  });

  it("B28a M1: rejects total_refund that doesn't match sum(lines[].refund_amount)", () => {
    // Crafted-mismatch attack: lines sum to 50_000 but total_refund claims
    // 999_999. Pre-M1 this would pass — the Telegram card + /approve UI would
    // render the falsified Rp 999.999 to the manager, who'd then approve under
    // a misleading total. (The commit recomputes from scratch, so the booked
    // amount is still correct; the lie is at the manager-display layer.)
    // M1 catches it at write time, before the row is inserted.
    expect(() =>
      validateContext("refund", {
        ...VALID_REFUND_CONTEXT,
        total_refund: 999_999, // lies — lines sum to 50_000
      }),
    ).toThrow(/CONTEXT_INVALID: total_refund mismatch/);

    // Multi-line: 3 lines summing to 30_000 + 20_000 + 10_000 = 60_000, but
    // total_refund claims 100_000.
    expect(() =>
      validateContext("refund", {
        ...VALID_REFUND_CONTEXT,
        lines: [
          { line_id: "ln1", product_name: "A", refund_qty: 1, refund_amount: 30_000 },
          { line_id: "ln2", product_name: "B", refund_qty: 1, refund_amount: 20_000 },
          { line_id: "ln3", product_name: "C", refund_qty: 1, refund_amount: 10_000 },
        ],
        total_refund: 100_000,
      }),
    ).toThrow(/CONTEXT_INVALID: total_refund mismatch/);

    // Matching multi-line is accepted.
    expect(() =>
      validateContext("refund", {
        ...VALID_REFUND_CONTEXT,
        lines: [
          { line_id: "ln1", product_name: "A", refund_qty: 1, refund_amount: 30_000 },
          { line_id: "ln2", product_name: "B", refund_qty: 1, refund_amount: 20_000 },
          { line_id: "ln3", product_name: "C", refund_qty: 1, refund_amount: 10_000 },
        ],
        total_refund: 60_000,
      }),
    ).not.toThrow();
  });
});

describe("KIND_AUDIT.refund", () => {
  it("resolved verb is refund.approval_resolved (distinct from refund.committed)", () => {
    // C2 (v0.5.1 PR B post-review): on the Telegram path, _commitRefund_internal
    // emits refund.committed (entity: pos_refunds) AND _markResolved_internal
    // emits the KIND_AUDIT.refund.resolved verb (entity: pos_approval_requests).
    // Pre-C2 both verbs were "refund.committed", producing two rows with the
    // same action string — a dashboard counting refunds would double-count
    // every Telegram-path refund. Splitting the verbs ends the double-emit:
    // refund.committed counts refunds, refund.approval_resolved counts
    // approval-row state transitions.
    expect(KIND_AUDIT.refund.requested).toBe("refund.requested");
    expect(KIND_AUDIT.refund.resolved).toBe("refund.approval_resolved");
    expect(KIND_AUDIT.refund.denied).toBe("refund.denied");
  });
});

describe("KIND_TEMPLATE.refund", () => {
  it('maps to the "refund" telegram template id', () => {
    expect(KIND_TEMPLATE.refund).toBe("refund");
  });
});

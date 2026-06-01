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

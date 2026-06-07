// convex/approvals/kinds.ts
// The single source of truth for "what is an approval kind". Adding a kind =
// add a literal here + its 4 touchpoints (CLAUDE.md "How to add a feature" #8).
// Pure V8 module (no "use node") — imported by mutations, actions, and tests.

export type ApprovalKind = "staff_pin_reset" | "manual_payment_override" | "refund" | "spoilage";

export type ManualPaymentContext = {
  txn_id: string;
  amount_idr: number;
  receipt_preview?: string;
  reason: string;
};

// v0.5.1 PR B: refund-approval context. Lines + total are sent in the context
// so the Telegram template + /approve UI can render a preview before the
// manager enters PIN — they see exactly what they're approving. `line_id` is
// included because the off-booth approval action needs it to call
// _commitRefund_internal (which takes line_id, not product_name).
export type RefundContext = {
  txn_id: string;
  receipt_number: string;
  lines: Array<{
    line_id: string;                   // Id<"pos_transaction_lines"> serialised as string for context storage
    product_name: string;
    refund_qty: number;
    refund_amount: number;
  }>;
  total_refund: number;
  reason: string;
};

// v0.6 S2: spoilage-approval context. Off-booth Telegram-approval path
// consumed by S5 (spoilage commit). Lines + total are sent in the context
// so the Telegram template + /approve UI can render a preview before the
// manager enters PIN. `inventory_sku_id` is required because the commit
// path resolves SKU IDs at write time (decrement targets). `sku_code` is
// snapshotted for display in the Telegram card + /approve UI.
export type SpoilageContext = {
  spoilage_event_id: string;
  lines: Array<{ inventory_sku_id: string; sku_code: string; qty: number }>;
  total_qty: number;
  reason: string;
};

/** Validate + normalize the per-kind context BEFORE insert. The single writer
 *  (_createRequest_internal) calls this; an invalid context throws CONTEXT_INVALID. */
export function validateContext(kind: ApprovalKind, raw: unknown): Record<string, unknown> {
  switch (kind) {
    case "staff_pin_reset":
      return {}; // subject_staff_id carries everything; no context payload
    case "manual_payment_override": {
      const c = (raw ?? {}) as Partial<ManualPaymentContext>;
      if (typeof c.txn_id !== "string" || c.txn_id === "") throw new Error("CONTEXT_INVALID: txn_id");
      if (!Number.isInteger(c.amount_idr)) throw new Error("CONTEXT_INVALID: amount_idr"); // integer rupiah (ADR-015)
      if (typeof c.reason !== "string" || c.reason.trim() === "") throw new Error("CONTEXT_INVALID: reason");
      return {
        txn_id: c.txn_id,
        amount_idr: c.amount_idr,
        reason: c.reason,
        ...(typeof c.receipt_preview === "string" ? { receipt_preview: c.receipt_preview } : {}),
      };
    }
    case "refund": {
      const c = (raw ?? {}) as Partial<RefundContext>;
      if (typeof c.txn_id !== "string" || c.txn_id === "") throw new Error("CONTEXT_INVALID: txn_id");
      if (typeof c.receipt_number !== "string" || c.receipt_number === "") throw new Error("CONTEXT_INVALID: receipt_number");
      if (!Array.isArray(c.lines) || c.lines.length === 0) throw new Error("CONTEXT_INVALID: lines");
      for (const l of c.lines) {
        if (typeof l.line_id !== "string" || l.line_id === "") throw new Error("CONTEXT_INVALID: line.line_id");
        if (typeof l.product_name !== "string") throw new Error("CONTEXT_INVALID: line.product_name");
        if (!Number.isInteger(l.refund_qty) || l.refund_qty <= 0) throw new Error("CONTEXT_INVALID: line.refund_qty");
        if (!Number.isInteger(l.refund_amount) || l.refund_amount < 0) throw new Error("CONTEXT_INVALID: line.refund_amount");
      }
      if (typeof c.total_refund !== "number" || !Number.isInteger(c.total_refund) || c.total_refund <= 0) throw new Error("CONTEXT_INVALID: total_refund");
      if (typeof c.reason !== "string" || c.reason.trim() === "") throw new Error("CONTEXT_INVALID: reason");
      // B28a M1: cross-check total_refund against the sum of line refund_amounts.
      // Individual-field validation above lets a maliciously crafted payload pass
      // total_refund: 999999 with lines summing to 50000 — the Telegram card +
      // /approve UI would render the falsified total before the manager enters
      // PIN. (The commit recomputes from scratch, so the booked amount is still
      // correct; the lie is at the manager-display layer.) The cross-check rejects
      // the mismatch at write time, BEFORE the row is inserted, so the manager
      // never sees a fake total.
      const sum = c.lines.reduce((s, l) => s + (l.refund_amount as number), 0);
      if (sum !== c.total_refund) throw new Error("CONTEXT_INVALID: total_refund mismatch");
      return {
        txn_id: c.txn_id,
        receipt_number: c.receipt_number,
        lines: c.lines,
        total_refund: c.total_refund,
        reason: c.reason,
      };
    }
    case "spoilage": {
      const c = (raw ?? {}) as Partial<SpoilageContext>;
      if (typeof c.spoilage_event_id !== "string" || c.spoilage_event_id === "") throw new Error("CONTEXT_INVALID: spoilage_event_id");
      if (!Array.isArray(c.lines) || c.lines.length === 0) throw new Error("CONTEXT_INVALID: lines");
      for (const l of c.lines) {
        if (typeof l.inventory_sku_id !== "string" || l.inventory_sku_id === "") throw new Error("CONTEXT_INVALID: line.inventory_sku_id");
        if (typeof l.sku_code !== "string" || l.sku_code === "") throw new Error("CONTEXT_INVALID: line.sku_code");
        if (!Number.isInteger(l.qty) || l.qty <= 0) throw new Error("CONTEXT_INVALID: line.qty");
      }
      if (typeof c.total_qty !== "number" || !Number.isInteger(c.total_qty) || c.total_qty <= 0) throw new Error("CONTEXT_INVALID: total_qty");
      // Cross-check total_qty against the sum of line qtys — mirrors the refund
      // total_refund mismatch guard. A maliciously crafted payload could claim
      // total_qty: 999 with lines summing to 2; the Telegram card + /approve UI
      // would render the inflated total to the manager. The commit recomputes
      // from scratch (correct decrement), but the manager-display would lie.
      const sum = c.lines.reduce((s, l) => s + (l.qty as number), 0);
      if (sum !== c.total_qty) throw new Error("CONTEXT_INVALID: total_qty mismatch");
      if (typeof c.reason !== "string" || c.reason.trim() === "") throw new Error("CONTEXT_INVALID: reason");
      return {
        spoilage_event_id: c.spoilage_event_id,
        lines: c.lines,
        total_qty: c.total_qty,
        reason: c.reason,
      };
    }
  }
}

// Per-kind audit verbs — v0.5.0. Dashboard queries (v0.5.3+) can filter by kind
// directly on audit.action without parsing metadata.kind. Pre-v0.5.0 rows that
// carry the generic "approval.*" strings stay as-is (ADR-007 append-only); the
// dashboard read layer must accept both shapes.
export const KIND_AUDIT: Record<ApprovalKind, { requested: string; resolved: string; denied: string }> = {
  staff_pin_reset:         { requested: "staff_pin_reset.requested",         resolved: "staff_pin_reset.resolved",         denied: "staff_pin_reset.denied" },
  manual_payment_override: { requested: "manual_payment_override.requested", resolved: "manual_payment_override.resolved", denied: "manual_payment_override.denied" },
  // refund.resolved emits "refund.approval_resolved" — distinct from
  // "refund.committed" (which _commitRefund_internal emits when the refund row
  // is inserted). Pre-C2 both used "refund.committed", which double-emitted on
  // the Telegram path because _markResolved_internal AND _commitRefund_internal
  // both fired it. Separating verbs lets dashboards count refunds (committed)
  // distinctly from approval-row state transitions (approval_resolved).
  refund:                  { requested: "refund.requested",                  resolved: "refund.approval_resolved",         denied: "refund.denied" },
  // v0.6 S2: spoilage. resolved verb is spoilage.approval_resolved to match
  // refund's split (approval-row state ≠ commit verb). The commit path
  // (_recordSpoilage_internal) emits "stock.spoilage" for the spoilage row
  // itself — see convex/inventory/internal.ts, SCHEMA.md, CHANGELOG.
  spoilage:                { requested: "spoilage.requested",                resolved: "spoilage.approval_resolved",       denied: "spoilage.denied" },
};

/** Maps kind → telegram template id (send.ts) AND → /approve UI variant id. */
export const KIND_TEMPLATE: Record<ApprovalKind, "staff_pin_reset" | "manual_payment_override" | "refund" | "spoilage"> = {
  staff_pin_reset: "staff_pin_reset",
  manual_payment_override: "manual_payment_override",
  refund: "refund",
  spoilage: "spoilage",   // v0.6 S2
};

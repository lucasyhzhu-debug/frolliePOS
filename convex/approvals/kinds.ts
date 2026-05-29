// convex/approvals/kinds.ts
// The single source of truth for "what is an approval kind". Adding a kind =
// add a literal here + its 4 touchpoints (CLAUDE.md "How to add a feature" #8).
// Pure V8 module (no "use node") — imported by mutations, actions, and tests.

export type ApprovalKind = "staff_pin_reset" | "manual_payment_override";

export type ManualPaymentContext = {
  txn_id: string;
  amount_idr: number;
  receipt_preview?: string;
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
  }
}

export const KIND_AUDIT: Record<ApprovalKind, { requested: string; resolved: string; denied: string }> = {
  staff_pin_reset:         { requested: "approval.created", resolved: "approval.resolved", denied: "approval.denied" },
  manual_payment_override: { requested: "approval.created", resolved: "approval.resolved", denied: "approval.denied" },
};

/** Maps kind → telegram template id (send.ts) AND → /approve UI variant id. */
export const KIND_TEMPLATE: Record<ApprovalKind, "staff_pin_reset" | "manual_payment_override"> = {
  staff_pin_reset: "staff_pin_reset",
  manual_payment_override: "manual_payment_override",
};

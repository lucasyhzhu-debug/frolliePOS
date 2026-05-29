import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

export type Phase =
  | { kind: "loading" }
  | { kind: "showing" }
  | { kind: "paid" }
  | { kind: "expired" }
  | { kind: "cancelled" };

// Kept: the charge route's wall-clock ceiling timer reads this to reveal the
// manual-fallback CTAs (Retry / Manager override / Cancel). Polling is retired
// (Decision B) — payment detection is webhook-only; the reactive subscription
// flips the phase to "paid" the instant the webhook writes.
export const POLL_CEILING_MS = 60_000;

/**
 * Pure function — exported so tests can unit-test phase derivation in isolation
 * without mounting the hook.
 */
export function computePhase(
  txn: { status: string } | null | undefined,
  invoice: { xendit_invoice_id: string } | null | undefined,
): Phase {
  if (!txn || !invoice) return { kind: "loading" };
  if (txn.status === "paid") return { kind: "paid" };
  if (txn.status === "cancelled") return { kind: "cancelled" };
  return { kind: "showing" };
}

export function useXenditPayment(txnId: Id<"pos_transactions">) {
  const txn = useQuery(api.transactions.public.getById, { txnId });
  const invoice = useQuery(api.payments.public.getCurrentInvoice, { txnId });
  const phase: Phase = computePhase(txn ?? undefined, invoice ?? undefined);
  return { phase, invoice, txn };
}

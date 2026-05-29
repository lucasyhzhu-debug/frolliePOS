import { describe, it, expect } from "vitest";

// computePhase is a pure function — test it without mounting the hook.
import {
  computePhase,
  POLL_CEILING_MS,
} from "./useXenditPayment";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeTxnId = "pos_transactions:abc123" as Id<"pos_transactions">;

function makeTxn(status: string) {
  return {
    _id: fakeTxnId,
    status,
    total: 50000,
    xendit_invoice_id_current: "inv_001",
  };
}

function makeInvoice(xenditId = "xen_001") {
  return {
    _id: "pos_xendit_invoices:inv1" as Id<"pos_xendit_invoices">,
    xendit_invoice_id: xenditId,
    transaction_id: fakeTxnId,
  };
}

// ---------------------------------------------------------------------------
// computePhase unit tests (pure — no hook mounting needed)
// ---------------------------------------------------------------------------
describe("computePhase", () => {
  it("returns {kind:'loading'} when txn is undefined", () => {
    expect(computePhase(undefined, makeInvoice())).toEqual({ kind: "loading" });
  });

  it("returns {kind:'loading'} when invoice is undefined", () => {
    expect(computePhase(makeTxn("awaiting_payment"), undefined)).toEqual({ kind: "loading" });
  });

  it("returns {kind:'loading'} when both are undefined", () => {
    expect(computePhase(undefined, undefined)).toEqual({ kind: "loading" });
  });

  it("returns {kind:'loading'} when txn is null", () => {
    expect(computePhase(null, makeInvoice())).toEqual({ kind: "loading" });
  });

  it("returns {kind:'loading'} when invoice is null", () => {
    expect(computePhase(makeTxn("awaiting_payment"), null)).toEqual({ kind: "loading" });
  });

  it("returns {kind:'paid'} when txn.status === 'paid'", () => {
    expect(computePhase(makeTxn("paid"), makeInvoice())).toEqual({ kind: "paid" });
  });

  it("returns {kind:'cancelled'} when txn.status === 'cancelled'", () => {
    expect(computePhase(makeTxn("cancelled"), makeInvoice())).toEqual({ kind: "cancelled" });
  });

  it("returns {kind:'showing'} for awaiting_payment", () => {
    expect(computePhase(makeTxn("awaiting_payment"), makeInvoice())).toEqual({
      kind: "showing",
    });
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe("useXenditPayment constants", () => {
  it("exports POLL_CEILING_MS = 60000 (charge route ceiling timer)", () => {
    // Polling is retired (Decision B) but POLL_CEILING_MS drives the charge
    // route's wall-clock ceiling for the manual-fallback CTA reveal.
    expect(POLL_CEILING_MS).toBe(60_000);
  });
});

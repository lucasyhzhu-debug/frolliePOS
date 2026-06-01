import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery, useAction } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useRefund } from "@/hooks/useRefund";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { RefundLineSelector } from "@/components/pos/RefundLineSelector";
import { ApprovalPending } from "@/components/pos/ApprovalPending";
import { PinSheet } from "@/components/pos/PinSheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { rp, fmtDate, fmtTime } from "@/lib/format";
import { toast } from "sonner";

/**
 * Refund form (per-line stepper). v0.5.1 PR B B23.
 *
 * Two submit paths gated by manager authority:
 *   - Inline: manager at booth → manager-picker → PIN sheet → commitRefundInline.
 *     Mirrors the manager-override flow on sale/charge.tsx (managerStaffCode +
 *     managerPin) so the auth envelope is consistent across PIN-gated actions.
 *   - Telegram: off-booth → requestRefundApproval → render <ApprovalPending>.
 *     The manager opens the /approve/:token URL from the managers' Telegram
 *     group and enters PIN. The reactive approval subscription drives terminal
 *     transitions (resolved / denied / expired) via ApprovalPending's callbacks.
 *
 * Data flow: listForTransaction returns { txn, lines (with refundable), refunds }
 * in one round-trip. useRefund manages per-line selections + reason; canSubmit
 * gates both buttons. Idempotency keys are namespaced per intent (inline vs
 * telegram) so a retry of one path doesn't replay the other's cached blob.
 *
 * Money: integer rupiah only (ADR-015); rp() formats. Server time wins — no
 * client _at fields.
 */
export default function RefundDetail() {
  const navigate = useNavigate();
  const session = useSession();
  const { txnId: txnIdParam } = useParams<{ txnId: string }>();
  const txnId = txnIdParam as Id<"pos_transactions"> | undefined;

  const data = useQuery(
    api.refunds.public.listForTransaction,
    session.status === "active" && txnId
      ? { sessionId: session.sessionId, transactionId: txnId }
      : "skip",
  );

  // useRefund is keyed by line _id + refundable cap. Empty array until data
  // resolves so hook order stays stable across renders (no conditional hook).
  const linesForHook = data?.lines ?? [];
  const refund = useRefund(linesForHook);

  // Two namespaced intents so a stuck inline retry can't replay a Telegram blob
  // (and vice versa). clearIntent on retry-after-denial below.
  const inlineKey = useIdempotency(`refund-inline:${txnId ?? "none"}`);
  const telegramKey = useIdempotency(`refund-telegram:${txnId ?? "none"}`);

  const commitRefundInline = useAction(api.refunds.actions.commitRefundInline);
  const requestRefundApproval = useAction(
    api.refunds.actions.requestRefundApproval,
  );

  // ---- inline path state ----
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedManager, setPickedManager] = useState<{
    name: string;
    code: string;
  } | null>(null);
  const [pinPending, setPinPending] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>(undefined);

  const managers = useQuery(
    api.staff.public.listActiveManagers,
    session.status === "active" ? { sessionId: session.sessionId } : "skip",
  );

  // ---- telegram path state ----
  const [approvalRequestId, setApprovalRequestId] = useState<
    Id<"pos_approval_requests"> | null
  >(null);
  const [telegramSubmitting, setTelegramSubmitting] = useState(false);

  // ---- guards ----
  if (!txnId) {
    return (
      <SpokeLayout title="Refund">
        <main className="flex flex-1 flex-col items-center justify-center p-4">
          <p className="text-sm text-destructive">No transaction specified.</p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => navigate("/refund")}
          >
            Back to refund list
          </Button>
        </main>
      </SpokeLayout>
    );
  }

  if (session.status === "loading" || data === undefined) {
    return (
      <SpokeLayout title="Refund">
        <main className="flex flex-1 flex-col items-center justify-center p-4">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </main>
      </SpokeLayout>
    );
  }
  if (session.status !== "active") return null;

  if (data.txn === null) {
    return (
      <SpokeLayout title="Refund">
        <main className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            Transaction not found or not paid.
          </p>
          <Button variant="outline" onClick={() => navigate("/refund")}>
            Back to refund list
          </Button>
        </main>
      </SpokeLayout>
    );
  }

  // ---- compute preview total from current selections ----
  // ADR-040 single-floor proportional math — kept in sync with
  // convex/refunds/lib.ts `computeRefundAmount`. The voucher-math unit test in
  // convex/refunds/__tests__/voucher-math.test.ts is the spec; mirror exactly.
  const lineById = new Map(data.lines.map((l) => [l._id, l]));
  const totalPreviewIdr = refund.lines.reduce((sum, sel) => {
    const line = lineById.get(sel.line_id as Id<"pos_transaction_lines">);
    if (!line) return sum;
    // floor(line_subtotal × paid_total × refund_qty / (subtotal_pre_voucher × line.qty))
    return sum + Math.floor(
      (line.line_subtotal * data.txn!.total * sel.qty) /
      (data.txn!.subtotal * line.qty),
    );
  }, 0);

  // ---- error mapping (shared inline + telegram) ----
  const mapErr = (raw: string): string => {
    if (raw.includes("INVALID_PIN")) return "Wrong PIN";
    if (raw.includes("MANAGER_NOT_FOUND"))
      return "Manager not found or not active";
    if (raw.includes("TXN_NOT_REFUNDABLE"))
      return "This transaction is not refundable";
    if (raw.includes("TXN_NOT_PAID"))
      return "This transaction is not in a paid state";
    if (raw.includes("LINE_NOT_FOUND")) return "Refund line no longer exists";
    if (raw.includes("NO_SESSION"))
      return "Session expired — please sign in again";
    if (raw.includes("POS_BASE_URL not set"))
      return "Server config missing: POS_BASE_URL not set (contact dev)";
    return raw;
  };

  // ---- inline submit (manager PIN at booth) ----
  const handleInlineStart = () => {
    if (!refund.canSubmit) return;
    setPickedManager(null);
    setPinError(undefined);
    setPickerOpen(true);
  };

  const handlePinSubmit = async (pin: string) => {
    if (!inlineKey || !pickedManager || !txnId) return;
    setPinPending(true);
    setPinError(undefined);
    try {
      await commitRefundInline({
        sessionId: session.sessionId,
        idempotencyKey: inlineKey,
        transactionId: txnId,
        lines: refund.lines.map((l) => ({
          line_id: l.line_id as Id<"pos_transaction_lines">,
          qty: l.qty,
        })),
        reason: refund.reason.trim(),
        managerStaffCode: pickedManager.code,
        managerPin: pin,
      });
      toast.success("Refund committed");
      setPickerOpen(false);
      navigate("/refund");
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Refund failed";
      setPinError(mapErr(raw));
    } finally {
      setPinPending(false);
    }
  };

  // ---- telegram submit (off-booth approval request) ----
  const handleTelegramRequest = async () => {
    if (!telegramKey || !refund.canSubmit || !txnId) return;
    setTelegramSubmitting(true);
    try {
      const { requestId } = await requestRefundApproval({
        sessionId: session.sessionId,
        idempotencyKey: telegramKey,
        transactionId: txnId,
        lines: refund.lines.map((l) => ({
          line_id: l.line_id as Id<"pos_transaction_lines">,
          qty: l.qty,
        })),
        reason: refund.reason.trim(),
      });
      setApprovalRequestId(requestId);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Request failed";
      toast.error(mapErr(raw));
    } finally {
      setTelegramSubmitting(false);
    }
  };

  // ---- approval terminal handlers ----
  // On denied/expired, clear the telegram idempotency key so a retry mints a
  // fresh requestId instead of replaying the resolved/denied blob.
  const handleApprovalResolved = () => {
    toast.success("Manager approved — refund committed.");
    navigate("/refund");
  };
  const handleApprovalDenied = async () => {
    toast.error("Approval denied — try a different approach.");
    if (txnId) await clearIntent(`refund-telegram:${txnId}`);
    setApprovalRequestId(null);
  };
  const handleApprovalExpired = async () => {
    toast.error("Approval request expired — please try again.");
    if (txnId) await clearIntent(`refund-telegram:${txnId}`);
    setApprovalRequestId(null);
  };

  // ---- render ----
  const submitDisabled =
    !refund.canSubmit || !inlineKey || !telegramKey || pinPending ||
    telegramSubmitting;

  return (
    <SpokeLayout title="Refund">
      <section className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {/* txn header */}
        <Card className="p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">
              {data.txn.receipt_number ?? "(no receipt #)"}
            </span>
            <span className="text-base font-semibold tabular-nums">
              {rp(data.txn.total)}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {fmtDate(data.txn.paid_at ?? data.txn.created_at)}{" "}
            {fmtTime(data.txn.paid_at ?? data.txn.created_at)}
          </div>
        </Card>

        {approvalRequestId ? (
          // Off-booth flow in progress. The form is hidden; ApprovalPending
          // owns the reactive status. Terminal callbacks drive navigation.
          <div className="flex flex-col gap-3">
            <Separator />
            <ApprovalPending
              requestId={approvalRequestId}
              onResolved={handleApprovalResolved}
              onDenied={handleApprovalDenied}
              onExpired={handleApprovalExpired}
            />
          </div>
        ) : (
          <>
            {/* per-line stepper */}
            <div>
              {data.lines.map((l) => (
                <RefundLineSelector
                  key={l._id}
                  productName={l.product_name_snapshot}
                  qty={l.qty}
                  refunded_qty={l.refunded_qty ?? 0}
                  refundable={l.refundable}
                  unitPrice={l.unit_price_snapshot}
                  value={refund.qtyFor(l._id)}
                  onChange={(n) => refund.setQty(l._id, n)}
                />
              ))}
            </div>

            {/* refunded history */}
            {data.refunds.length > 0 && (
              <Card className="p-3 text-xs text-muted-foreground">
                <div className="mb-1 font-medium text-foreground">
                  Already refunded
                </div>
                <ul className="space-y-1">
                  {data.refunds.map((r) => (
                    <li key={r._id} className="flex justify-between">
                      <span>{fmtDate(r.created_at)} {fmtTime(r.created_at)}</span>
                      <span className="tabular-nums">{rp(r.total_refund)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {/* reason */}
            <div className="space-y-1.5">
              <label
                htmlFor="refund-reason"
                className="text-xs font-medium text-muted-foreground"
              >
                Reason (required)
              </label>
              <textarea
                id="refund-reason"
                data-testid="refund-reason"
                value={refund.reason}
                onChange={(e) => refund.setReason(e.target.value)}
                placeholder="Why is this refund needed?"
                rows={2}
                disabled={pinPending || telegramSubmitting}
                className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            {/* running total */}
            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground">
                Refund total
              </span>
              <span
                className="text-base font-semibold tabular-nums"
                data-testid="refund-total-preview"
              >
                {rp(totalPreviewIdr)}
              </span>
            </div>

            {/* submit buttons */}
            <div className="flex flex-col gap-2">
              <Button
                data-testid="refund-submit-inline"
                onClick={handleInlineStart}
                disabled={submitDisabled}
              >
                Refund with manager PIN
              </Button>
              <Button
                data-testid="refund-submit-telegram"
                variant="outline"
                onClick={handleTelegramRequest}
                disabled={submitDisabled}
              >
                {telegramSubmitting
                  ? "Sending…"
                  : "Request approval (Telegram)"}
              </Button>
            </div>
          </>
        )}
      </section>

      {/* manager picker overlay (mirrors sale/charge.tsx pattern) */}
      {pickerOpen && !pickedManager && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          data-testid="manager-picker"
        >
          <Card className="w-full max-w-sm p-5 pb-6">
            <h3 className="mb-4 text-center text-base font-semibold">
              Pick a manager
            </h3>
            {managers === undefined ? (
              <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading managers…</span>
              </div>
            ) : managers.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No active managers found.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {managers.map((m) => (
                  <Button
                    key={m.code}
                    variant="outline"
                    className="justify-between"
                    data-testid={`pick-manager-${m.code}`}
                    onClick={() => {
                      setPickedManager(m);
                      setPinError(undefined);
                    }}
                  >
                    <span>{m.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {m.code}
                    </span>
                  </Button>
                ))}
              </div>
            )}
            <Button
              variant="ghost"
              className="mt-4 w-full"
              onClick={() => {
                setPickerOpen(false);
                setPickedManager(null);
              }}
            >
              Cancel
            </Button>
          </Card>
        </div>
      )}

      {/* PIN sheet — opens after manager is picked */}
      <PinSheet
        open={pickerOpen && pickedManager !== null}
        title="Confirm refund"
        label={`Enter ${pickedManager?.name ?? "manager"}'s PIN to confirm refund`}
        pending={pinPending}
        error={pinError}
        onSubmit={handlePinSubmit}
        onCancel={() => {
          if (!pinPending) {
            // Step back to picker so user can re-select rather than restart.
            setPickedManager(null);
            setPinError(undefined);
          }
        }}
        extraField={
          pickedManager && (
            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
              <span className="text-sm font-medium">{pickedManager.name}</span>
              <span className="text-xs text-muted-foreground">
                {pickedManager.code}
              </span>
            </div>
          )
        }
      />
    </SpokeLayout>
  );
}

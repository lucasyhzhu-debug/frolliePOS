/**
 * /mgr/refunds-pending — manager settlement surface (v0.5.1 PR B B24)
 *
 * ADR-038: settlement is bookkeeping ack, NOT a money-authorising decision —
 * the money decision was made at refund APPROVAL time (booth or Telegram PIN).
 * Per CLAUDE.md business rule #22, this surface is MANAGER SESSION gated only,
 * not PIN-gated.
 *
 * FIFO list of pending refunds; row "Mark settled" flips
 * settlement_status pending → settled. The query is reactive — settled rows
 * disappear from the list on success.
 *
 * Per-row idempotency: hooks can't be called in a loop, so we mint a fresh
 * crypto.randomUUID() at click time (same pattern as sale/drafts.tsx). Server
 * dedupe (pos_idempotency, ADR-013) covers network retries; the mutation is
 * also explicitly idempotent on already-settled refunds (returns the existing
 * settled_by / settled_at without re-patching).
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { rp, fmtDate, fmtTime } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { toast } from "sonner";
import type { Id } from "../../../convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";

// B28a M2: listPendingSettlement now returns a projection (not full Doc).
// Derive the element type from the API surface so the component stays in
// sync without re-declaring the shape here.
type PendingRefundRow = NonNullable<
  FunctionReturnType<typeof api.refunds.public.listPendingSettlement>
>[number];

export default function MgrRefundsPending() {
  const navigate = useNavigate();
  const session = useSession();
  const t = useT();

  if (session.status === "loading") {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </main>
    );
  }

  if (session.status !== "active" || session.staff.role !== "manager") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <p className="text-sm text-muted-foreground">{t("mgrRefunds.managerRequired")}</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/")}>
          {t("mgrRefunds.backToHome")}
        </Button>
      </main>
    );
  }

  return <MgrRefundsPendingInner sessionId={session.sessionId} />;
}

function MgrRefundsPendingInner({ sessionId }: { sessionId: Id<"staff_sessions"> }) {
  const refunds = useQuery(api.refunds.public.listPendingSettlement, { sessionId });
  const markSettled = useMutation(api.refunds.public.markRefundSettled);
  const t = useT();

  return (
    <SpokeLayout title={t("mgrRefunds.title")} backTo="/mgr/dashboard">
      <div className="flex flex-1 flex-col gap-4 p-4">
        {refunds === undefined ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : (
          <>
            <SummaryHeader refunds={refunds} />
            {refunds.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-center">
                <p className="text-sm text-muted-foreground">
                  {t("mgrRefunds.empty")}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {refunds.map((refund) => (
                  <RefundRow
                    key={refund._id}
                    refund={refund}
                    sessionId={sessionId}
                    markSettled={markSettled}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </SpokeLayout>
  );
}

function SummaryHeader({ refunds }: { refunds: PendingRefundRow[] }) {
  const count = refunds.length;
  const totalSum = refunds.reduce((acc, r) => acc + r.total_refund, 0);
  const t = useT();
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-md border bg-muted/30 p-3">
      <p className="text-sm font-medium" data-testid="refunds-pending-count">
        {t(count === 1 ? "mgrRefunds.pendingCount_one" : "mgrRefunds.pendingCount_other", { count })}
      </p>
      <p className="text-sm tabular-nums" data-testid="refunds-pending-sum">
        {rp(totalSum)}
      </p>
    </div>
  );
}

function RefundRow({
  refund,
  sessionId,
  markSettled,
}: {
  refund: PendingRefundRow;
  sessionId: Id<"staff_sessions">;
  markSettled: ReturnType<typeof useMutation<typeof api.refunds.public.markRefundSettled>>;
}) {
  const [busy, setBusy] = useState(false);
  const t = useT();

  async function handleSettle() {
    setBusy(true);
    try {
      await markSettled({
        sessionId,
        idempotencyKey: crypto.randomUUID(),
        refundId: refund._id,
      });
      toast.success(t("mgrRefunds.settledSuccess"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex items-center justify-between gap-3 p-3">
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold tabular-nums">{rp(refund.total_refund)}</p>
        <p className="text-xs text-muted-foreground">
          {fmtDate(refund.created_at)} · {fmtTime(refund.created_at)}
        </p>
        {refund.reason && (
          <p className="text-xs text-muted-foreground line-clamp-2">{refund.reason}</p>
        )}
      </div>
      <Button size="sm" onClick={handleSettle} disabled={busy}>
        {busy ? t("mgrRefunds.settling") : t("mgrRefunds.markSettled")}
      </Button>
    </Card>
  );
}

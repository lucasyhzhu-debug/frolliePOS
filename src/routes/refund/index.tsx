import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Card } from "@/components/ui/card";
import { rp, fmtDate, fmtTime } from "@/lib/format";
import { useT } from "@/lib/i18n";

export default function RefundList() {
  const t = useT();
  const navigate = useNavigate();
  const session = useSession();
  const txns = useQuery(
    api.refunds.public.listTodaysRefundable,
    session.status === "active" ? { sessionId: session.sessionId } : "skip",
  );

  if (!txns) return (
    <SpokeLayout title={t("refund.title")}>
      <div className="p-6 text-center text-muted-foreground">{t("common.loading")}</div>
    </SpokeLayout>
  );

  return (
    <SpokeLayout title={t("refund.title")}>
      <div className="p-4 space-y-2">
        {txns.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            {t("refund.noTransactionsToday")}
          </Card>
        ) : (
          txns.map((txn) => (
            <button
              key={txn._id}
              type="button"
              onClick={() => navigate(`/refund/${txn._id}`)}
              className="block w-full text-left border border-border rounded-md p-3 hover:bg-accent"
            >
              <div className="flex justify-between text-sm">
                <span className="font-medium">{txn.receipt_number ?? t("refund.noReceiptNumber")}</span>
                <span className="font-semibold">{rp(txn.total)}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {fmtDate(txn.paid_at ?? txn.created_at)} · {fmtTime(txn.paid_at ?? txn.created_at)}
              </div>
            </button>
          ))
        )}
        <Card className="p-4 mt-6 text-xs text-muted-foreground bg-muted">
          {t("refund.olderTransactionsHint")}
        </Card>
      </div>
    </SpokeLayout>
  );
}

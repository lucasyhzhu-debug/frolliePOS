import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Card } from "@/components/ui/card";
import { rp, fmtDate, fmtTime } from "@/lib/format";

export default function RefundList() {
  const navigate = useNavigate();
  const session = useSession();
  const txns = useQuery(
    api.refunds.public.listTodaysRefundable,
    session.status === "active" ? { sessionId: session.sessionId } : "skip",
  );

  if (!txns) return <SpokeLayout title="Refund"><div className="p-6 text-center text-muted-foreground">Loading…</div></SpokeLayout>;

  return (
    <SpokeLayout title="Refund">
      <div className="p-4 space-y-2">
        {txns.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Belum ada transaksi hari ini.
          </Card>
        ) : (
          txns.map((t) => (
            <button
              key={t._id}
              type="button"
              onClick={() => navigate(`/refund/${t._id}`)}
              className="block w-full text-left border border-border rounded-md p-3 hover:bg-accent"
            >
              <div className="flex justify-between text-sm">
                <span className="font-medium">{t.receipt_number ?? "(no receipt #)"}</span>
                <span className="font-semibold">{rp(t.total)}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {fmtDate(t.paid_at ?? t.created_at)} · {fmtTime(t.paid_at ?? t.created_at)}
              </div>
            </button>
          ))
        )}
        <Card className="p-4 mt-6 text-xs text-muted-foreground bg-muted">
          Mencari transaksi yang lebih lama? Mohon hubungi management secara langsung.
        </Card>
      </div>
    </SpokeLayout>
  );
}

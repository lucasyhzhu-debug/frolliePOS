import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { rp, fmtTime } from "@/lib/format";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { INSTRUMENT_LABEL, REFUND_BADGE } from "@/lib/pos-labels";

/**
 * v0.5.3a T9 — transaction history list.
 *
 * Backed by `transactions.public.listDayTransactions`. Manager sessions get a
 * day picker (server-today by default; otherwise YYYY-MM-DD WIB). Staff
 * sessions get today only — backend today-collapses regardless, but exposing
 * the picker would be misleading, so we hide it.
 *
 * Each row links to /history/:txnId. The detail route ships in T11; this list
 * is harmless without it because Link just navigates — the destination
 * resolves later when the router gains the entry.
 */

export default function HistoryIndex() {
  const session = useSession();
  const sessionId = session.status === "active" ? session.sessionId : null;
  const role = session.status === "active" ? session.staff.role : "staff";

  // Manager-only date picker. Undefined → server-today (WIB). Staff role
  // ignores the picker entirely — backend today-collapses anyway.
  const [day, setDay] = useState<string | undefined>(undefined);

  const rows = useQuery(
    api.transactions.public.listDayTransactions,
    sessionId
      ? { sessionId, day: role === "manager" ? day : undefined }
      : "skip",
  );

  // ---- render guards ----
  if (session.status === "loading") {
    return (
      <SpokeLayout title="Riwayat">
        <main className="flex flex-1 flex-col p-4">
          <div className="text-sm text-muted-foreground">Memuat…</div>
        </main>
      </SpokeLayout>
    );
  }
  if (session.status !== "active") return null;

  // Empty-state copy varies by whether the manager picked a non-default day.
  // For staff (no picker) and the default manager view, we render the
  // "today" copy. Once a manager picks any day, we render the generic copy
  // — even if that day happens to be today, because the user explicitly
  // navigated rather than landing on it.
  const emptyCopy =
    role === "manager" && day !== undefined
      ? "Belum ada transaksi"
      : "Belum ada transaksi hari ini";

  return (
    <SpokeLayout title="Riwayat" backTo="/">
      <section className="flex-1 overflow-y-auto p-4">
        {role === "manager" ? (
          <div className="mb-4 flex items-center gap-2">
            <label
              htmlFor="history-day"
              className="text-xs font-medium text-muted-foreground"
            >
              Tanggal
            </label>
            <input
              id="history-day"
              type="date"
              value={day ?? ""}
              onChange={(e) => setDay(e.target.value || undefined)}
              className="rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {day !== undefined && (
              <button
                type="button"
                onClick={() => setDay(undefined)}
                aria-label="Reset to today"
                className="text-xs text-muted-foreground underline"
              >
                Hari ini
              </button>
            )}
          </div>
        ) : null}

        {rows === undefined ? (
          // Skeleton — three placeholder rows roughly matching the real list
          // metric. Matches the cadence the user expects while Convex resolves.
          <ul className="space-y-3" data-testid="history-skeleton">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Card className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                  </div>
                  <div className="h-4 w-16 animate-pulse rounded bg-muted" />
                </Card>
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <div
            className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground"
            data-testid="history-empty"
          >
            {emptyCopy}
          </div>
        ) : (
          <ul className="space-y-3" data-testid="history-list">
            {rows.map((t) => {
              // refundStatus is pre-computed by the BE day-window aggregator —
              // single derivation matches the receipt template + detail badge.
              const badge = REFUND_BADGE[t.refundStatus];
              const instrumentLabel = INSTRUMENT_LABEL[t.instrument];
              return (
                <li key={t._id}>
                  <Link
                    to={`/history/${t._id}`}
                    className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
                  >
                    <Card className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium tabular-nums">
                          {rp(t.total)}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {fmtTime(t.created_at)} · {t.staff_name}
                          {t.voucher_code_snapshot
                            ? ` · ${t.voucher_code_snapshot}`
                            : null}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge
                          variant="outline"
                          className="text-[10px] uppercase tracking-wide"
                        >
                          {instrumentLabel}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={`text-[10px] uppercase tracking-wide ${badge.cls}`}
                        >
                          {badge.label}
                        </Badge>
                      </div>
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </SpokeLayout>
  );
}

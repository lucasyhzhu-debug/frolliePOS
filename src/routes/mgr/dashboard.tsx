/**
 * /mgr/dashboard — v0.5.3a manager dashboard.
 *
 * Calls `api.transactions.public.dashboardSummary` (manager-gated) and renders
 * the seven required cards. Backend throws MANAGER_ONLY for staff sessions and
 * NO_SESSION for invalid sessions — we gate the entry to avoid both. A non-
 * manager session sees a "Hanya manajer" card; the query is skipped in that case.
 *
 * Day picker mirrors /history (Indonesian "Hari ini" reset chip). Pure SVG/CSS
 * for the hourly curve — no charting lib (YAGNI).
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { DaySummary } from "../../../convex/transactions/lib";
import { useSession } from "@/hooks/useSession";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { rp } from "@/lib/format";

const HOURLY_LABELS = [0, 6, 12, 18, 24];

const INSTRUMENT_LABEL: Record<"qris" | "bca_va" | "unknown", string> = {
  qris: "QRIS",
  bca_va: "BCA VA",
  unknown: "Tidak diketahui",
};

export default function MgrDashboard() {
  const session = useSession();
  const navigate = useNavigate();
  const sessionId = session.status === "active" ? session.sessionId : null;
  const isManager =
    session.status === "active" && session.staff.role === "manager";
  const [day, setDay] = useState<string | undefined>(undefined);

  // Skip the query for non-manager/no-session — backend would reject anyway,
  // skipping saves a roundtrip and avoids a thrown render.
  const summary = useQuery(
    api.transactions.public.dashboardSummary,
    sessionId && isManager ? { sessionId, day } : "skip",
  );

  if (session.status === "loading") {
    return (
      <SpokeLayout title="Dashboard">
        <div className="p-4 text-sm text-muted-foreground">Memuat…</div>
      </SpokeLayout>
    );
  }

  if (session.status === "active" && !isManager) {
    return (
      <SpokeLayout title="Dashboard" backTo="/">
        <Card className="m-4 p-6 text-center text-sm text-muted-foreground">
          Hanya manajer dapat melihat dashboard.
        </Card>
      </SpokeLayout>
    );
  }

  return (
    <SpokeLayout title="Dashboard" backTo="/">
      <div className="flex flex-col gap-3 p-3 lg:mx-auto lg:max-w-6xl">
        <div className="flex items-center gap-2">
          <label
            htmlFor="dashboard-day"
            className="text-xs font-medium text-muted-foreground"
          >
            Tanggal
          </label>
          <input
            id="dashboard-day"
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

        {summary === undefined ? (
          <DashboardSkeleton />
        ) : (
          <div
            className="grid grid-cols-1 gap-3 lg:grid-cols-3"
            data-testid="dashboard-grid"
          >
            <TotalsCard s={summary} />
            <PaymentMixCard s={summary} />
            <NeedsAttentionCard
              s={summary}
              onNavigate={() => navigate("/history")}
            />
            <TopSkusCard s={summary} />
            <HourlyCurveCard s={summary} />
            <VoucherUsageCard s={summary} />
            <PerStaffCard s={summary} />
          </div>
        )}
      </div>
    </SpokeLayout>
  );
}

function DashboardSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-3 lg:grid-cols-3"
      data-testid="dashboard-skeleton"
    >
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <Card key={i} className="p-4">
          <div className="mb-3 h-3 w-20 animate-pulse rounded bg-muted" />
          <div className="h-16 w-full animate-pulse rounded bg-muted" />
        </Card>
      ))}
    </div>
  );
}

function TotalsCard({ s }: { s: DaySummary }) {
  return (
    <Card className="p-4" data-testid="totals-card">
      <h3 className="mb-3 text-sm font-semibold">Total hari ini</h3>
      <dl className="grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Bruto</dt>
        <dd className="text-right tabular-nums" data-testid="totals-gross">
          {rp(s.gross)}
        </dd>
        <dt className="text-muted-foreground">Refund</dt>
        <dd className="text-right tabular-nums">{rp(s.refundsTotal)}</dd>
        <dt className="font-medium">Neto</dt>
        <dd className="text-right font-medium tabular-nums">{rp(s.net)}</dd>
        <dt className="text-muted-foreground">Transaksi</dt>
        <dd className="text-right tabular-nums">{s.count}</dd>
        <dt className="text-muted-foreground">Rata-rata</dt>
        <dd className="text-right tabular-nums">{rp(s.avgBasket)}</dd>
      </dl>
    </Card>
  );
}

function PaymentMixCard({ s }: { s: DaySummary }) {
  const rows: Array<keyof DaySummary["paymentMix"]> = [
    "qris",
    "bca_va",
    "unknown",
  ];
  return (
    <Card className="p-4" data-testid="payment-mix-card">
      <h3 className="mb-3 text-sm font-semibold">Metode pembayaran</h3>
      <ul className="space-y-1.5 text-sm">
        {rows.map((k) => (
          <li key={k} className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{INSTRUMENT_LABEL[k]}</span>
            <span className="tabular-nums">
              {s.paymentMix[k].count} · {rp(s.paymentMix[k].total)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TopSkusCard({ s }: { s: DaySummary }) {
  return (
    <Card className="p-4" data-testid="top-skus-card">
      <h3 className="mb-3 text-sm font-semibold">Top SKU</h3>
      {s.topSkus.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada penjualan.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {s.topSkus.map((sku) => (
            <li
              key={sku.code}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">{sku.name}</span>
              <span className="tabular-nums text-muted-foreground">
                {sku.qty}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HourlyCurveCard({ s }: { s: DaySummary }) {
  const max = Math.max(1, ...s.hourlyCurve);
  return (
    <Card className="p-4" data-testid="hourly-curve-card">
      <h3 className="mb-2 text-sm font-semibold">Per jam</h3>
      <div className="flex h-24 items-end gap-px rounded bg-muted/30 p-1">
        {s.hourlyCurve.map((n, h) => (
          <div
            key={h}
            className="flex-1 rounded-sm bg-primary/60"
            style={{ height: `${(n / max) * 100}%` }}
            title={`${h}:00 — ${n} txn`}
            data-testid={`hour-bar-${h}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        {HOURLY_LABELS.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
    </Card>
  );
}

function VoucherUsageCard({ s }: { s: DaySummary }) {
  return (
    <Card className="p-4" data-testid="voucher-usage-card">
      <h3 className="mb-3 text-sm font-semibold">Voucher</h3>
      <dl className="grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Dipakai</dt>
        <dd className="text-right tabular-nums">{s.voucherUsage.count}</dd>
        <dt className="text-muted-foreground">Total diskon</dt>
        <dd className="text-right tabular-nums">{rp(s.voucherUsage.total)}</dd>
      </dl>
    </Card>
  );
}

function PerStaffCard({ s }: { s: DaySummary }) {
  return (
    <Card className="p-4" data-testid="per-staff-card">
      <h3 className="mb-3 text-sm font-semibold">Per staf</h3>
      {s.perStaff.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada penjualan.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {s.perStaff.map((p) => (
            <li
              key={String(p.staffId)}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">{p.name}</span>
              <span className="tabular-nums text-muted-foreground">
                {p.count} · {rp(p.total)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NeedsAttentionCard({
  s,
  onNavigate,
}: {
  s: DaySummary;
  onNavigate: () => void;
}) {
  const flagged = s.needsAttention.flagged;
  return (
    <Card className="p-4" data-testid="needs-attention-card">
      <h3 className="mb-3 text-sm font-semibold">Perlu perhatian</h3>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{flagged}</p>
          <p className="text-xs text-muted-foreground">Transaksi bermasalah</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onNavigate}
          disabled={flagged === 0}
        >
          Lihat transaksi bermasalah
        </Button>
      </div>
    </Card>
  );
}

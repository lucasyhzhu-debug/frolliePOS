/**
 * Owner cockpit home — real dashboard landing (v1.3.0 Spec-3 Task 9).
 * Replaces the Spec-2 placeholder with live consolidated + per-outlet summaries.
 * Gated by RootLayout's cockpit branch (kind="cockpit" session required).
 * Amber .theme-owner applied by RootLayout — semantic tokens only here.
 *
 * Consolidated headline is always business-wide (independent of the outlet
 * switcher). The per-outlet section filters by `currentOutletId` from
 * `useOutletContext`: "all" shows every outlet, a specific Id shows just that
 * one — making the header OutletSwitcher (Task 8) meaningfully scope this view.
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { motion, useReducedMotion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession, clearSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import { useOutletContext } from "@/contexts/OutletContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { rp } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { gridContainerVariants, gridItemVariants } from "@/lib/motion";

// ── local types ────────────────────────────────────────────────────────────────

type OutletRow = {
  outletId: Id<"outlets">;
  code: string;
  name: string;
  gross: number;
  txnCount: number;
  refundTotal: number;
};

// ── page component ─────────────────────────────────────────────────────────────

export default function CockpitHomeRoute() {
  const navigate = useNavigate();
  const session = useSession();
  const t = useT();
  const logoutCockpit = useMutation(api.auth.public.logoutCockpit);
  const logoutKey = useIdempotency("cockpit:logout");
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { currentOutletId } = useOutletContext();

  const ownerName = session.status === "active" ? session.staff.name : "";
  const sessionId = session.status === "active" ? session.sessionId : null;

  // ── queries ──────────────────────────────────────────────────────────────────

  const perOutlet = useQuery(
    api.cockpit.dashboard.perOutletSummary,
    sessionId ? { sessionId } : "skip",
  );

  // Derive consolidated headline client-side by reducing over perOutlet rows.
  const consolidatedData =
    perOutlet === undefined
      ? undefined
      : {
          gross: perOutlet.reduce((a, r) => a + r.gross, 0),
          txnCount: perOutlet.reduce((a, r) => a + r.txnCount, 0),
          refundTotal: perOutlet.reduce((a, r) => a + r.refundTotal, 0),
        };

  // Filter per-outlet based on the outlet switcher selection.
  // Consolidated headline is unaffected — always business-wide.
  const displayOutlets: OutletRow[] | undefined =
    perOutlet === undefined
      ? undefined
      : currentOutletId === "all"
        ? perOutlet
        : perOutlet.filter((o) => o.outletId === currentOutletId);

  const reduce = useReducedMotion() ?? false;

  // ── sign-out ─────────────────────────────────────────────────────────────────

  const onSignOut = async () => {
    if (session.status !== "active" || !logoutKey) return;
    setSigningOut(true);
    setError(null);
    try {
      await logoutCockpit({ idempotencyKey: logoutKey, sessionId: session.sessionId });
    } catch (err) {
      // Best-effort: clear the local session regardless so the owner always lands
      // back on the login screen. Surface a soft note only.
      setError(errorMessage(err));
    }
    clearSession();
    navigate("/cockpit/login", { replace: true });
  };

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <main className="flex flex-1 flex-col gap-4 bg-background p-4 md:p-6">
      {/* ── page header ──────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t("cockpitHome.eyebrow")}
          </p>
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            {t("cockpitDashboard.todayLabel")}
          </h1>
          {ownerName && (
            <p className="text-sm text-muted-foreground">{ownerName}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground"
          onClick={onSignOut}
          disabled={signingOut}
        >
          {signingOut ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("cockpitLogin.signOut")}
            </span>
          ) : (
            t("cockpitLogin.signOut")
          )}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* ── consolidated headline — focal point ─────────────────────────────── */}
      {consolidatedData === undefined ? (
        <ConsolidatedSkeleton />
      ) : (
        <ConsolidatedCard data={consolidatedData} />
      )}

      {/* ── per-outlet section ───────────────────────────────────────────────── */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {t("cockpitDashboard.outletsSectionTitle")}
        </p>
        {displayOutlets === undefined ? (
          <OutletsSkeleton />
        ) : displayOutlets.length === 0 && currentOutletId === "all" ? (
          <EmptyOutlets />
        ) : displayOutlets.length === 0 ? (
          // A specific outlet is selected but nothing to show (stale id handled
          // by OutletContext safety-fallback; this is an unlikely edge state)
          <div data-testid="no-outlet-data" />
        ) : (
          <motion.div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            variants={gridContainerVariants(reduce)}
            initial="hidden"
            animate="show"
            data-testid="outlets-grid"
          >
            {displayOutlets.map((outlet) => (
              <OutletCard
                key={String(outlet.outletId)}
                outlet={outlet}
                reduce={reduce}
              />
            ))}
          </motion.div>
        )}
      </div>
    </main>
  );
}

// ── consolidated headline card ─────────────────────────────────────────────────

function ConsolidatedCard({ data }: { data: { gross: number; txnCount: number; refundTotal: number } }) {
  const t = useT();
  return (
    <Card className="border-primary/20 p-5" data-testid="consolidated-card">
      <p className="mb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
        {t("cockpitDashboard.gross")}
      </p>
      <p
        className="text-3xl font-bold tabular-nums text-primary"
        data-testid="consolidated-gross"
      >
        {rp(data.gross)}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("cockpitDashboard.net")}:{" "}
        <span className="font-semibold tabular-nums text-foreground" data-testid="consolidated-net">
          {rp(data.gross - data.refundTotal)}
        </span>
      </p>
      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
        <div>
          <p className="text-xs text-muted-foreground">
            {t("cockpitDashboard.txnCount")}
          </p>
          <p
            className="text-lg font-semibold tabular-nums"
            data-testid="consolidated-txn-count"
          >
            {data.txnCount}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">
            {t("cockpitDashboard.refundTotal")}
          </p>
          <p
            className="text-lg font-semibold tabular-nums"
            data-testid="consolidated-refund-total"
          >
            {rp(data.refundTotal)}
          </p>
        </div>
      </div>
    </Card>
  );
}

function ConsolidatedSkeleton() {
  return (
    <Card className="p-5" data-testid="consolidated-skeleton">
      <div className="mb-1 h-3 w-16 animate-pulse rounded bg-muted" />
      <div className="h-9 w-40 animate-pulse rounded bg-muted" />
      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
        <div className="space-y-1.5">
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
          <div className="h-6 w-10 animate-pulse rounded bg-muted" />
        </div>
        <div className="space-y-1.5">
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
          <div className="h-6 w-24 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </Card>
  );
}

// ── per-outlet card ────────────────────────────────────────────────────────────

function OutletCard({
  outlet,
  reduce,
}: {
  outlet: OutletRow;
  reduce: boolean;
}) {
  const t = useT();
  return (
    <motion.div
      variants={gridItemVariants(reduce)}
      data-testid={`outlet-card-${outlet.code}`}
    >
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="truncate font-semibold" data-testid="outlet-name">
            {outlet.name}
          </span>
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {outlet.code}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">
            {t("cockpitDashboard.gross")}
          </dt>
          <dd
            className="text-right font-medium tabular-nums text-primary"
            data-testid="outlet-gross"
          >
            {rp(outlet.gross)}
          </dd>
          <dt className="text-muted-foreground">
            {t("cockpitDashboard.txnCount")}
          </dt>
          <dd className="text-right tabular-nums" data-testid="outlet-txn-count">
            {outlet.txnCount}
          </dd>
        </dl>
      </Card>
    </motion.div>
  );
}

function OutletsSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      data-testid="outlets-skeleton"
    >
      {[0, 1].map((i) => (
        <Card key={i} className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="h-4 w-28 animate-pulse rounded bg-muted" />
            <div className="h-4 w-8 animate-pulse rounded bg-muted" />
          </div>
          <div className="space-y-2">
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── empty outlets state ────────────────────────────────────────────────────────

function EmptyOutlets() {
  const t = useT();
  return (
    <Card className="p-8 text-center" data-testid="empty-outlets">
      <p className="mb-3 text-sm text-muted-foreground">
        {t("cockpitDashboard.noOutlets")}
      </p>
      <Button variant="outline" size="sm" asChild>
        <Link to="/cockpit/outlets/new">
          {t("cockpitDashboard.noOutletsCta")}
        </Link>
      </Button>
    </Card>
  );
}

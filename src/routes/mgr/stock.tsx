/**
 * /mgr/stock — manager-only drift log triage surface (v0.6 Task R9, ADR-044).
 *
 * Shows append-only `pos_stock_drift_log` rows written by the nightly
 * stock-recon cron (R7). Manager picks an unresolved row, enters a note
 * explaining the cause (lost paperwork, miscount, theft, manual fix-up,
 * etc), and confirms — calling `inventory.public.resolveDrift` (R8) which
 * patches resolved_at/by/note + audits `stock.recon_drift_resolved`.
 *
 * Manager-session, NOT manager-PIN: drift resolution is bookkeeping —
 * same logic as markRefundSettled / ADR-038 (CLAUDE.md rule #22).
 *
 * Idempotency: one intent per drift row (`drift.resolve:${drift._id}`)
 * so a failed resolve on one row never replays on another. Cleared on
 * success via `clearIntent`.
 *
 * No optimistic update — the reactive listStockDrift query reflects the
 * patched row after the mutation commits.
 */

import { useState } from "react";
import { Navigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id, Doc } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { toast } from "sonner";

const NOTE_MAX = 500;

function humanizeDriftError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (m.includes("DRIFT_NOT_FOUND")) return "Drift entry no longer exists.";
  if (m.includes("NOTE_TOO_LONG")) return "Note must be ≤ 500 characters.";
  if (m.includes("NOTE_INVALID") || m.includes("NOTE_REQUIRED"))
    return "Note cannot be blank.";
  if (m.includes("NOT_MANAGER") || m.includes("MANAGER_ONLY"))
    return "Manager access required.";
  if (m.includes("NO_SESSION") || m.includes("SESSION_INVALID"))
    return "Session expired. Lock and log in again.";
  return "Could not mark resolved. Try again.";
}

export default function MgrStock() {
  const session = useSession();

  if (session.status === "loading") {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (session.status !== "active" || session.staff.role !== "manager") {
    return <Navigate to="/" replace />;
  }

  return <MgrStockInner sessionId={session.sessionId} />;
}

function MgrStockInner({ sessionId }: { sessionId: Id<"staff_sessions"> }) {
  const [includeResolved, setIncludeResolved] = useState(false);
  const drifts = useQuery(api.inventory.public.listStockDrift, {
    sessionId,
    includeResolved,
  });

  return (
    <SpokeLayout title="Stock drift" backTo="/mgr">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Nightly cron at 02:00 WIB compares the stock-movement ledger to the
            cached on_hand. Investigate before manually patching the cache.
          </p>
          <Button
            size="sm"
            variant={includeResolved ? "default" : "outline"}
            onClick={() => setIncludeResolved((s) => !s)}
          >
            {includeResolved ? "Hide resolved" : "Show resolved"}
          </Button>
        </div>

        {drifts === undefined && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}

        {drifts !== undefined && drifts.length === 0 && (
          <Card className="p-4 text-sm text-muted-foreground">
            {includeResolved ? "No drift entries." : "No unresolved drifts."}
          </Card>
        )}

        <div className="flex flex-col gap-2">
          {(drifts ?? []).map((d) => (
            <DriftRow key={d._id} drift={d} sessionId={sessionId} />
          ))}
        </div>
      </div>
    </SpokeLayout>
  );
}

function DriftRow({
  drift,
  sessionId,
}: {
  drift: Doc<"pos_stock_drift_log">;
  sessionId: Id<"staff_sessions">;
}) {
  const [showResolve, setShowResolve] = useState(false);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);

  const resolveDrift = useMutation(api.inventory.public.resolveDrift);
  // One idempotency intent per drift row so a failed resolve on row A never
  // replays on row B. clearIntent on success rotates the key so a manual
  // "resolve again" on a re-opened drift would get a fresh UUID.
  const intent = `drift.resolve:${drift._id}`;
  const key = useIdempotency(intent);

  const deltaLabel = drift.delta > 0 ? `+${drift.delta}` : `${drift.delta}`;
  const detected = new Date(drift.detected_at).toLocaleString();
  const isResolved = drift.resolved_at != null;

  async function handleResolve() {
    if (!key) return;
    const trimmed = note.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      await resolveDrift({
        idempotencyKey: key,
        sessionId,
        driftId: drift._id,
        note: trimmed,
      });
      toast.success("Drift resolved");
      await clearIntent(intent);
      setShowResolve(false);
      setNote("");
    } catch (err) {
      toast.error(humanizeDriftError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-sm font-semibold">
            {drift.sku_code}
          </span>
          <span className="text-xs text-muted-foreground">{detected}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-xs text-muted-foreground">
            <div>cache {drift.cached_on_hand}</div>
            <div>ledger {drift.reconstructed_on_hand}</div>
          </div>
          <Badge variant={isResolved ? "secondary" : "destructive"}>
            Δ {deltaLabel}
          </Badge>
          {!isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowResolve((s) => !s)}
              disabled={pending}
            >
              {showResolve ? "Cancel" : "Mark resolved"}
            </Button>
          )}
        </div>
      </div>

      {isResolved && drift.resolution_note && (
        <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
          Resolved:{" "}
          <span className="italic">{drift.resolution_note}</span>
        </p>
      )}

      {showResolve && !isResolved && (
        <div className="mt-2 flex flex-col gap-2 border-t pt-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What was the cause? (max 500 chars)"
            maxLength={NOTE_MAX}
            rows={3}
            disabled={pending}
            className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">
              {note.length} / {NOTE_MAX}
            </p>
            <Button
              size="sm"
              onClick={handleResolve}
              disabled={pending || !note.trim() || !key}
            >
              {pending ? "Saving…" : "Confirm"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

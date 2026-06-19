import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency } from "@/hooks/useIdempotency";
import { storeSession } from "@/hooks/useSession";
import { useBoothState } from "@/hooks/useBoothState";
import { getLastStaff } from "@/hooks/useLastStaff";
import { StaffListItem } from "@/components/auth/StaffListItem";
import { PinEntry } from "@/components/auth/PinEntry";
import { ConnDot } from "@/components/layout/ConnDot";
import { toast } from "sonner";

type Stage =
  | { kind: "list" }
  | { kind: "pin"; staff: { _id: Id<"staff">; name: string; role: "staff" | "manager" } };

export default function LoginRoute() {
  const navigate = useNavigate();
  const deviceId = useDeviceId();
  const boothState = useBoothState();
  const staff = useQuery(api.auth.public.getActiveStaff, {});
  const login = useAction(api.auth.actions.loginWithPin);
  const recordResume = useMutation(api.shifts.public.recordResume);
  const [stage, setStage] = useState<Stage>({ kind: "list" });
  const [pinReset, setPinReset] = useState(0);

  // Redirect immediately if booth is handover_pending — incoming staff should
  // complete the handover checklist, not go through the plain login flow.
  useEffect(() => {
    if (boothState?.state === "handover_pending") {
      navigate("/shift/handover", { replace: true });
    }
  }, [boothState, navigate]);

  // Pre-stage to PIN entry for the last-known staffer (UX optimisation — no
  // auth bypass; PIN is still required). Runs once when the active-staff list
  // first resolves.
  //
  // Tightened (v1.2 #6): only auto-pre-stage when:
  //   a) booth is "locked" AND lastStaff matches booth.staffId (same-person resume), OR
  //   b) booth state is unknown/loading (undefined) or "open" — normal login.
  //
  // Silently falls back to the list if the stored id is absent from the active
  // list (deactivated, removed, or never set).
  const hasPreStaged = useRef(false);
  useEffect(() => {
    if (hasPreStaged.current) return;
    if (staff === undefined) return;
    const lastId = getLastStaff();
    if (!lastId) return;
    const match = staff.find((s) => s._id === lastId);
    if (!match) return;

    // When booth is locked, only auto-pre-stage if the locked staffId matches.
    // This prevents auto-selecting the wrong person when a different staff
    // walks up (they must pick themselves from the list).
    if (boothState?.state === "locked" && boothState.staffId !== lastId) return;

    // Only flip the ref after a successful pre-stage.
    hasPreStaged.current = true;
    setStage({ kind: "pin", staff: match });
  }, [staff, boothState]);

  // Use a stable fallback while deviceId resolves so useIdempotency key is stable.
  // Include `pinReset` so each retry mints a FRESH idempotencyKey — otherwise
  // every wrong-PIN attempt re-uses the same key and the server's
  // `_recordFailedAttempt_internal` dedupes them, freezing fail_count at 1 and
  // silently preventing lockout.
  const intentKey = stage.kind === "pin"
    ? `login:${stage.staff._id}:${deviceId ?? "pending"}:${pinReset}`
    : "login:none";
  const idempotencyKey = useIdempotency(intentKey);

  // Reactive notification when the manager declines a pending PIN-reset for
  // this staff.
  const recentPinReset = useQuery(
    api.approvals.public.getRecentPinResetForStaff,
    stage.kind === "pin" ? { staffId: stage.staff._id } : "skip",
  );
  const shownDenialRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!recentPinReset || recentPinReset.status !== "denied") return;
    if (shownDenialRef.current.has(recentPinReset.requestId)) return;
    shownDenialRef.current.add(recentPinReset.requestId);
    const name = recentPinReset.denied_by_manager_name ?? "manager";
    const code = recentPinReset.denied_by_manager_code;
    const denierLabel = code ? `${name} (${code})` : name;
    const reason = recentPinReset.deny_reason;
    toast.error(
      reason
        ? `PIN reset declined by ${denierLabel} — "${reason}". Wait for the 60-second lockout to expire and try again.`
        : `PIN reset declined by ${denierLabel}. Wait for the 60-second lockout to expire and try again.`,
      { duration: 10_000 },
    );
  }, [recentPinReset]);

  const onPinSubmit = async (pin: string) => {
    if (stage.kind !== "pin") return;
    if (!deviceId) { toast.error("Device not ready — please wait"); return; }
    if (!idempotencyKey) return; // IDB not yet resolved — guard ADR-013
    try {
      const { sessionId } = await login({
        staffId: stage.staff._id, pin, deviceId, idempotencyKey,
      });
      storeSession(sessionId, stage.staff._id);

      // Navigation fork on resolved booth state (v1.2 #6).
      //   closed        → start of day checklist
      //   locked + same staff → record resume, then home
      //   open or undefined → home (normal login)
      // (handover_pending is handled by the redirect effect above.)
      if (boothState?.state === "closed") {
        navigate("/shift/start", { replace: true });
      } else if (boothState?.state === "locked") {
        await recordResume({ idempotencyKey: `${idempotencyKey}:resume`, sessionId });
        navigate("/", { replace: true });
      } else {
        navigate("/", { replace: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      const lockedMatch = msg.match(/LOCKED_OUT:(\d+)/);
      const friendly =
        lockedMatch
          ? `Locked out. A manager has been notified to reset your PIN. Wait ${lockedMatch[1]}s to retry, or use the new PIN once it lands.`
          : msg.includes("INVALID_PIN") ? "Wrong PIN." :
            msg;
      toast.error(friendly);
      setPinReset((n) => n + 1);
    }
  };

  // Show a minimal loading state while the device id is being resolved from IDB.
  if (deviceId === null) {
    return (
      <main className="flex flex-1 flex-col p-6">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col p-6">
      {/* Brand mark */}
      <div className="mb-8 flex flex-col items-center gap-1 pt-6">
        <span className="text-2xl font-bold tracking-tight text-primary">frollie</span>
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Point of Sale
        </span>
      </div>

      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">
          {stage.kind === "list" ? "Who's working?" : stage.staff.name}
        </h1>
        <ConnDot />
      </header>

      {stage.kind === "list" ? (
        <div className="flex flex-col gap-2">
          {staff === undefined ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : staff.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No staff yet. A manager needs to create staff records.
            </div>
          ) : (
            staff.map((s) => (
              <StaffListItem
                key={s._id} name={s.name} role={s.role}
                onClick={() => setStage({ kind: "pin", staff: s })}
              />
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          <PinEntry onSubmit={onPinSubmit} reset={pinReset} />
          <button
            type="button"
            onClick={() => setStage({ kind: "list" })}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            ← back
          </button>
        </div>
      )}
    </main>
  );
}

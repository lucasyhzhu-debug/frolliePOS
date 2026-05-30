import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency } from "@/hooks/useIdempotency";
import { storeSession } from "@/hooks/useSession";
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
  const staff = useQuery(api.auth.public.getActiveStaff, {});
  const login = useAction(api.auth.actions.loginWithPin);
  const [stage, setStage] = useState<Stage>({ kind: "list" });
  const [pinReset, setPinReset] = useState(0);

  // Use a stable fallback while deviceId resolves so useIdempotency key is stable.
  // Include `pinReset` so each retry mints a FRESH idempotencyKey — otherwise
  // every wrong-PIN attempt re-uses the same key and the server's
  // `_recordFailedAttempt_internal` dedupes them, freezing fail_count at 1 and
  // silently preventing lockout (and the v0.4 off-booth notifyStaffLockout fan-out).
  const intentKey = stage.kind === "pin"
    ? `login:${stage.staff._id}:${deviceId ?? "pending"}:${pinReset}`
    : "login:none";
  const idempotencyKey = useIdempotency(intentKey);

  const onPinSubmit = async (pin: string) => {
    if (stage.kind !== "pin") return;
    if (!deviceId) { toast.error("Device not ready — please wait"); return; }
    if (!idempotencyKey) return; // IDB not yet resolved — guard ADR-013
    try {
      const { sessionId } = await login({
        staffId: stage.staff._id, pin, deviceId, idempotencyKey,
      });
      storeSession(sessionId);
      navigate("/", { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      const lockedMatch = msg.match(/LOCKED_OUT:(\d+)/);
      const friendly =
        lockedMatch ? `Too many tries. Wait ${lockedMatch[1]} seconds.` :
        msg.includes("INVALID_PIN") ? "Wrong PIN." :
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
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">
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

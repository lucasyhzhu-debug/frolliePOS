import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useSession, clearSession, storeSession } from "@/hooks/useSession";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency } from "@/hooks/useIdempotency";
import { PinSheet } from "@/components/pos/PinSheet";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function Lock() {
  const navigate = useNavigate();
  const session = useSession();
  const deviceId = useDeviceId();
  const lockShift = useMutation(api.shifts.public.lockShift);
  const managerTakeover = useAction(api.shifts.actions.managerTakeover);
  // Two distinct idempotency key roots — they MUST NOT share a root because after
  // clearSession the session-based key collapses to `lock:none`, which would
  // collide between lock and takeover paths.
  //   lockKey  → keyed on sessionId (available for the active lock action)
  //   takeoverKey → keyed on deviceId (stable across clearSession; takeover
  //                 happens with no active session so sessionId is unreliable)
  const lockKey = useIdempotency(`shift:lock:${session.sessionId ?? "none"}`);
  const takeoverKey = useIdempotency(`shift:takeover:${deviceId ?? "none"}`);

  // Manager-takeover state
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [pickedManager, setPickedManager] = useState<{
    _id: Id<"staff">;
    name: string;
  } | null>(null);
  const [takeoverError, setTakeoverError] = useState<string | undefined>();
  const [takeoverPending, setTakeoverPending] = useState(false);

  // Fetch active staff to filter for managers. Public query (no session needed)
  // so it works even when the session is about to be cleared.
  const allStaff = useQuery(api.auth.public.getActiveStaff, {});
  const managers = allStaff?.filter((s) => s.role === "manager") ?? [];

  if (session.status !== "active") return null;

  const handleLock = async () => {
    if (!session.sessionId || !lockKey) return;
    await lockShift({ sessionId: session.sessionId, idempotencyKey: lockKey });
    clearSession();
    navigate("/login", { replace: true });
  };

  const handleTakeoverOpen = () => {
    setPickedManager(null);
    setTakeoverError(undefined);
    setTakeoverOpen(true);
  };

  const handleTakeoverPin = async (pin: string) => {
    if (!deviceId || !takeoverKey || !pickedManager) {
      setTakeoverError("Device or manager not ready");
      return;
    }
    setTakeoverPending(true);
    setTakeoverError(undefined);
    try {
      const { sessionId } = await managerTakeover({
        idempotencyKey: takeoverKey,
        deviceId,
        managerStaffId: pickedManager._id,
        managerPin: pin,
      });
      storeSession(sessionId, pickedManager._id);
      setTakeoverOpen(false);
      navigate("/shift/handover", { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Takeover failed";
      setTakeoverError(
        msg.includes("INVALID_PIN") ? "Wrong PIN." :
        msg.includes("NOT_MANAGER") ? "Not a manager account." :
        msg.includes("LOCKED_OUT") ? "Account locked. Try again later." :
        msg,
      );
    } finally {
      setTakeoverPending(false);
    }
  };

  return (
    <SpokeLayout title="Lock + handoff">
      <div className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-sm p-6 text-center">
          <h2 className="text-lg font-semibold">End {session.staff.name}&apos;s shift?</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The next person taps their name and PIN to sign in.
          </p>
          <div className="mt-6 flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => navigate("/")}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleLock}>
              Lock
            </Button>
          </div>
          <div className="mt-4">
            <Button variant="ghost" size="sm" onClick={handleTakeoverOpen}>
              Manajer buka kunci
            </Button>
          </div>
        </Card>
      </div>

      {/* Manager-picker + PIN sheet for takeover */}
      <PinSheet
        open={takeoverOpen}
        title="Manajer buka kunci"
        label={
          pickedManager
            ? `PIN untuk ${pickedManager.name}`
            : "Pilih manajer dulu"
        }
        pending={takeoverPending}
        error={takeoverError}
        onSubmit={pickedManager ? handleTakeoverPin : () => undefined}
        onCancel={() => {
          setTakeoverOpen(false);
          setPickedManager(null);
          setTakeoverError(undefined);
        }}
        extraField={
          !pickedManager ? (
            <div className="flex flex-col gap-1 mb-2">
              {managers.map((m) => (
                <button
                  key={m._id}
                  type="button"
                  className="rounded border border-border bg-card px-3 py-2 text-sm text-left hover:bg-accent"
                  onClick={() => setPickedManager(m)}
                >
                  {m.name}
                </button>
              ))}
              {managers.length === 0 && (
                <p className="text-sm text-muted-foreground">Tidak ada manajer aktif.</p>
              )}
            </div>
          ) : null
        }
      />
    </SpokeLayout>
  );
}

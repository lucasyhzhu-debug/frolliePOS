import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useSession, clearSession } from "@/hooks/useSession";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency } from "@/hooks/useIdempotency";
import { PinSheet } from "@/components/pos/PinSheet";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";

export default function Lock() {
  const navigate = useNavigate();
  const session = useSession();
  const t = useT();
  const deviceId = useDeviceId();
  const lock = useMutation(api.shifts.shifts.lock);
  // managerOverride: force-ends a stranded shift so the blocked staffer can log
  // in normally. Returns { ok: true } (no new session — the manager or original
  // staffer authenticates via the standard login after the override).
  //
  // DESIGN NOTE / UX concern: in the two-level model the primary manager-override
  // escape hatch lives on the LOGIN screen (T11's loginContext path). The override
  // button here is reached by the CURRENT session holder choosing to lock. After
  // lock the holder's session is already ended, so this screen is only visible
  // to an ACTIVE holder. The use-case is "manager wants to force-end a stuck
  // shift before locking their own" — borderline redundant with the login-screen
  // override. Flagged as DONE_WITH_CONCERNS for UX-UAT review; do NOT delete
  // without UX sign-off.
  const managerOverride = useAction(api.shifts.actions.managerOverride);
  // Two distinct idempotency key roots — they MUST NOT share a root because after
  // clearSession the session-based key collapses to `lock:none`, which would
  // collide between lock and override paths.
  //   lockKey      → keyed on sessionId (available for the active lock action)
  //   overrideKey  → keyed on deviceId (stable across clearSession; override
  //                  happens with no active session so sessionId is unreliable)
  const lockKey = useIdempotency(`shift:lock:${session.sessionId ?? "none"}`);
  const [overrideReset, setOverrideReset] = useState(0);
  // C1: distinct prefix for lock-screen override + reset counter so each attempt
  // (success or failure) gets a fresh idempotency key (mirrors pinReset rotation).
  const overrideKey = useIdempotency(`shift:override:lock:${deviceId ?? "none"}:${overrideReset}`);

  // Manager-override state
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [pickedManager, setPickedManager] = useState<{
    _id: Id<"staff">;
    name: string;
  } | null>(null);
  const [overrideError, setOverrideError] = useState<string | undefined>();
  const [overridePending, setOverridePending] = useState(false);

  // Fetch active staff to filter for managers. Public query (no session needed)
  // so it works even when the session is about to be cleared.
  const allStaff = useQuery(api.auth.public.getActiveStaff, {});
  const managers = allStaff?.filter((s) => s.role === "manager") ?? [];

  if (session.status !== "active") return null;

  const handleLock = async () => {
    if (!session.sessionId || !lockKey) return;
    await lock({ sessionId: session.sessionId, idempotencyKey: lockKey });
    clearSession();
    navigate("/login", { replace: true });
  };

  const handleOverrideOpen = () => {
    setPickedManager(null);
    setOverrideError(undefined);
    setOverrideOpen(true);
  };

  const handleOverridePin = async (pin: string) => {
    if (!deviceId || !overrideKey || !pickedManager) {
      setOverrideError(t("lock.errorNotReady"));
      return;
    }
    setOverridePending(true);
    setOverrideError(undefined);
    try {
      await managerOverride({
        idempotencyKey: overrideKey,
        deviceId,
        managerStaffId: pickedManager._id,
        managerPin: pin,
      });
      setOverrideOpen(false);
      // Override just force-ends the stranded shift; the manager (or original
      // staffer) now logs in normally via /login.
      navigate("/login", { replace: true });
    } catch (err) {
      // I-C: use errorMessage() so ConvexError.data is unwrapped correctly
      // (mirrors login.tsx's override error handling pattern).
      const msg = errorMessage(err);
      setOverrideError(
        msg.includes("INVALID_PIN") ? t("lock.errorInvalidPin") :
        msg.includes("NOT_MANAGER") ? t("lock.errorNotManager") :
        msg.includes("LOCKED_OUT") ? t("lock.errorLockedOut") :
        msg,
      );
    } finally {
      setOverridePending(false);
      // C1: rotate key after every attempt so the next call never replays a
      // stale idempotency result (success + failure both rotate).
      setOverrideReset((n) => n + 1);
    }
  };

  return (
    <SpokeLayout title={t("lock.title")}>
      <div className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-sm p-6 text-center">
          <h2 className="text-lg font-semibold">{t("lock.heading", { name: session.staff.name })}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("lock.hint")}
          </p>
          <div className="mt-6 flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => navigate("/")}>
              {t("common.cancel")}
            </Button>
            <Button className="flex-1" onClick={handleLock}>
              {t("lock.lockButton")}
            </Button>
          </div>
          <div className="mt-4">
            <Button variant="ghost" size="sm" onClick={handleOverrideOpen}>
              {t("lock.managerTakeover")}
            </Button>
          </div>
        </Card>
      </div>

      {/* Manager-picker + PIN sheet for override */}
      <PinSheet
        open={overrideOpen}
        title={t("lock.managerTakeover")}
        label={
          pickedManager
            ? t("lock.pinForManager", { name: pickedManager.name })
            : t("lock.pickManagerFirst")
        }
        pending={overridePending}
        error={overrideError}
        onSubmit={pickedManager ? handleOverridePin : () => undefined}
        onCancel={() => {
          setOverrideOpen(false);
          setPickedManager(null);
          setOverrideError(undefined);
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
                <p className="text-sm text-muted-foreground">{t("lock.noManagers")}</p>
              )}
            </div>
          ) : null
        }
      />
    </SpokeLayout>
  );
}

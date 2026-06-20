import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel"; // used in Stage union
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency } from "@/hooks/useIdempotency";
import { storeSession } from "@/hooks/useSession";
import { useBoothState } from "@/hooks/useBoothState";
import { PinSheet } from "@/components/pos/PinSheet";
import CountStep from "@/components/pos/CountStep";
import { StaffListItem } from "@/components/auth/StaffListItem";
import { useT } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";

/**
 * Shift handover — incoming staff flow (spec §3C, Task 15).
 *
 * Stages: pick → pin → count
 *
 *  pick:  List active staff EXCLUDING the outgoing staff (useBoothState().staffId).
 *  pin:   PinSheet → loginWithPin → storeSession (incoming session replaces outgoing).
 *  count: CountStep → completeHandoverIn → navigate("/", { replace: true }).
 *
 * Called from RootLayout when boothState === "handover_pending".
 * After storeSession the session hook reactively updates the app context.
 */

type Stage =
  | { kind: "pick" }
  | { kind: "pin"; staff: { _id: Id<"staff">; name: string; role: "staff" | "manager" } }
  | { kind: "count"; sessionId: Id<"staff_sessions"> };

export default function ShiftHandover() {
  const t = useT();
  const navigate = useNavigate();
  const deviceId = useDeviceId();
  const boothState = useBoothState();

  const allStaff = useQuery(api.auth.public.getActiveStaff, {});
  const loginWithPin = useAction(api.auth.actions.loginWithPin);
  const completeHandoverIn = useMutation(api.shifts.public.completeHandoverIn);

  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [pinError, setPinError] = useState<string | undefined>();
  const [pinPending, setPinPending] = useState(false);

  // Two distinct idempotency keys — MUST NOT share a root.
  // loginWithPin and completeHandoverIn write to the same pos_idempotency cache
  // keyed by string alone; sharing one key would cause completeHandoverIn to
  // replay loginWithPin's cached {sessionId,role} blob → booth stuck in
  // handover_pending. Pattern mirrors lock.tsx (lockKey vs takeoverKey).
  const loginKey = useIdempotency("shift:handover:in:login");
  const completeKey = useIdempotency("shift:handover:in:complete");

  // Outgoing staff to exclude from picker.
  const outgoingStaffId = boothState?.staffId ?? null;

  // Filter staff list: exclude the outgoing staff.
  const eligibleStaff =
    allStaff === undefined
      ? undefined
      : allStaff.filter((s) => s._id !== outgoingStaffId);

  // -------------------------------------------------------------------------
  // PIN submit → login → storeSession → advance to count
  // -------------------------------------------------------------------------
  const onPinSubmit = async (pin: string) => {
    if (stage.kind !== "pin") return;
    if (!deviceId) { setPinError(t("shiftHandover.deviceNotReady")); return; }
    if (!loginKey) return; // IDB not yet resolved — guard ADR-013

    setPinPending(true);
    setPinError(undefined);
    try {
      const { sessionId } = await loginWithPin({
        staffId: stage.staff._id,
        pin,
        deviceId,
        idempotencyKey: loginKey,
      });
      // Store the NEW incoming session before advancing — session hook will
      // reactively propagate this to the rest of the app.
      storeSession(sessionId, stage.staff._id);
      setStage({ kind: "count", sessionId });
    } catch (err) {
      // errorMessage unwraps ConvexError.data — a raw err.message would miss the
      // INVALID_PIN / LOCKED_OUT codes thrown through loginWithPin (parity with
      // login.tsx). Falls back to the generic copy when there's no message.
      const msg = errorMessage(err) || t("shiftHandover.loginFailed");
      const friendly =
        msg.includes("INVALID_PIN") ? t("shiftHandover.wrongPin") :
        msg.includes("LOCKED_OUT") ? t("shiftHandover.accountLocked") :
        msg;
      setPinError(friendly);
    } finally {
      setPinPending(false);
    }
  };

  // -------------------------------------------------------------------------
  // Count submitted → completeHandoverIn → home
  // -------------------------------------------------------------------------
  const onCountSubmitted = async (countChanged: number) => {
    if (stage.kind !== "count") return;
    if (!completeKey) return;
    await completeHandoverIn({
      idempotencyKey: completeKey,
      sessionId: stage.sessionId,
      steps: [
        { key: "count", label: t("shiftHandover.countStepLabel"), type: "count", confirmed_at: Date.now() },
      ],
      countChanged,
    });
    navigate("/", { replace: true });
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // count stage — full-screen count step
  if (stage.kind === "count") {
    return (
      <main className="flex flex-1 flex-col p-6">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-foreground">{t("shiftHandover.countTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("shiftHandover.countSubtitle")}</p>
        </header>
        <CountStep onSubmitted={onCountSubmitted} />
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">{t("shiftHandover.pickTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("shiftHandover.pickSubtitle")}</p>
      </header>

      {/* pick stage */}
      {eligibleStaff === undefined ? (
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : eligibleStaff.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t("shiftHandover.noOtherStaff")}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {eligibleStaff.map((s) => (
            <StaffListItem
              key={s._id}
              name={s.name}
              role={s.role}
              onClick={() => {
                setPinError(undefined);
                setStage({ kind: "pin", staff: s });
              }}
            />
          ))}
        </div>
      )}

      {/* pin stage — PinSheet overlay */}
      <PinSheet
        open={stage.kind === "pin"}
        title={stage.kind === "pin" ? stage.staff.name : ""}
        label={t("shiftHandover.enterPin")}
        pending={pinPending}
        error={pinError}
        onSubmit={onPinSubmit}
        onCancel={() => {
          setPinError(undefined);
          setStage({ kind: "pick" });
        }}
      />
    </main>
  );
}

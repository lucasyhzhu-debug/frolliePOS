/**
 * /mgr/device — outlet-to-device binding panel (v2.0 Task 10).
 *
 * Manager-PIN flow: manager picks an outlet from the listOutlets roster →
 * PinSheet confirms manager PIN → staff.actions.assignDeviceOutlet binds
 * the CURRENT device to the chosen outlet.
 *
 * Mirrors mgr/device-setup.tsx structure (SpokeLayout + Card list + manager
 * guard + sonner toasts). Each PIN submission rotates the idempotency key via
 * clearIntent on success so the next assignment gets a fresh key.
 */

import { useState } from "react";
import { Navigate } from "react-router";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PinSheet } from "@/components/pos/PinSheet";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";

export default function MgrDevice() {
  const session = useSession();
  const t = useT();

  if (session.status === "loading") {
    return (
      <SpokeLayout title={t("mgrDevice.title")}>
        <main className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        </main>
      </SpokeLayout>
    );
  }
  if (session.status !== "active" || session.staff.role !== "manager") {
    return <Navigate to="/" replace />;
  }
  return <MgrDeviceInner sessionId={session.sessionId} />;
}

function MgrDeviceInner({ sessionId }: { sessionId: Id<"staff_sessions"> }) {
  const t = useT();
  const deviceId = useDeviceId();

  // List all outlets for the picker.
  const outlets = useQuery(api.outlets.public.listOutlets, { sessionId });

  // Pending outlet selection awaiting manager PIN.
  const [selectedOutletId, setSelectedOutletId] = useState<Id<"outlets"> | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinPending, setPinPending] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>(undefined);

  const assignKey = useIdempotency("mgr.assignDeviceOutlet");
  const assignDeviceOutlet = useAction(api.staff.actions.assignDeviceOutlet);

  function openPin(outletId: Id<"outlets">) {
    setSelectedOutletId(outletId);
    setPinError(undefined);
    setPinOpen(true);
  }

  async function handlePinSubmit(managerPin: string) {
    if (!selectedOutletId || !deviceId || !assignKey) return;
    setPinPending(true);
    setPinError(undefined);
    try {
      await assignDeviceOutlet({
        idempotencyKey: assignKey,
        sessionId,
        targetDeviceId: deviceId,
        targetOutletId: selectedOutletId,
        managerPin,
      });
      toast.success(t("mgrDevice.assignSuccess"));
      setPinOpen(false);
      setSelectedOutletId(null);
      await clearIntent("mgr.assignDeviceOutlet");
    } catch (err) {
      const msg = errorMessage(err);
      setPinError(msg);
    } finally {
      setPinPending(false);
    }
  }

  function handlePinCancel() {
    if (pinPending) return;
    setPinOpen(false);
    setPinError(undefined);
  }

  return (
    <SpokeLayout title={t("mgrDevice.title")} backTo="/mgr">
      <main className="flex flex-1 flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          {t("mgrDevice.description")}
        </p>

        {/* Outlet picker */}
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{t("mgrDevice.outletLabel")}</h2>
          {outlets === undefined ? (
            <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
          ) : outlets.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("mgrDevice.selectOutlet")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {outlets.map((o) => (
                <li key={o._id}>
                  <Card className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{o.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {o.code}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={!assignKey || !deviceId}
                      onClick={() => openPin(o._id)}
                    >
                      {t("mgrDevice.assignBtn")}
                    </Button>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <PinSheet
        open={pinOpen}
        title={t("mgrDevice.pinTitle")}
        label={t("mgrDevice.pinLabel")}
        pending={pinPending}
        error={pinError}
        onSubmit={handlePinSubmit}
        onCancel={handlePinCancel}
      />
    </SpokeLayout>
  );
}

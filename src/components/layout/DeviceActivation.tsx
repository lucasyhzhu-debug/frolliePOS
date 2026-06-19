import { useState } from "react";
import { useNavigate } from "react-router";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency } from "@/hooks/useIdempotency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";

// SEC-04: map the raw structured errors from activateDevice to friendly copy.
// ACTIVATION_LOCKED:<secs> surfaces after the throttle trips (per-device or global).
// Uses the shared errorMessage() so a ConvexError (payload on .data, not .message)
// is unwrapped correctly instead of falling through to the generic fallback.
function friendlyActivationError(err: unknown, t: ReturnType<typeof useT>): string {
  const msg = errorMessage(err);
  const locked = msg.match(/ACTIVATION_LOCKED:(\d+)/);
  if (locked) return t("deviceActivation.errorTooManyAttempts", { secs: locked[1] });
  if (msg.includes("INVALID_CODE")) return t("deviceActivation.errorInvalidCode");
  if (msg.includes("INVALID_LABEL")) return t("deviceActivation.errorInvalidLabel");
  if (msg.includes("already registered")) return t("deviceActivation.errorAlreadyRegistered");
  return t("deviceActivation.errorGeneric");
}

export function DeviceActivation() {
  const navigate = useNavigate();
  const deviceId = useDeviceId();
  // Use a stable fallback string while deviceId is still resolving so the
  // useIdempotency hook doesn't receive a changing key mid-render.
  const idempotencyKey = useIdempotency(`activate:${deviceId ?? "pending"}`);
  const activate = useAction(api.staff.public.activateDevice);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceId) return toast.error(t("deviceActivation.toastDeviceNotReady"));
    if (!idempotencyKey) return; // IDB not yet resolved — guard ADR-013
    if (!/^\d{6}$/.test(code)) return toast.error(t("deviceActivation.toastCodeDigits"));
    if (!label.trim()) return toast.error(t("deviceActivation.toastEnterLabel"));
    setBusy(true);
    try {
      await activate({ code, deviceLabel: label.trim(), deviceId, idempotencyKey });
      toast.success(t("deviceActivation.toastSuccess"));
      navigate("/login", { replace: true });
    } catch (err) {
      toast.error(friendlyActivationError(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("deviceActivation.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("deviceActivation.subtitle")}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="code">{t("deviceActivation.labelCode")}</Label>
              <Input
                id="code" inputMode="numeric" pattern="\d{6}" maxLength={6}
                value={code} onChange={(e) => setCode(e.target.value)}
                autoFocus className="tabular tracking-widest text-center text-lg"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="label">{t("deviceActivation.labelDeviceLabel")}</Label>
              <Input
                id="label" placeholder={t("deviceActivation.placeholderLabel")}
                value={label} onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy || !deviceId} className="w-full">
              {busy ? t("deviceActivation.activating") : t("deviceActivation.activate")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

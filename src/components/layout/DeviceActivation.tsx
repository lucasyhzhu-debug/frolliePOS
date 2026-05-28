import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency } from "@/hooks/useIdempotency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export function DeviceActivation() {
  const navigate = useNavigate();
  const deviceId = useDeviceId();
  // Use a stable fallback string while deviceId is still resolving so the
  // useIdempotency hook doesn't receive a changing key mid-render.
  const idempotencyKey = useIdempotency(`activate:${deviceId ?? "pending"}`);
  const activate = useMutation(api.staff.public.activateDevice);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceId) return toast.error("Device not ready — please wait a moment");
    if (!idempotencyKey) return; // IDB not yet resolved — guard ADR-013
    if (!/^\d{6}$/.test(code)) return toast.error("Code must be 6 digits");
    if (!label.trim()) return toast.error("Enter a device label");
    setBusy(true);
    try {
      await activate({ code, deviceLabel: label.trim(), deviceId, idempotencyKey });
      toast.success("Device activated");
      navigate("/login", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Activation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Activate device</CardTitle>
          <p className="text-sm text-muted-foreground">
            Enter the 6-digit code from a manager.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="code">Setup code</Label>
              <Input
                id="code" inputMode="numeric" pattern="\d{6}" maxLength={6}
                value={code} onChange={(e) => setCode(e.target.value)}
                autoFocus className="tabular tracking-widest text-center text-lg"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="label">Device label</Label>
              <Input
                id="label" placeholder="Booth Phone 1"
                value={label} onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy || !deviceId} className="w-full">
              {busy ? "Activating…" : "Activate"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

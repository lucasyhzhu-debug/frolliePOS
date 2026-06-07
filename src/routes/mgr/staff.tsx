/**
 * /mgr/staff — manager-gated staff administration (v0.5.3b Task 14).
 *
 * Exercises the v0.5.3b admin surface:
 *   - listStaff (query)                    — read
 *   - auth.actions.createStaff             — PIN-gated
 *   - staff.public.updateStaffName         — session-gated
 *   - staff.actions.setStaffRole           — PIN-gated
 *   - staff.actions.deactivateStaff        — PIN-gated
 *   - auth.actions.resetStaffPin           — PIN-gated
 *
 * Layout/feel mirrors /mgr/telegram-chats (SpokeLayout + Card list + manager
 * guard + sonner toasts). Each distinct mutation gets its own idempotency intent
 * and rotates via clearIntent on success.
 */

import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { PinSheet } from "@/components/pos/PinSheet";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { toast } from "sonner";

type StaffRow = {
  _id: Id<"staff">;
  name: string;
  code: string | null;
  role: "staff" | "manager";
  active: boolean;
  last_login_at: number | null;
  created_at: number;
};

type Role = "staff" | "manager";

type PinAction =
  | { kind: "createStaff"; name: string; role: Role; pin: string }
  | { kind: "setRole"; staffId: Id<"staff">; staffName: string; role: Role }
  | { kind: "deactivate"; staffId: Id<"staff">; staffName: string }
  | { kind: "resetPin"; staffId: Id<"staff">; staffName: string; newPin: string };

function humanizeAuthError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (m.includes("LAST_ACTIVE_MANAGER")) return "At least one active manager is required.";
  if (m.includes("INVALID_PIN")) return "Wrong manager PIN.";
  if (m.includes("LOCKED_OUT")) return "Too many attempts — locked out for 60s.";
  if (m.includes("SELF_DEACTIVATE")) return "You can't deactivate yourself.";
  if (m.includes("NAME_INVALID")) return "Name must be 1–60 characters.";
  if (m.includes("PIN must be exactly 4 digits")) return "PIN must be 4 digits.";
  if (m.includes("NEW_PIN_INVALID")) return "New PIN must be 4 digits.";
  if (m.includes("TARGET_NOT_FOUND")) return "Target staff not found.";
  if (m.includes("USE_CHANGE_PIN_FOR_SELF")) return "Use change-PIN for yourself.";
  if (m.includes("STAFF_NOT_FOUND")) return "Staff member not found.";
  if (m.includes("SESSION_INVALID")) return "Session expired. Lock and log in again.";
  if (m.includes("NOT_MANAGER") || m.includes("MANAGER_SESSION_REQUIRED")) return "Only managers can do that.";
  return "Something went wrong.";
}

export default function MgrStaff() {
  const navigate = useNavigate();
  const session = useSession();

  if (session.status === "loading") {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (session.status !== "active" || session.staff.role !== "manager") {
    navigate("/", { replace: true });
    return null;
  }

  return (
    <MgrStaffInner
      sessionId={session.sessionId}
      selfStaffId={session.staff._id}
    />
  );
}

function MgrStaffInner({
  sessionId,
  selfStaffId,
}: {
  sessionId: Id<"staff_sessions">;
  selfStaffId: Id<"staff">;
}) {
  const staff = useQuery(api.staff.public.listStaff, { sessionId }) as
    | StaffRow[]
    | undefined;

  // One idempotency intent per distinct mutation surface.
  const createKey = useIdempotency("staff.createStaff");
  const renameKey = useIdempotency("staff.updateName");
  const roleKey = useIdempotency("staff.setRole");
  const deactivateKey = useIdempotency("staff.deactivate");
  const resetPinKey = useIdempotency("auth.resetPin");

  const createStaff = useAction(api.auth.actions.createStaff);
  const updateName = useMutation(api.staff.public.updateStaffName);
  const setStaffRole = useAction(api.staff.actions.setStaffRole);
  const deactivateStaff = useAction(api.staff.actions.deactivateStaff);
  const resetStaffPin = useAction(api.auth.actions.resetStaffPin);

  // Pending PIN-gated action awaiting manager-PIN entry.
  const [pinAction, setPinAction] = useState<PinAction | null>(null);
  const [pinPending, setPinPending] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>(undefined);

  // Add-staff dialog state.
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addRole, setAddRole] = useState<Role>("staff");
  const [addPin, setAddPin] = useState("");

  // Inline rename state — staffId currently being edited, plus working buffer.
  const [renamingId, setRenamingId] = useState<Id<"staff"> | null>(null);
  const [renameBuf, setRenameBuf] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  // Reset-PIN keypad dialog state — collects new PIN before opening PinSheet.
  const [resetTarget, setResetTarget] = useState<StaffRow | null>(null);
  const [resetPinBuf, setResetPinBuf] = useState("");

  const activeManagerCount = (staff ?? []).filter(
    (s) => s.active && s.role === "manager",
  ).length;

  // ─── Add staff ──────────────────────────────────────────────────────────────

  function openAdd() {
    setAddName("");
    setAddRole("staff");
    setAddPin("");
    setAddOpen(true);
  }

  function submitAddOpenPin() {
    const name = addName.trim();
    if (name.length === 0 || name.length > 60) {
      toast.error("Name must be 1–60 characters.");
      return;
    }
    if (!/^\d{4}$/.test(addPin)) {
      toast.error("PIN must be 4 digits.");
      return;
    }
    setPinAction({ kind: "createStaff", name, role: addRole, pin: addPin });
    setPinError(undefined);
  }

  // ─── Rename ─────────────────────────────────────────────────────────────────

  function startRename(s: StaffRow) {
    setRenamingId(s._id);
    setRenameBuf(s.name);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameBuf("");
  }

  async function commitRename(staffId: Id<"staff">) {
    const name = renameBuf.trim();
    if (name.length === 0 || name.length > 60) {
      toast.error("Name must be 1–60 characters.");
      return;
    }
    if (!renameKey) return;
    setRenameBusy(true);
    try {
      await updateName({ idempotencyKey: renameKey, sessionId, staffId, name });
      toast.success("Saved");
      cancelRename();
      await clearIntent("staff.updateName");
    } catch (err) {
      toast.error(humanizeAuthError(err));
    } finally {
      setRenameBusy(false);
    }
  }

  // ─── Role change ────────────────────────────────────────────────────────────

  function openRoleChange(s: StaffRow) {
    const nextRole: Role = s.role === "manager" ? "staff" : "manager";
    setPinAction({
      kind: "setRole",
      staffId: s._id,
      staffName: s.name,
      role: nextRole,
    });
    setPinError(undefined);
  }

  // ─── Deactivate ─────────────────────────────────────────────────────────────

  function openDeactivate(s: StaffRow) {
    if (!window.confirm(`Deactivate ${s.name}?`)) return;
    setPinAction({ kind: "deactivate", staffId: s._id, staffName: s.name });
    setPinError(undefined);
  }

  // ─── Reset PIN ──────────────────────────────────────────────────────────────

  function openResetPin(s: StaffRow) {
    setResetTarget(s);
    setResetPinBuf("");
  }

  function handleResetPinKey(key: string) {
    if (key === "C") {
      setResetPinBuf("");
      return;
    }
    if (key === "⌫") {
      setResetPinBuf((p) => p.slice(0, -1));
      return;
    }
    if (resetPinBuf.length >= 4) return;
    const next = resetPinBuf + key;
    setResetPinBuf(next);
    if (next.length === 4 && resetTarget) {
      // Hand off to PinSheet for manager PIN.
      setPinAction({
        kind: "resetPin",
        staffId: resetTarget._id,
        staffName: resetTarget.name,
        newPin: next,
      });
      setPinError(undefined);
      setResetTarget(null);
      setResetPinBuf("");
    }
  }

  // ─── PinSheet submit funnel ─────────────────────────────────────────────────

  async function handlePinSubmit(managerPin: string) {
    if (!pinAction) return;
    setPinPending(true);
    setPinError(undefined);
    try {
      switch (pinAction.kind) {
        case "createStaff": {
          if (!createKey) throw new Error("idempotency key not ready");
          await createStaff({
            idempotencyKey: createKey,
            sessionId,
            name: pinAction.name,
            role: pinAction.role,
            pin: pinAction.pin,
            managerPin,
          });
          toast.success(`${pinAction.name} added`);
          setAddOpen(false);
          await clearIntent("staff.createStaff");
          break;
        }
        case "setRole": {
          if (!roleKey) throw new Error("idempotency key not ready");
          await setStaffRole({
            idempotencyKey: roleKey,
            sessionId,
            staffId: pinAction.staffId,
            role: pinAction.role,
            managerPin,
          });
          toast.success(
            pinAction.role === "manager"
              ? `${pinAction.staffName} is now a manager`
              : `${pinAction.staffName} is now staff`,
          );
          await clearIntent("staff.setRole");
          break;
        }
        case "deactivate": {
          if (!deactivateKey) throw new Error("idempotency key not ready");
          await deactivateStaff({
            idempotencyKey: deactivateKey,
            sessionId,
            staffId: pinAction.staffId,
            managerPin,
          });
          toast.success(`${pinAction.staffName} deactivated`);
          await clearIntent("staff.deactivate");
          break;
        }
        case "resetPin": {
          if (!resetPinKey) throw new Error("idempotency key not ready");
          await resetStaffPin({
            idempotencyKey: resetPinKey,
            sessionId,
            targetStaffId: pinAction.staffId,
            newPin: pinAction.newPin,
            managerPin,
          });
          toast.success(`PIN reset for ${pinAction.staffName}`);
          await clearIntent("auth.resetPin");
          break;
        }
      }
      setPinAction(null);
    } catch (err) {
      const msg = humanizeAuthError(err);
      setPinError(msg);
      toast.error(msg);
    } finally {
      setPinPending(false);
    }
  }

  function handlePinCancel() {
    if (pinPending) return;
    setPinAction(null);
    setPinError(undefined);
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  const pinTitle =
    pinAction?.kind === "createStaff"
      ? "Add staff"
      : pinAction?.kind === "setRole"
        ? "Change role"
        : pinAction?.kind === "deactivate"
          ? "Deactivate staff"
          : pinAction?.kind === "resetPin"
            ? "Reset PIN"
            : "Manager PIN";

  const pinLabel =
    pinAction?.kind === "createStaff"
      ? `Confirm with your manager PIN to add ${pinAction.name}.`
      : pinAction?.kind === "setRole"
        ? `Confirm with your manager PIN to make ${pinAction.staffName} a ${pinAction.role}.`
        : pinAction?.kind === "deactivate"
          ? `Confirm with your manager PIN to deactivate ${pinAction.staffName}.`
          : pinAction?.kind === "resetPin"
            ? `Confirm with your manager PIN to reset ${pinAction.staffName}'s PIN.`
            : "Enter manager PIN.";

  return (
    <SpokeLayout title="Staff" backTo="/">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">
              Add, rename, change role, deactivate, reset PIN.
            </p>
          </div>
          <Button size="sm" onClick={openAdd}>
            Add staff
          </Button>
        </div>

        {staff === undefined ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="p-4">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-3 w-20 animate-pulse rounded bg-muted" />
              </Card>
            ))}
          </div>
        ) : staff.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No staff yet — add one above
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {staff.map((s) => {
              const isSelf = s._id === selfStaffId;
              const isLastActiveManager =
                s.active && s.role === "manager" && activeManagerCount <= 1;
              const renameThis = renamingId === s._id;

              return (
                <Card
                  key={s._id}
                  className={`space-y-3 p-4 ${s.active ? "" : "opacity-60"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {renameThis ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={renameBuf}
                            onChange={(e) => setRenameBuf(e.target.value)}
                            disabled={renameBusy}
                            maxLength={60}
                            autoFocus
                            className="h-8"
                            aria-label="staff name"
                          />
                          <Button
                            size="sm"
                            onClick={() => commitRename(s._id)}
                            disabled={renameBusy || !renameKey}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={cancelRename}
                            disabled={renameBusy}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => s.active && startRename(s)}
                          disabled={!s.active}
                          className="block max-w-full truncate text-left text-sm font-medium leading-tight hover:underline disabled:cursor-not-allowed disabled:no-underline"
                          title={s.active ? "Click to rename" : undefined}
                        >
                          {s.name}
                        </button>
                      )}
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {s.code ?? "—"}
                        {isSelf && " · you"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge
                        variant={s.role === "manager" ? "default" : "secondary"}
                        className="text-[10px]"
                      >
                        {s.role}
                      </Badge>
                      {!s.active && (
                        <Badge variant="outline" className="text-[10px]">
                          Inactive
                        </Badge>
                      )}
                    </div>
                  </div>

                  {s.active && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => openRoleChange(s)}
                        disabled={
                          // demote-the-last-active-manager guard
                          s.role === "manager" && isLastActiveManager
                        }
                        title={
                          s.role === "manager" && isLastActiveManager
                            ? "At least one active manager is required."
                            : undefined
                        }
                      >
                        {s.role === "manager" ? "Make staff" : "Make manager"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => openResetPin(s)}
                      >
                        Reset PIN
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => openDeactivate(s)}
                        disabled={isSelf || isLastActiveManager}
                        title={
                          isSelf
                            ? "You can't deactivate yourself."
                            : isLastActiveManager
                              ? "At least one active manager is required."
                              : undefined
                        }
                      >
                        Deactivate
                      </Button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Add-staff dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          if (!o) setAddOpen(false);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add staff</DialogTitle>
            <DialogDescription>
              Set a name, role, and initial 4-digit PIN.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-staff-name">Name</Label>
              <Input
                id="new-staff-name"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                maxLength={60}
                placeholder="e.g. Rika"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={addRole} onValueChange={(v) => setAddRole(v as Role)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="staff">Staff</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Initial PIN</Label>
              <div className="flex justify-center gap-3 py-1">
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={`h-4 w-4 rounded-full border-2 border-foreground transition-colors ${
                      i < addPin.length ? "bg-foreground" : ""
                    }`}
                  />
                ))}
              </div>
              <NumericKeypad
                onPress={(k) => {
                  if (k === "C") {
                    setAddPin("");
                    return;
                  }
                  if (k === "⌫") {
                    setAddPin((p) => p.slice(0, -1));
                    return;
                  }
                  if (addPin.length >= 4) return;
                  setAddPin(addPin + k);
                }}
                onClear={() => setAddPin("")}
                onBackspace={() => setAddPin((p) => p.slice(0, -1))}
                size="compact"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitAddOpenPin}
              disabled={
                !createKey ||
                addName.trim().length === 0 ||
                !/^\d{4}$/.test(addPin)
              }
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset-PIN: collect NEW pin before manager PIN */}
      <Dialog
        open={resetTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setResetTarget(null);
            setResetPinBuf("");
          }
        }}
      >
        <DialogContent className="max-w-xs px-4 pb-4">
          <DialogHeader>
            <DialogTitle>Reset PIN</DialogTitle>
            <DialogDescription>
              Enter a new 4-digit PIN for {resetTarget?.name ?? ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center gap-3 py-1">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={`h-4 w-4 rounded-full border-2 border-foreground transition-colors ${
                  i < resetPinBuf.length ? "bg-foreground" : ""
                }`}
              />
            ))}
          </div>
          <NumericKeypad
            onPress={handleResetPinKey}
            onClear={() => setResetPinBuf("")}
            onBackspace={() => setResetPinBuf((p) => p.slice(0, -1))}
            size="compact"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setResetTarget(null);
                setResetPinBuf("");
              }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PinSheet
        open={pinAction !== null}
        title={pinTitle}
        label={pinLabel}
        pending={pinPending}
        error={pinError}
        onSubmit={handlePinSubmit}
        onCancel={handlePinCancel}
      />
    </SpokeLayout>
  );
}

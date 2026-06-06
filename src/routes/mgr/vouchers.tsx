/**
 * /mgr/vouchers — manager-gated voucher administration (v0.6 Task V9).
 *
 * Exercises the v0.6 Wave-1 voucher admin surface:
 *   - vouchers.public.listAllVouchers        — read (active + archived)
 *   - vouchers.public.getVoucherRedemptions  — per-voucher history (lazy)
 *   - vouchers.actions.createVoucher         — PIN-gated
 *   - vouchers.public.updateVoucherMeta      — session-gated (active/expiry/min/max)
 *   - vouchers.public.archiveVoucher         — session-gated (soft-delete)
 *
 * Layout/feel mirrors /mgr/products (v0.5.3b): outer redirect + inner data hooks,
 * SpokeLayout shell, shadcn primitives, PinSheet for PIN-gated create, one
 * idempotency intent per mutation surface (rotated via clearIntent on success).
 *
 * Money-affecting fields (code/type/value) are birth-immutable per ADR-010 — to
 * "change" them, archive and recreate.
 */

import { useMemo, useState } from "react";
import { Navigate } from "react-router";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id, Doc } from "../../../convex/_generated/dataModel";
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
import { rp, fmtDate } from "@/lib/format";
import { toast } from "sonner";

type Voucher = Doc<"pos_vouchers">;
type VoucherType = "percentage" | "amount";

type PinAction = {
  kind: "createVoucher";
  code: string;
  type: VoucherType;
  value: number;
  min_cart_value?: number;
  max_redemptions?: number;
  expires_at?: number;
};

function humanizeVoucherError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (m.includes("CODE_EXISTS")) return "A voucher with that code already exists.";
  if (m.includes("CODE_INVALID"))
    return "Code must be A–Z, 0–9, underscore or dash (3–32 chars).";
  if (m.includes("VALUE_INVALID")) return "Value invalid for the chosen type.";
  if (m.includes("EXPIRES_IN_PAST")) return "Expiry must be in the future.";
  if (m.includes("MAX_BELOW_USED"))
    return "Cap cannot be below already-used count.";
  if (m.includes("MIN_INVALID")) return "Minimum cart value is invalid.";
  if (m.includes("MAX_INVALID")) return "Max redemptions is invalid.";
  if (m.includes("VOUCHER_NOT_FOUND")) return "Voucher not found.";
  if (m.includes("INVALID_PIN")) return "Wrong manager PIN.";
  if (m.includes("LOCKED_OUT")) return "Too many attempts — locked out for 60s.";
  if (m.includes("SESSION_INVALID"))
    return "Session expired. Lock and log in again.";
  if (m.includes("NOT_MANAGER") || m.includes("MANAGER_ONLY"))
    return "Manager access required.";
  return "Something went wrong. Try again.";
}

function parseIntStrict(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Convert a date input value (YYYY-MM-DD, local-naive) to an end-of-day WIB
 * epoch ms. So `2026-12-31` → 2026-12-31T23:59:59+07:00 → epoch ms. Matches the
 * staff mental model that "expires on Dec 31" means "still valid through end
 * of Dec 31 in Jakarta".
 */
function endOfDayWibToEpochMs(dateStr: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const ms = new Date(`${dateStr}T23:59:59+07:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export default function MgrVouchers() {
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

  return <MgrVouchersInner sessionId={session.sessionId} />;
}

function MgrVouchersInner({ sessionId }: { sessionId: Id<"staff_sessions"> }) {
  const vouchers = useQuery(api.vouchers.public.listAllVouchers, { sessionId }) as
    | Voucher[]
    | undefined;

  // One idempotency intent per distinct mutation surface.
  const createKey = useIdempotency("vouchers.createVoucher");
  const metaKey = useIdempotency("vouchers.updateMeta");
  const archiveKey = useIdempotency("vouchers.archive");

  const createVoucher = useAction(api.vouchers.actions.createVoucher);
  const updateVoucherMeta = useMutation(api.vouchers.public.updateVoucherMeta);
  const archiveVoucher = useMutation(api.vouchers.public.archiveVoucher);

  // ─── Sorted view: active first, then by code ────────────────────────────────
  const sortedVouchers = useMemo(() => {
    if (!vouchers) return undefined;
    return [...vouchers].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.code.localeCompare(b.code);
    });
  }, [vouchers]);

  // ─── PIN-gated state (create only) ──────────────────────────────────────────
  const [pinAction, setPinAction] = useState<PinAction | null>(null);
  const [pinPending, setPinPending] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>(undefined);

  // ─── Add voucher dialog ─────────────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [addCode, setAddCode] = useState("");
  const [addType, setAddType] = useState<VoucherType>("percentage");
  const [addValue, setAddValue] = useState("");
  const [addMinCart, setAddMinCart] = useState("");
  const [addMaxRedemptions, setAddMaxRedemptions] = useState("");
  const [addExpires, setAddExpires] = useState(""); // YYYY-MM-DD

  function openAdd() {
    setAddCode("");
    setAddType("percentage");
    setAddValue("");
    setAddMinCart("");
    setAddMaxRedemptions("");
    setAddExpires("");
    setAddOpen(true);
  }

  function submitAddOpenPin() {
    const code = addCode.trim().toUpperCase();
    if (code.length < 3 || code.length > 32 || !/^[A-Z0-9_-]+$/.test(code)) {
      toast.error(
        "Code must be A–Z, 0–9, underscore or dash (3–32 chars).",
      );
      return;
    }
    const value = parseIntStrict(addValue);
    if (value === null || value <= 0) {
      toast.error("Value must be a positive integer.");
      return;
    }
    if (addType === "percentage" && value > 100) {
      toast.error("Percentage must be between 1 and 100.");
      return;
    }
    let min_cart_value: number | undefined = undefined;
    if (addMinCart.trim().length > 0) {
      const m = parseIntStrict(addMinCart);
      if (m === null) {
        toast.error("Minimum cart value must be a non-negative integer.");
        return;
      }
      min_cart_value = m;
    }
    let max_redemptions: number | undefined = undefined;
    if (addMaxRedemptions.trim().length > 0) {
      const r = parseIntStrict(addMaxRedemptions);
      if (r === null || r < 1) {
        toast.error("Max redemptions must be a positive integer.");
        return;
      }
      max_redemptions = r;
    }
    let expires_at: number | undefined = undefined;
    if (addExpires.trim().length > 0) {
      const ms = endOfDayWibToEpochMs(addExpires.trim());
      if (ms === null) {
        toast.error("Invalid expiry date.");
        return;
      }
      if (ms <= Date.now()) {
        toast.error("Expiry must be in the future.");
        return;
      }
      expires_at = ms;
    }

    setPinAction({
      kind: "createVoucher",
      code,
      type: addType,
      value,
      min_cart_value,
      max_redemptions,
      expires_at,
    });
    setPinError(undefined);
  }

  // ─── Edit meta dialog (no PIN) ──────────────────────────────────────────────
  const [metaTarget, setMetaTarget] = useState<Voucher | null>(null);
  const [metaActive, setMetaActive] = useState<boolean>(true);
  const [metaMinCart, setMetaMinCart] = useState("");
  const [metaMaxRedemptions, setMetaMaxRedemptions] = useState("");
  const [metaExpires, setMetaExpires] = useState("");
  const [metaBusy, setMetaBusy] = useState(false);

  function openMetaEdit(v: Voucher) {
    setMetaTarget(v);
    setMetaActive(v.active);
    setMetaMinCart(v.min_cart_value !== undefined ? String(v.min_cart_value) : "");
    setMetaMaxRedemptions(
      v.max_redemptions !== undefined ? String(v.max_redemptions) : "",
    );
    // pre-fill expiry as YYYY-MM-DD in WIB if set
    if (v.expires_at !== undefined) {
      const d = new Date(v.expires_at);
      // ISO date components in WIB
      const wibIso = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
      setMetaExpires(wibIso);
    } else {
      setMetaExpires("");
    }
  }

  function closeMetaEdit() {
    setMetaTarget(null);
  }

  async function commitMetaEdit() {
    if (!metaTarget || !metaKey) return;
    const patch: {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      voucherId: Id<"pos_vouchers">;
      active?: boolean;
      min_cart_value?: number;
      max_redemptions?: number;
      expires_at?: number;
    } = {
      idempotencyKey: metaKey,
      sessionId,
      voucherId: metaTarget._id,
    };

    if (metaActive !== metaTarget.active) {
      patch.active = metaActive;
    }

    const minTrim = metaMinCart.trim();
    if (minTrim.length > 0) {
      const m = parseIntStrict(minTrim);
      if (m === null) {
        toast.error("Minimum cart value must be a non-negative integer.");
        return;
      }
      if (m !== metaTarget.min_cart_value) patch.min_cart_value = m;
    }

    const maxTrim = metaMaxRedemptions.trim();
    if (maxTrim.length > 0) {
      const r = parseIntStrict(maxTrim);
      if (r === null || r < 1) {
        toast.error("Max redemptions must be a positive integer.");
        return;
      }
      if (r < metaTarget.used_count) {
        toast.error("Cap cannot be below already-used count.");
        return;
      }
      if (r !== metaTarget.max_redemptions) patch.max_redemptions = r;
    }

    const expTrim = metaExpires.trim();
    if (expTrim.length > 0) {
      const ms = endOfDayWibToEpochMs(expTrim);
      if (ms === null) {
        toast.error("Invalid expiry date.");
        return;
      }
      if (ms <= Date.now()) {
        toast.error("Expiry must be in the future.");
        return;
      }
      if (ms !== metaTarget.expires_at) patch.expires_at = ms;
    }

    setMetaBusy(true);
    try {
      await updateVoucherMeta(patch);
      toast.success("Saved");
      await clearIntent("vouchers.updateMeta");
      closeMetaEdit();
    } catch (err) {
      toast.error(humanizeVoucherError(err));
    } finally {
      setMetaBusy(false);
    }
  }

  // ─── Archive (session, soft-delete) ─────────────────────────────────────────
  async function archiveOne(v: Voucher) {
    if (!archiveKey) return;
    if (
      !window.confirm(
        `Archive ${v.code}? Existing redemptions are preserved; the voucher just stops being usable.`,
      )
    ) {
      return;
    }
    try {
      await archiveVoucher({
        idempotencyKey: archiveKey,
        sessionId,
        voucherId: v._id,
      });
      toast.success(`${v.code} archived`);
      await clearIntent("vouchers.archive");
    } catch (err) {
      toast.error(humanizeVoucherError(err));
    }
  }

  // ─── Redemption history (lazy, per voucher) ─────────────────────────────────
  const [historyVoucherId, setHistoryVoucherId] =
    useState<Id<"pos_vouchers"> | null>(null);
  const redemptions = useQuery(
    api.vouchers.public.getVoucherRedemptions,
    historyVoucherId ? { sessionId, voucherId: historyVoucherId } : "skip",
  );

  function toggleHistory(v: Voucher) {
    setHistoryVoucherId((cur) => (cur === v._id ? null : v._id));
  }

  // ─── PinSheet submit funnel ─────────────────────────────────────────────────
  async function handlePinSubmit(managerPin: string) {
    if (!pinAction) return;
    setPinPending(true);
    setPinError(undefined);
    try {
      if (pinAction.kind === "createVoucher") {
        if (!createKey) throw new Error("idempotency key not ready");
        await createVoucher({
          idempotencyKey: createKey,
          sessionId,
          code: pinAction.code,
          type: pinAction.type,
          value: pinAction.value,
          min_cart_value: pinAction.min_cart_value,
          max_redemptions: pinAction.max_redemptions,
          expires_at: pinAction.expires_at,
          managerPin,
        });
        toast.success(`${pinAction.code} created`);
        setAddOpen(false);
        await clearIntent("vouchers.createVoucher");
      }
      setPinAction(null);
    } catch (err) {
      const msg = humanizeVoucherError(err);
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
    pinAction?.kind === "createVoucher" ? "Add voucher" : "Manager PIN";

  const pinLabel =
    pinAction?.kind === "createVoucher"
      ? `Confirm with your manager PIN to create ${pinAction.code}.`
      : "Enter manager PIN.";

  return (
    <SpokeLayout title="Vouchers" backTo="/">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">
              Create, edit, archive, view redemptions.
            </p>
          </div>
          <Button size="sm" onClick={openAdd}>
            Add voucher
          </Button>
        </div>

        {sortedVouchers === undefined ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="p-4">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-3 w-20 animate-pulse rounded bg-muted" />
              </Card>
            ))}
          </div>
        ) : sortedVouchers.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No vouchers yet — add one above
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedVouchers.map((v) => {
              const expired =
                v.expires_at !== undefined && v.expires_at <= Date.now();
              const valueLabel =
                v.type === "percentage" ? `${v.value}%` : rp(v.value);
              const showHistory = historyVoucherId === v._id;
              return (
                <Card
                  key={v._id}
                  className={`space-y-3 p-4 ${v.active ? "" : "opacity-60"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm font-semibold leading-tight">
                        {v.code}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {v.type === "percentage" ? "Percentage" : "Amount"} ·{" "}
                        <span className="font-mono">{valueLabel}</span>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Used {v.used_count}
                        {v.max_redemptions !== undefined
                          ? ` / ${v.max_redemptions}`
                          : ""}
                        {v.min_cart_value !== undefined
                          ? ` · min ${rp(v.min_cart_value)}`
                          : ""}
                        {v.expires_at !== undefined
                          ? ` · expires ${fmtDate(v.expires_at)}`
                          : " · no expiry"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!v.active && (
                        <Badge variant="outline" className="text-[10px]">
                          Archived
                        </Badge>
                      )}
                      {v.active && expired && (
                        <Badge variant="outline" className="text-[10px]">
                          Expired
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {v.active && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs"
                          onClick={() => openMetaEdit(v)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs"
                          onClick={() => archiveOne(v)}
                          disabled={!archiveKey}
                        >
                          Archive
                        </Button>
                      </>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => toggleHistory(v)}
                    >
                      {showHistory ? "Hide history" : "Redemptions"}
                    </Button>
                  </div>

                  {showHistory && (
                    <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                      <p className="mb-1 font-medium text-muted-foreground">
                        Redemption history
                      </p>
                      {redemptions === undefined ? (
                        <p className="text-muted-foreground">Loading…</p>
                      ) : redemptions.length === 0 ? (
                        <p className="text-muted-foreground">
                          No redemptions yet.
                        </p>
                      ) : (
                        <ul className="space-y-0.5">
                          {redemptions.map((r) => (
                            <li
                              key={r._id}
                              className="flex items-baseline justify-between gap-2 font-mono"
                            >
                              <span className="truncate">
                                {r.receipt_number ?? "—"}
                              </span>
                              <span className="shrink-0">
                                −{rp(r.discount_amount)}
                              </span>
                              <span className="shrink-0 text-muted-foreground">
                                {fmtDate(r.redeemed_at)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Add voucher dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          if (!o) setAddOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add voucher</DialogTitle>
            <DialogDescription>
              Code, type, and value are locked once created. Manager PIN
              required after Continue.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="new-voucher-code">Code</Label>
              <Input
                id="new-voucher-code"
                value={addCode}
                onChange={(e) => setAddCode(e.target.value.toUpperCase())}
                maxLength={32}
                placeholder="e.g. WELCOME10"
                inputMode="text"
                autoCapitalize="characters"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-voucher-type">Type</Label>
              <Select
                value={addType}
                onValueChange={(val) => setAddType(val as VoucherType)}
              >
                <SelectTrigger id="new-voucher-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage</SelectItem>
                  <SelectItem value="amount">Amount (Rp)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-voucher-value">
                {addType === "percentage" ? "Value (%)" : "Value (Rp)"}
              </Label>
              <Input
                id="new-voucher-value"
                value={addValue}
                onChange={(e) =>
                  setAddValue(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                placeholder={addType === "percentage" ? "1-100" : "e.g. 5000"}
              />
              {addType === "amount" && parseIntStrict(addValue) !== null && (
                <p className="text-xs text-muted-foreground">
                  {rp(parseIntStrict(addValue) as number)}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-voucher-min">Min cart (Rp, opt)</Label>
              <Input
                id="new-voucher-min"
                value={addMinCart}
                onChange={(e) =>
                  setAddMinCart(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                placeholder="e.g. 50000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-voucher-max">Max redemptions (opt)</Label>
              <Input
                id="new-voucher-max"
                value={addMaxRedemptions}
                onChange={(e) =>
                  setAddMaxRedemptions(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                placeholder="e.g. 100"
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="new-voucher-expires">Expires (opt)</Label>
              <Input
                id="new-voucher-expires"
                type="date"
                value={addExpires}
                onChange={(e) => setAddExpires(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">
                Treated as end-of-day WIB.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitAddOpenPin}
              disabled={!createKey || addCode.trim().length < 3}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit metadata dialog (no PIN) */}
      <Dialog
        open={metaTarget !== null}
        onOpenChange={(o) => {
          if (!o) closeMetaEdit();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit voucher</DialogTitle>
            <DialogDescription>
              {metaTarget?.code ?? ""} — code, type, and value are locked.
              Archive and recreate to change them.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label>Status</Label>
              <Select
                value={metaActive ? "active" : "inactive"}
                onValueChange={(val) => setMetaActive(val === "active")}
                disabled={metaBusy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-min">Min cart (Rp)</Label>
              <Input
                id="edit-min"
                value={metaMinCart}
                onChange={(e) =>
                  setMetaMinCart(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                disabled={metaBusy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-max">Max redemptions</Label>
              <Input
                id="edit-max"
                value={metaMaxRedemptions}
                onChange={(e) =>
                  setMetaMaxRedemptions(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                disabled={metaBusy}
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="edit-expires">Expires</Label>
              <Input
                id="edit-expires"
                type="date"
                value={metaExpires}
                onChange={(e) => setMetaExpires(e.target.value)}
                disabled={metaBusy}
              />
              <p className="text-[10px] text-muted-foreground">
                Treated as end-of-day WIB. Leave blank to keep the existing
                value (clearing the field does not unset expiry).
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={closeMetaEdit}
              disabled={metaBusy}
            >
              Cancel
            </Button>
            <Button onClick={commitMetaEdit} disabled={metaBusy || !metaKey}>
              Save
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

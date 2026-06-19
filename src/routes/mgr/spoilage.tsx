/**
 * /mgr/spoilage — manager-gated spoilage entry (v0.6 Task S6).
 *
 * Form-based entry with multi-row SKU+qty picker, reason textarea, and two CTAs:
 *   - "Log spoilage now"      → PIN-gated; calls inventory.actions.recordSpoilage (S4)
 *   - "Request via Telegram"  → manager-session; calls approvals.actions.requestSpoilageApproval (S5)
 *
 * Mirrors /mgr/vouchers (V9) shape: outer redirect + inner data hooks, SpokeLayout
 * shell, shadcn primitives, PinSheet for the PIN-gated path. One idempotency
 * intent per mutation surface, rotated via clearIntent on success.
 *
 * SKU list is pulled from the IDB-cached catalog snapshot (`useCatalogCache`),
 * matching the voucher offline-fallback pattern.
 */

import { useState } from "react";
import { Navigate } from "react-router";
import { useQuery, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id, Doc } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useT } from "@/lib/i18n";
import { useCatalogCache } from "@/hooks/useCatalogCache";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { PinSheet } from "@/components/pos/PinSheet";
import { toast } from "sonner";

type SkuRow = Doc<"pos_inventory_skus">;
type CatalogSnapshot = { skus: SkuRow[] } & Record<string, unknown>;

interface LineDraft {
  skuId: Id<"pos_inventory_skus"> | "";
  qty: string;
}

const REASON_MAX = 200;

function humanizeSpoilageError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (m.includes("LINES_EMPTY")) return "Add at least one line with a SKU and quantity.";
  if (m.includes("REASON_INVALID")) return "Reason cannot be blank.";
  if (m.includes("QTY_INVALID")) return "Quantity must be a positive whole number.";
  if (m.includes("INVALID_PIN")) return "Wrong manager PIN.";
  if (m.includes("LOCKED_OUT")) return "Too many attempts — locked out for 60s.";
  if (m.includes("NOT_MANAGER") || m.includes("MANAGER_ONLY") || m.includes("MANAGER_SESSION_REQUIRED"))
    return "Manager access required.";
  if (m.includes("NO_SESSION") || m.includes("SESSION_INVALID"))
    return "Session expired. Lock and log in again.";
  if (m.includes("POS_BASE_URL"))
    return "Server config missing — contact admin.";
  if (m.includes("SKU_NOT_FOUND")) return "One of the SKUs no longer exists.";
  if (m.includes("DUPLICATE_SKU"))
    return "The same SKU appears more than once — merge the lines.";
  return "Something went wrong. Try again.";
}

export default function MgrSpoilage() {
  const session = useSession();
  const t = useT();

  if (session.status === "loading") {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </main>
    );
  }

  if (session.status !== "active" || session.staff.role !== "manager") {
    return <Navigate to="/" replace />;
  }

  return <MgrSpoilageInner sessionId={session.sessionId} />;
}

function MgrSpoilageInner({ sessionId }: { sessionId: Id<"staff_sessions"> }) {
  const liveCatalog = useQuery(api.catalog.public.catalog, {});
  const { snapshot } = useCatalogCache<CatalogSnapshot>(
    liveCatalog as CatalogSnapshot | undefined,
  );
  const activeSkus = (snapshot?.skus ?? []).filter((s) => s.active);

  const recordSpoilage = useAction(api.inventory.actions.recordSpoilage);
  const requestApproval = useAction(
    api.approvals.actions.requestSpoilageApproval,
  );

  // One idempotency intent per mutation surface.
  const logKey = useIdempotency("spoilage.log");
  const reqKey = useIdempotency("spoilage.request");

  const [lines, setLines] = useState<LineDraft[]>([{ skuId: "", qty: "" }]);
  const [reason, setReason] = useState("");

  const [pinOpen, setPinOpen] = useState(false);
  const [pinPending, setPinPending] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>(undefined);

  const [requestPending, setRequestPending] = useState(false);

  // Build the validated payload locally. Server is source of truth — these
  // local checks just stop us shipping payloads we know will be rejected.
  const validatedLines = lines
    .map((l) => {
      if (!l.skuId) return null;
      const qtyNum = Number(l.qty);
      if (!Number.isInteger(qtyNum) || qtyNum <= 0) return null;
      const sku = activeSkus.find((s) => s._id === l.skuId);
      if (!sku) return null;
      return {
        inventory_sku_id: l.skuId as Id<"pos_inventory_skus">,
        sku_code: sku.sku,
        qty: qtyNum,
      };
    })
    .filter((l): l is { inventory_sku_id: Id<"pos_inventory_skus">; sku_code: string; qty: number } => l !== null);

  const totalQty = validatedLines.reduce((s, l) => s + l.qty, 0);
  const reasonTrim = reason.trim();
  const canSubmit =
    validatedLines.length > 0 && reasonTrim.length > 0 && !requestPending;

  function addRow() {
    setLines((prev) => [...prev, { skuId: "", qty: "" }]);
  }

  function removeRow(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  function setRow(i: number, patch: Partial<LineDraft>) {
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    );
  }

  function resetForm() {
    setLines([{ skuId: "", qty: "" }]);
    setReason("");
  }

  function openPin() {
    if (!canSubmit) return;
    setPinError(undefined);
    setPinOpen(true);
  }

  function closePin() {
    if (pinPending) return;
    setPinOpen(false);
    setPinError(undefined);
  }

  async function handlePinSubmit(managerPin: string) {
    if (!canSubmit) return;
    if (!logKey) {
      setPinError("idempotency key not ready");
      return;
    }
    setPinPending(true);
    setPinError(undefined);
    try {
      await recordSpoilage({
        idempotencyKey: logKey,
        sessionId,
        lines: validatedLines.map((l) => ({
          inventory_sku_id: l.inventory_sku_id,
          qty: l.qty,
        })),
        reason: reasonTrim,
        managerPin,
      });
      toast.success(t("mgrSpoilage.loggedSuccess", { count: totalQty }));
      await clearIntent("spoilage.log");
      setPinOpen(false);
      resetForm();
    } catch (err) {
      // Server error shows inside the PinSheet (no separate toast — noisy).
      setPinError(humanizeSpoilageError(err));
    } finally {
      setPinPending(false);
    }
  }

  async function handleRequest() {
    if (!canSubmit) return;
    if (!reqKey) {
      toast.error("idempotency key not ready");
      return;
    }
    setRequestPending(true);
    try {
      await requestApproval({
        idempotencyKey: reqKey,
        sessionId,
        lines: validatedLines.map((l) => ({
          inventory_sku_id: l.inventory_sku_id,
          sku_code: l.sku_code,
          qty: l.qty,
        })),
        reason: reasonTrim,
      });
      toast.success(t("mgrSpoilage.requestSent"));
      await clearIntent("spoilage.request");
      resetForm();
    } catch (err) {
      toast.error(humanizeSpoilageError(err));
    } finally {
      setRequestPending(false);
    }
  }

  const t = useT();

  return (
    <SpokeLayout title={t("mgrSpoilage.title")} backTo="/mgr">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          {t("mgrSpoilage.description")}
        </p>

        <Card className="space-y-3 p-4">
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label className="text-xs">{t("mgrSpoilage.labelSku")}</Label>
                  <Select
                    value={line.skuId === "" ? undefined : (line.skuId as string)}
                    onValueChange={(v) =>
                      setRow(i, { skuId: v as Id<"pos_inventory_skus"> })
                    }
                    disabled={pinPending || requestPending}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("mgrSpoilage.pickSku")} />
                    </SelectTrigger>
                    <SelectContent>
                      {activeSkus.length === 0 ? (
                        <SelectItem value="__none__" disabled>
                          {t("mgrSpoilage.noActiveSkus")}
                        </SelectItem>
                      ) : (
                        activeSkus.map((s) => (
                          <SelectItem key={s._id} value={s._id}>
                            {s.sku} — {s.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-24 space-y-1.5">
                  <Label className="text-xs" htmlFor={`spoilage-qty-${i}`}>{t("mgrSpoilage.labelQty")}</Label>
                  <Input
                    id={`spoilage-qty-${i}`}
                    inputMode="numeric"
                    value={line.qty}
                    onChange={(e) =>
                      setRow(i, {
                        qty: e.target.value.replace(/[^\d]/g, ""),
                      })
                    }
                    disabled={pinPending || requestPending}
                    placeholder="0"
                  />
                </div>
                {lines.length > 1 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => removeRow(i)}
                    disabled={pinPending || requestPending}
                    aria-label={t("mgrSpoilage.removeLine", { n: i + 1 })}
                  >
                    ✕
                  </Button>
                )}
              </div>
            ))}
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addRow}
            disabled={pinPending || requestPending}
          >
            {t("mgrSpoilage.addLine")}
          </Button>

          <div className="space-y-1.5">
            <Label htmlFor="spoilage-reason">{t("mgrSpoilage.labelReason")}</Label>
            <textarea
              id="spoilage-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={REASON_MAX}
              rows={3}
              disabled={pinPending || requestPending}
              placeholder={t("mgrSpoilage.reasonPlaceholder")}
              className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
            <p className="text-[10px] text-muted-foreground">
              {reason.length} / {REASON_MAX}
            </p>
          </div>

          {validatedLines.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t(validatedLines.length === 1 ? "mgrSpoilage.linesSummary_one" : "mgrSpoilage.linesSummary_other", { count: validatedLines.length, total: totalQty })}
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              onClick={openPin}
              disabled={!canSubmit || !logKey}
            >
              {t("mgrSpoilage.logNow")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleRequest}
              disabled={!canSubmit || !reqKey}
            >
              {requestPending ? t("mgrSpoilage.sending") : t("mgrSpoilage.requestViaTelegram")}
            </Button>
          </div>
        </Card>
      </div>

      <PinSheet
        open={pinOpen}
        title={t("mgrSpoilage.pinTitle")}
        label={t("mgrSpoilage.pinLabel", { count: totalQty })}
        pending={pinPending}
        error={pinError}
        onSubmit={handlePinSubmit}
        onCancel={closePin}
      />
    </SpokeLayout>
  );
}

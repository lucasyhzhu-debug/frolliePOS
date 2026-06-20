import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id, Doc } from "../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { PinSheet } from "@/components/pos/PinSheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldMessage } from "@/components/ui/field-message";
import { useFieldErrors } from "@/hooks/useFieldErrors";
import { rp, parseIntStrict } from "@/lib/format";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

const ENTRY_FOCUS: Record<string, string> = {
  "entry.date": "s-date",
  "entry.gross": "s-gross",
  "entry.mdr": "s-mdr",
  "entry.count": "s-count",
  "entry.last4": "s-last4",
};

type PinAction = {
  kind: "enterSettlement";
  settlementDate: string;
  grossAmount: number;
  mdrAmount: number;
  transactionCount: number;
  bcaAccountLast4: string;
};

function humanizeSettlementError(e: unknown, t: ReturnType<typeof useT>): string {
  const m = String((e as Error)?.message ?? e);
  if (m.includes("NET_INVALID")) return t("settlements.errorNetInvalid");
  if (m.includes("DATE_INVALID")) return t("settlements.errorDateInvalid");
  if (m.includes("LAST4_INVALID")) return t("settlements.errorLast4Invalid");
  if (m.includes("AMOUNT_INVALID")) return t("settlements.errorAmountInvalid");
  if (m.includes("INVALID_PIN")) return t("settlements.errorInvalidPin");
  if (m.includes("LOCKED_OUT")) return t("settlements.errorLockedOut");
  if (m.includes("SESSION_INVALID")) return t("settlements.errorSessionInvalid");
  if (m.includes("NOT_MANAGER") || m.includes("MANAGER_SESSION_REQUIRED"))
    return t("settlements.errorNotManager");
  return t("settlements.errorGeneric");
}


export default function Settlements() {
  const session = useSession();
  const t = useT();
  if (session.status === "loading") {
    return (
      <SpokeLayout title={t("settlements.title")} backTo="/">
        <main className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        </main>
      </SpokeLayout>
    );
  }
  if (session.status !== "active") return null; // RootLayout handles redirect
  return (
    <SettlementsInner
      sessionId={session.sessionId}
      isManager={session.staff.role === "manager"}
    />
  );
}

function SettlementsInner({
  sessionId,
  isManager,
}: {
  sessionId: Id<"staff_sessions">;
  isManager: boolean;
}) {
  const t = useT();
  const rows = useQuery(api.settlements.public.listSettlements, { sessionId }) as
    | Doc<"pos_settlements">[]
    | undefined;
  const enterSettlement = useAction(api.settlements.actions.enterSettlementManually);
  const entryKey = useIdempotency("settlements.enterManual");

  const [formOpen, setFormOpen] = useState(false);
  const [fDate, setFDate] = useState("");
  const [fGross, setFGross] = useState("");
  const [fMdr, setFMdr] = useState("");
  const [fCount, setFCount] = useState("");
  const [fLast4, setFLast4] = useState("");

  const [pinAction, setPinAction] = useState<PinAction | null>(null);
  const [pinPending, setPinPending] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>(undefined);

  const { errors, clearFieldError, clearErrors, applyErrors } = useFieldErrors();

  const grossN = parseIntStrict(fGross);
  const mdrN = parseIntStrict(fMdr);
  const netPreview = grossN !== null && mdrN !== null ? grossN - mdrN : null;

  function openForm() {
    setFDate("");
    setFGross("");
    setFMdr("");
    setFCount("");
    setFLast4("");
    clearErrors("entry.");
    setFormOpen(true);
  }

  function submitFormOpenPin() {
    const gross = parseIntStrict(fGross);
    const mdr = parseIntStrict(fMdr);
    const count = parseIntStrict(fCount);
    const next: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fDate)) next["entry.date"] = t("settlements.errorDateInvalid");
    if (gross === null || gross < 1) next["entry.gross"] = t("settlements.errorGrossInvalid");
    if (mdr === null) next["entry.mdr"] = t("settlements.errorMdrInvalid");
    if (count === null || count < 1) next["entry.count"] = t("settlements.errorCountInvalid");
    if (!/^\d{4}$/.test(fLast4)) next["entry.last4"] = t("settlements.errorLast4Invalid");
    if (gross !== null && mdr !== null && gross - mdr < 0) next["entry.mdr"] = t("settlements.errorNetInvalid");
    if (applyErrors("entry.", next, ENTRY_FOCUS)) return;
    // non-null: guarded above — applyErrors returned (and we'd have returned) if any were null
    setPinAction({ kind: "enterSettlement", settlementDate: fDate, grossAmount: gross!, mdrAmount: mdr!, transactionCount: count!, bcaAccountLast4: fLast4 });
    setPinError(undefined);
  }

  async function handlePinSubmit(managerPin: string) {
    if (!pinAction) return;
    if (!entryKey) {
      const msg = t("settlements.errorTryAgain");
      toast.error(msg);
      return;
    }
    setPinPending(true);
    setPinError(undefined);
    try {
      await enterSettlement({
        idempotencyKey: entryKey,
        sessionId,
        managerPin,
        settlementDate: pinAction.settlementDate,
        grossAmount: pinAction.grossAmount,
        mdrAmount: pinAction.mdrAmount,
        transactionCount: pinAction.transactionCount,
        bcaAccountLast4: pinAction.bcaAccountLast4,
      });
      toast.success(t("settlements.successRecorded"));
      await clearIntent("settlements.enterManual");
      setPinAction(null);
      setFormOpen(false);
    } catch (err) {
      const msg = humanizeSettlementError(err, t);
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

  return (
    <SpokeLayout title={t("settlements.title")} backTo="/">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          {t("settlements.description")}
        </p>

        {isManager && (
          <Button size="sm" onClick={openForm} className="self-start">
            {t("settlements.recordButton")}
          </Button>
        )}

        {rows === undefined ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="p-4">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-3 w-20 animate-pulse rounded bg-muted" />
              </Card>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">{t("settlements.empty")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <Card key={r._id} className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{r.settlement_date}</p>
                    <p className="text-xs text-muted-foreground">{t("settlements.txnCount", { count: r.transaction_count })}</p>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    {r.source === "manual" ? t("settlements.sourceManual") : t("settlements.sourceAuto")}
                  </Badge>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted-foreground">{t("settlements.labelNet")}</span>
                  <span className="font-mono text-base font-semibold">{rp(r.net_amount)}</span>
                </div>
                <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                  <span>{t("settlements.labelGross")}</span>
                  <span className="font-mono">{rp(r.gross_amount)}</span>
                </div>
                <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                  <span>{t("settlements.labelMdr")}</span>
                  <span className="font-mono">{rp(r.mdr_amount)}</span>
                </div>
                {r.bca_account_destination && (
                  <p className="text-xs text-muted-foreground">
                    {t("settlements.bcaAccount", { last4: r.bca_account_destination })}
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={formOpen} onOpenChange={(o) => { if (!o) setFormOpen(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settlements.formTitle")}</DialogTitle>
            <DialogDescription>
              {t("settlements.formDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="s-date">{t("settlements.fieldDate")}</Label>
              <Input
                id="s-date"
                type="date"
                value={fDate}
                aria-invalid={!!errors["entry.date"]}
                aria-describedby={errors["entry.date"] ? "entry.date-error" : undefined}
                onChange={(e) => { setFDate(e.target.value); clearFieldError("entry.date"); }}
              />
              {errors["entry.date"] && <FieldMessage id="entry.date-error">{errors["entry.date"]}</FieldMessage>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-gross">{t("settlements.fieldGross")}</Label>
              <Input
                id="s-gross"
                value={fGross}
                inputMode="numeric"
                aria-invalid={!!errors["entry.gross"]}
                aria-describedby={errors["entry.gross"] ? "entry.gross-error" : undefined}
                onChange={(e) => { setFGross(e.target.value.replace(/[^\d]/g, "")); clearFieldError("entry.gross"); }}
                placeholder={t("settlements.placeholderGross")}
              />
              {errors["entry.gross"] && <FieldMessage id="entry.gross-error">{errors["entry.gross"]}</FieldMessage>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-mdr">{t("settlements.fieldMdr")}</Label>
              <Input
                id="s-mdr"
                value={fMdr}
                inputMode="numeric"
                aria-invalid={!!errors["entry.mdr"]}
                aria-describedby={errors["entry.mdr"] ? "entry.mdr-error" : undefined}
                onChange={(e) => { setFMdr(e.target.value.replace(/[^\d]/g, "")); clearFieldError("entry.mdr"); }}
                placeholder={t("settlements.placeholderMdr")}
              />
              {errors["entry.mdr"] && <FieldMessage id="entry.mdr-error">{errors["entry.mdr"]}</FieldMessage>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-count">{t("settlements.fieldCount")}</Label>
              <Input
                id="s-count"
                value={fCount}
                inputMode="numeric"
                aria-invalid={!!errors["entry.count"]}
                aria-describedby={errors["entry.count"] ? "entry.count-error" : undefined}
                onChange={(e) => { setFCount(e.target.value.replace(/[^\d]/g, "")); clearFieldError("entry.count"); }}
                placeholder={t("settlements.placeholderCount")}
              />
              {errors["entry.count"] && <FieldMessage id="entry.count-error">{errors["entry.count"]}</FieldMessage>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-last4">{t("settlements.fieldLast4")}</Label>
              <Input
                id="s-last4"
                value={fLast4}
                inputMode="numeric"
                maxLength={4}
                aria-invalid={!!errors["entry.last4"]}
                aria-describedby={errors["entry.last4"] ? "entry.last4-error" : undefined}
                onChange={(e) => { setFLast4(e.target.value.replace(/[^\d]/g, "").slice(0, 4)); clearFieldError("entry.last4"); }}
                placeholder={t("settlements.placeholderLast4")}
              />
              {errors["entry.last4"] && <FieldMessage id="entry.last4-error">{errors["entry.last4"]}</FieldMessage>}
            </div>
            <div className="flex items-baseline justify-between rounded-md bg-muted/40 px-3 py-2">
              <span className="text-xs text-muted-foreground">{t("settlements.labelNetPreview")}</span>
              <span className="font-mono text-sm font-semibold">
                {netPreview === null ? "—" : netPreview < 0 ? t("settlements.netNegative") : rp(netPreview)}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitFormOpenPin} disabled={!entryKey}>
              {t("settlements.next")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PinSheet
        open={pinAction !== null}
        title={t("settlements.pinSheetTitle")}
        label={t("settlements.pinSheetLabel")}
        pending={pinPending}
        error={pinError}
        onSubmit={handlePinSubmit}
        onCancel={handlePinCancel}
      />
    </SpokeLayout>
  );
}

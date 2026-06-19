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
import { rp, parseIntStrict } from "@/lib/format";
import { toast } from "sonner";

type PinAction = {
  kind: "enterSettlement";
  settlementDate: string;
  grossAmount: number;
  mdrAmount: number;
  transactionCount: number;
  bcaAccountLast4: string;
};

function humanizeSettlementError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (m.includes("NET_INVALID")) return "Biaya melebihi bruto — net tidak boleh negatif.";
  if (m.includes("DATE_INVALID")) return "Tanggal tidak valid.";
  if (m.includes("LAST4_INVALID")) return "Masukkan 4 digit terakhir rekening BCA.";
  if (m.includes("AMOUNT_INVALID")) return "Bruto & jumlah transaksi harus angka bulat ≥ 1.";
  if (m.includes("INVALID_PIN")) return "PIN manajer salah.";
  if (m.includes("LOCKED_OUT")) return "Terlalu banyak percobaan — terkunci 60 detik.";
  if (m.includes("SESSION_INVALID")) return "Sesi berakhir. Kunci dan masuk lagi.";
  if (m.includes("NOT_MANAGER") || m.includes("MANAGER_SESSION_REQUIRED"))
    return "Hanya manajer yang bisa mencatat settlement.";
  return "Terjadi kesalahan.";
}


export default function Settlements() {
  const session = useSession();
  if (session.status === "loading") {
    return (
      <SpokeLayout title="Settlements" backTo="/">
        <main className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">Memuat…</p>
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

  const grossN = parseIntStrict(fGross);
  const mdrN = parseIntStrict(fMdr);
  const netPreview = grossN !== null && mdrN !== null ? grossN - mdrN : null;
  const formValid =
    /^\d{4}-\d{2}-\d{2}$/.test(fDate) &&
    grossN !== null &&
    grossN >= 1 &&
    mdrN !== null &&
    (parseIntStrict(fCount) ?? 0) >= 1 &&
    /^\d{4}$/.test(fLast4) &&
    netPreview !== null &&
    netPreview >= 0;

  function openForm() {
    setFDate("");
    setFGross("");
    setFMdr("");
    setFCount("");
    setFLast4("");
    setFormOpen(true);
  }

  function submitFormOpenPin() {
    const gross = parseIntStrict(fGross);
    const mdr = parseIntStrict(fMdr);
    const count = parseIntStrict(fCount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fDate)) {
      toast.error("Tanggal tidak valid.");
      return;
    }
    if (gross === null || gross < 1) {
      toast.error("Bruto harus angka bulat ≥ 1.");
      return;
    }
    if (mdr === null) {
      toast.error("Biaya harus angka bulat ≥ 0.");
      return;
    }
    if (count === null || count < 1) {
      toast.error("Jumlah transaksi harus ≥ 1.");
      return;
    }
    if (!/^\d{4}$/.test(fLast4)) {
      toast.error("Masukkan 4 digit terakhir rekening BCA.");
      return;
    }
    if (gross - mdr < 0) {
      toast.error("Biaya melebihi bruto — net tidak boleh negatif.");
      return;
    }
    setPinAction({
      kind: "enterSettlement",
      settlementDate: fDate,
      grossAmount: gross,
      mdrAmount: mdr,
      transactionCount: count,
      bcaAccountLast4: fLast4,
    });
    setPinError(undefined);
  }

  async function handlePinSubmit(managerPin: string) {
    if (!pinAction) return;
    if (!entryKey) {
      toast.error("Coba lagi sebentar.");
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
      toast.success("Settlement dicatat");
      await clearIntent("settlements.enterManual");
      setPinAction(null);
      setFormOpen(false);
    } catch (err) {
      const msg = humanizeSettlementError(err);
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
    <SpokeLayout title="Settlements" backTo="/">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          Ini adalah dana yang sudah dibayarkan Xendit ke rekening BCA.
        </p>

        {isManager && (
          <Button size="sm" onClick={openForm} className="self-start">
            Catat settlement
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
            <p className="text-sm text-muted-foreground">Belum ada settlement</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <Card key={r._id} className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{r.settlement_date}</p>
                    <p className="text-xs text-muted-foreground">{r.transaction_count} transaksi</p>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    {r.source === "manual" ? "Manual" : "Otomatis"}
                  </Badge>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted-foreground">Masuk ke BCA</span>
                  <span className="font-mono text-base font-semibold">{rp(r.net_amount)}</span>
                </div>
                <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                  <span>Bruto</span>
                  <span className="font-mono">{rp(r.gross_amount)}</span>
                </div>
                <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                  <span>Biaya Xendit</span>
                  <span className="font-mono">{rp(r.mdr_amount)}</span>
                </div>
                {r.bca_account_destination && (
                  <p className="text-xs text-muted-foreground">
                    Rekening ••••{r.bca_account_destination}
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
            <DialogTitle>Catat settlement</DialogTitle>
            <DialogDescription>
              Dari angka di dashboard Xendit. PIN manajer diperlukan.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="s-date">Tanggal settlement</Label>
              <Input
                id="s-date"
                type="date"
                value={fDate}
                onChange={(e) => setFDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-gross">Bruto (Rp)</Label>
              <Input
                id="s-gross"
                value={fGross}
                inputMode="numeric"
                onChange={(e) => setFGross(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="mis. 135000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-mdr">Biaya Xendit (Rp)</Label>
              <Input
                id="s-mdr"
                value={fMdr}
                inputMode="numeric"
                onChange={(e) => setFMdr(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="mis. 945"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-count">Jumlah transaksi</Label>
              <Input
                id="s-count"
                value={fCount}
                inputMode="numeric"
                onChange={(e) => setFCount(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="mis. 12"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-last4">4 digit rekening BCA</Label>
              <Input
                id="s-last4"
                value={fLast4}
                inputMode="numeric"
                maxLength={4}
                onChange={(e) => setFLast4(e.target.value.replace(/[^\d]/g, "").slice(0, 4))}
                placeholder="1234"
              />
            </div>
            <div className="flex items-baseline justify-between rounded-md bg-muted/40 px-3 py-2">
              <span className="text-xs text-muted-foreground">Masuk ke BCA (net)</span>
              <span className="font-mono text-sm font-semibold">
                {netPreview === null ? "—" : netPreview < 0 ? "negatif!" : rp(netPreview)}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              Batal
            </Button>
            <Button onClick={submitFormOpenPin} disabled={!entryKey || !formValid}>
              Lanjut
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PinSheet
        open={pinAction !== null}
        title="Catat settlement"
        label="Konfirmasi dengan PIN manajer Anda."
        pending={pinPending}
        error={pinError}
        onSubmit={handlePinSubmit}
        onCancel={handlePinCancel}
      />
    </SpokeLayout>
  );
}

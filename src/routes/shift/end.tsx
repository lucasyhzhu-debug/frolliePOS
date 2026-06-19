import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession, clearSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import ShiftWizard, { type WizardStep, type ConfirmedStep } from "@/components/pos/ShiftWizard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * /shift/end — choice screen + close/handover-out wizards.
 *
 * Local state:
 *   "choice"   → two cards: "Tutup booth" or "Serah terima"
 *   "close"    → 5-step end-of-day wizard (spec §3B)
 *   "handover" → 2-step handover-out wizard (spec §3C)
 *
 * On close completion:
 *   → endOfDaySignOff → staff summary (hours + stock, NO financials)
 *   → "Selesai" → clearSession + navigate("/login")
 *
 * On handover completion:
 *   → handoverOut → navigate("/shift/handover")
 *
 * ADR-013: two distinct idempotency intents so close and handover never
 * share a dedupe key even if the user bounces between them.
 */

// ---------------------------------------------------------------------------
// Close steps — spec §3B (5 steps, Bahasa)
// ---------------------------------------------------------------------------

const CLOSE_STEPS: WizardStep[] = [
  {
    key: "reminder",
    label: "Pengingat",
    type: "instruction",
    body: (
      <div>
        <p className="font-medium">Perhatian sebelum tutup:</p>
        <p className="mt-2">
          Semua barang harus masuk loker saat tutup. Kehilangan barang menjadi
          tanggung jawab staff penutup.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Kamu masih bisa pakai barang sampai langkah terakhir — masukkan loker
          di langkah kunci loker.
        </p>
      </div>
    ),
  },
  {
    key: "count",
    label: "Hitung stok",
    type: "count",
  },
  {
    key: "check-supplies",
    label: "Cek perlengkapan",
    type: "instruction",
    body: (
      <div>
        <p className="font-medium">Cek stok perlengkapan:</p>
        <ul className="mt-2 list-disc pl-5 space-y-1">
          <li>Stiker produk</li>
          <li>Stiker seal</li>
          <li>Paper bag</li>
          <li>Kantong bawang</li>
          <li>Cable ties</li>
        </ul>
        <p className="mt-3 text-sm text-muted-foreground">
          Kalau ada yang tersisa &lt; 3 hari → lapor ke grup WA.
        </p>
      </div>
    ),
  },
  {
    key: "tidy-devices",
    label: "Rapikan perangkat",
    type: "instruction",
    body: (
      <div>
        <p className="font-medium">Rapikan semua perangkat:</p>
        <ul className="mt-2 list-disc pl-5 space-y-1">
          <li>Gulung kabel dengan rapi</li>
          <li>Matikan WiFi + printer</li>
          <li>Semua perangkat ke rak bawah loker</li>
          <li>Tutup dengan kain</li>
        </ul>
      </div>
    ),
  },
  {
    key: "lock-lockers",
    label: "Kunci loker",
    type: "instruction",
    body: (
      <div>
        <p className="font-medium">Kunci kedua loker:</p>
        <ul className="mt-2 list-disc pl-5 space-y-1">
          <li>Masukkan semua barang ke loker</li>
          <li>Kunci loker kiri <strong>dan</strong> kanan</li>
          <li>Bawa kunci pulang</li>
        </ul>
      </div>
    ),
  },
];

// ---------------------------------------------------------------------------
// Handover-out steps — spec §3C (2 steps, Bahasa)
// ---------------------------------------------------------------------------

const HANDOVER_STEPS: WizardStep[] = [
  {
    key: "count",
    label: "Hitung stok",
    type: "count",
  },
  {
    key: "check-supplies",
    label: "Cek perlengkapan",
    type: "instruction",
    body: (
      <div>
        <p className="font-medium">Cek stok perlengkapan:</p>
        <ul className="mt-2 list-disc pl-5 space-y-1">
          <li>Stiker produk</li>
          <li>Stiker seal</li>
          <li>Paper bag</li>
          <li>Kantong bawang</li>
          <li>Cable ties</li>
        </ul>
        <p className="mt-3 text-sm text-muted-foreground">
          Kalau ada yang tersisa &lt; 3 hari → lapor ke grup WA.
        </p>
      </div>
    ),
  },
];

// ---------------------------------------------------------------------------
// Duration formatter: durationMs → "Xj Ym"
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}j ${minutes}m`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Mode = "choice" | "close" | "handover";

export default function ShiftEnd() {
  const navigate = useNavigate();
  const session = useSession();
  const endOfDaySignOff = useMutation(api.shifts.public.endOfDaySignOff);
  const handoverOut = useMutation(api.shifts.public.handoverOut);

  const sessionId = session.status === "active" ? session.sessionId : null;

  // Distinct idempotency intents so close and handover don't share a dedupe key.
  const closeKey = useIdempotency(
    sessionId ? `shift:end:close:${sessionId}` : "shift:end:close:none",
  );
  const handoverKey = useIdempotency(
    sessionId ? `shift:end:handover:${sessionId}` : "shift:end:handover:none",
  );

  const [mode, setMode] = useState<Mode>("choice");
  // Set after endOfDaySignOff resolves: durationMs returned by the mutation.
  const [signOffDurationMs, setSignOffDurationMs] = useState<number | null>(null);
  // countChanged captured from the count step (shown on summary screen).
  const [signOffCountChanged, setSignOffCountChanged] = useState<number | null>(null);

  if (session.status === "loading") return null;
  if (session.status !== "active") return null; // RootLayout redirects

  // -------------------------------------------------------------------------
  // Close wizard onComplete
  // -------------------------------------------------------------------------
  async function onCloseComplete(confirmed: ConfirmedStep[], countChanged: number | null) {
    if (!closeKey || !sessionId) return;
    const result = await endOfDaySignOff({
      idempotencyKey: closeKey,
      sessionId,
      steps: confirmed,
      ...(countChanged != null ? { countChanged } : {}),
    });
    setSignOffCountChanged(countChanged);
    setSignOffDurationMs(result.durationMs);
  }

  // -------------------------------------------------------------------------
  // Handover wizard onComplete
  // -------------------------------------------------------------------------
  async function onHandoverComplete(confirmed: ConfirmedStep[], countChanged: number | null) {
    if (!handoverKey || !sessionId) return;
    await handoverOut({
      idempotencyKey: handoverKey,
      sessionId,
      steps: confirmed,
      ...(countChanged != null ? { countChanged } : {}),
    });
    navigate("/shift/handover");
  }

  // -------------------------------------------------------------------------
  // Post-signoff: clear session + go to login (mirror lock.tsx, minus lockShift)
  // -------------------------------------------------------------------------
  function handleFinalSignOff() {
    clearSession();
    navigate("/login", { replace: true });
  }

  // -------------------------------------------------------------------------
  // Summary screen (shown after close wizard completes)
  // -------------------------------------------------------------------------
  if (mode === "close" && signOffDurationMs !== null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 gap-6">
        <Card className="w-full max-w-sm p-6 text-center">
          <h2 className="text-xl font-semibold">Shift selesai!</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Terima kasih atas kerja keras kamu hari ini.
          </p>

          <div className="mt-6 space-y-3">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Total jam kerja
              </p>
              <p className="text-3xl font-bold text-teal-500 mt-1">
                {fmtDuration(signOffDurationMs)}
              </p>
            </div>
            {signOffCountChanged != null && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Selisih stok (hitungan akhir)
                </p>
                <p className="text-lg font-semibold mt-1">
                  {signOffCountChanged > 0 ? "+" : ""}
                  {signOffCountChanged}
                </p>
              </div>
            )}
          </div>

          <p className="mt-5 text-xs text-muted-foreground">
            Ringkasan penjualan dikirim ke Founders via Telegram.
          </p>
        </Card>

        <Button className="w-full max-w-sm" onClick={handleFinalSignOff}>
          Selesai — keluar
        </Button>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Wizards
  // -------------------------------------------------------------------------
  if (mode === "close") {
    return (
      <ShiftWizard
        title="Tutup booth"
        steps={CLOSE_STEPS}
        onComplete={onCloseComplete}
        terminalLabel="Sign off — selesai hari ini"
      />
    );
  }

  if (mode === "handover") {
    return (
      <ShiftWizard
        title="Serah terima"
        steps={HANDOVER_STEPS}
        onComplete={onHandoverComplete}
        terminalLabel="Serah terima"
      />
    );
  }

  // -------------------------------------------------------------------------
  // Choice screen
  // -------------------------------------------------------------------------
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 gap-4">
      <h2 className="text-xl font-semibold">Akhiri shift</h2>
      <p className="text-sm text-muted-foreground text-center">
        Pilih jenis penutupan shift:
      </p>

      <div className="flex flex-col gap-3 w-full max-w-sm mt-2">
        <Button
          variant="outline"
          className="h-auto py-5 flex flex-col items-start text-left"
          onClick={() => setMode("close")}
        >
          <span className="font-semibold text-base">Tutup booth</span>
          <span className="text-xs text-muted-foreground mt-1">
            Akhir hari — booth ditutup setelah shift ini
          </span>
        </Button>

        <Button
          variant="outline"
          className="h-auto py-5 flex flex-col items-start text-left"
          onClick={() => setMode("handover")}
        >
          <span className="font-semibold text-base">Serah terima</span>
          <span className="text-xs text-muted-foreground mt-1">
            Ganti shift — booth tetap buka untuk staff berikutnya
          </span>
        </Button>
      </div>
    </div>
  );
}

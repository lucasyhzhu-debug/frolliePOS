import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import ShiftWizard, { type WizardStep, type ConfirmedStep } from "@/components/pos/ShiftWizard";

/**
 * Start-of-day wizard — fires when a staff logs in to a CLOSED booth.
 * Walks 4 steps from the open-booth SOP (spec §3A):
 *   1. Count Dubai Chewy Cookies (count step → inventory via CountStep)
 *   2. Power on all devices + confirm GoFood OPEN (instruction)
 *   3. Put 5 cookies in the display (instruction)
 *   4. Tidy booth · clear banner · photo → WA group (instruction)
 *
 * onComplete:
 *   → completeStartOfDay({ idempotencyKey, sessionId, steps, countChanged })
 *   → navigate("/", { replace: true })
 *
 * ADR-013: useIdempotency provides the IDB-persisted key; guard on `!key` before
 * submitting. The mutation itself wraps withIdempotency on the backend.
 */

const STEPS: WizardStep[] = [
  {
    key: "count",
    label: "Hitung stok",
    type: "count",
  },
  {
    key: "power-on",
    label: "Hidupkan perangkat",
    type: "instruction",
    body: (
      <div>
        <p className="font-medium">Hidupkan semua perangkat:</p>
        <ul className="mt-2 list-disc pl-5 space-y-1">
          <li>WiFi</li>
          <li>Printer</li>
          <li>HP Frollie</li>
        </ul>
        <p className="mt-3">Konfirmasi <strong>GoFood OPEN</strong> di aplikasi.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          (Lalamove/Gosend: cek lewat WA. Cocokkan dengan hitungan stok tadi.)
        </p>
      </div>
    ),
  },
  {
    key: "fill-display",
    label: "Isi display",
    type: "instruction",
    body: (
      <div>
        <p>Taruh <strong>5 cookies</strong> ke dalam display booth.</p>
      </div>
    ),
  },
  {
    key: "tidy-booth",
    label: "Rapikan booth",
    type: "instruction",
    body: (
      <div>
        <p className="font-medium">Sebelum buka:</p>
        <ul className="mt-2 list-disc pl-5 space-y-1">
          <li>Rapikan booth</li>
          <li>Pastikan banner terlihat dari eskalator</li>
          <li>Foto depan + dalam booth → kirim ke WA group</li>
        </ul>
      </div>
    ),
  },
];

// Override last step label to match the spec terminal button text.
(STEPS[STEPS.length - 1] as WizardStep).label = "Rapikan booth";
// Terminal button text is set via the last step's label in ShiftWizard.
// Re-assign as the terminal action label.
const STEPS_WITH_TERMINAL: WizardStep[] = [
  ...STEPS.slice(0, -1),
  { ...STEPS[STEPS.length - 1], label: "Mulai hari" },
];

export default function ShiftStart() {
  const navigate = useNavigate();
  const session = useSession();
  const completeStartOfDay = useMutation(api.shifts.public.completeStartOfDay);

  const sessionId = session.status === "active" ? session.sessionId : null;
  const idempotencyKey = useIdempotency(
    sessionId ? `shift:start:${sessionId}` : "shift:start:none",
  );

  if (session.status === "loading") return null;
  if (session.status !== "active") return null; // RootLayout redirects

  async function onComplete(confirmed: ConfirmedStep[], countChanged: number | null) {
    if (!idempotencyKey || !sessionId) return;
    await completeStartOfDay({
      idempotencyKey,
      sessionId,
      steps: confirmed,
      ...(countChanged != null ? { countChanged } : {}),
    });
    navigate("/", { replace: true });
  }

  return (
    <ShiftWizard
      title="Mulai hari"
      steps={STEPS_WITH_TERMINAL}
      onComplete={onComplete}
    />
  );
}

import { useState, useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { FieldMessage } from "@/components/ui/field-message";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

// Dot border + fill classes per phase — one source of truth keyed by phase.
const DOT_CLASSES = {
  idle: { border: "border-foreground", fill: "bg-foreground" },
  error: { border: "border-error", fill: "bg-error" },
  success: { border: "border-success", fill: "bg-success" },
} as const;

interface PinEntryProps {
  onSubmit: (pin: string) => void;
  reset?: number; // increment to clear the buffer externally (e.g. on error)
  pending?: boolean; // verifying — lock input, swap dots for a spinner
  phase?: "idle" | "error" | "success"; // tints dots + picks FieldMessage tone
  message?: string; // inline message under the dots (pre-translated by caller)
  persist?: boolean; // keep `message` visible even after the staffer types (lockout)
}

export function PinEntry({
  onSubmit,
  reset = 0,
  pending = false,
  phase = "idle",
  message,
  persist = false,
}: PinEntryProps) {
  const t = useT();
  const [buffer, setBuffer] = useState("");
  // Mirror buffer in a ref so the click handler can read the LATEST value
  // synchronously, not the stale closure value from the last render. Without
  // this, rapid digit clicks (e.g. Playwright firing 4 clicks before React
  // re-renders) all see the same stale buffer → setState calls coalesce → only
  // one digit registers → onSubmit fires with a partial PIN (or never fires).
  const bufferRef = useRef("");

  useEffect(() => {
    setBuffer("");
    bufferRef.current = "";
  }, [reset]);

  const handle = (key: string) => {
    if (pending) return; // locked while verifying
    if (key === "C") { bufferRef.current = ""; setBuffer(""); return; }
    if (key === "⌫") {
      const next = bufferRef.current.slice(0, -1);
      bufferRef.current = next;
      setBuffer(next);
      return;
    }
    if (bufferRef.current.length >= 4) return;
    const next = bufferRef.current + key;
    bufferRef.current = next;
    setBuffer(next);
    if (next.length === 4) onSubmit(next);
  };

  // A non-persistent error hides once the staffer resumes typing; a persistent
  // (locked-out) message and the success message always show while set. Hidden
  // while pending so the spinner never co-renders with a stale error message.
  const showMessage =
    !pending && !!message && (phase !== "error" || persist || buffer.length === 0);

  const { border: dotBorder, fill: dotFill } = DOT_CLASSES[phase];

  return (
    <div className="flex flex-col items-center gap-6">
      {pending ? (
        <div
          role="status"
          aria-live="polite"
          className="flex h-4 items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("pinEntry.verifying")}</span>
        </div>
      ) : (
        <div className="flex gap-3" data-testid="pin-buffer">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={cn(
                "h-4 w-4 rounded-full border-2 transition-colors",
                dotBorder,
                i < buffer.length && dotFill,
              )}
            />
          ))}
        </div>
      )}

      {showMessage && (
        <FieldMessage tone={phase === "success" ? "success" : "error"}>
          {message}
        </FieldMessage>
      )}

      <NumericKeypad
        onPress={handle}
        size="compact"
        disabled={pending || phase === "success"}
      />
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { cn } from "@/lib/utils";

interface PinEntryProps {
  onSubmit: (pin: string) => void;
  reset?: number; // increment to clear the buffer externally (e.g. on error)
}

export function PinEntry({ onSubmit, reset = 0 }: PinEntryProps) {
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

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex gap-3" data-testid="pin-buffer">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              "h-4 w-4 rounded-full border-2 border-foreground transition-colors",
              i < buffer.length && "bg-foreground",
            )}
          />
        ))}
      </div>
      <NumericKeypad
        onPress={handle}
        size="compact"
      />
    </div>
  );
}

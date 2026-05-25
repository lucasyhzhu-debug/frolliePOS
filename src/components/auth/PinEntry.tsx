import { useState, useEffect } from "react";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { cn } from "@/lib/utils";

interface PinEntryProps {
  onSubmit: (pin: string) => void;
  reset?: number; // increment to clear the buffer externally (e.g. on error)
}

export function PinEntry({ onSubmit, reset = 0 }: PinEntryProps) {
  const [buffer, setBuffer] = useState("");

  useEffect(() => setBuffer(""), [reset]);

  const handle = (key: string) => {
    if (key === "C") return setBuffer("");
    if (key === "⌫") return setBuffer((b) => b.slice(0, -1));
    if (buffer.length >= 4) return;
    const next = buffer + key;
    setBuffer(next);
    if (next.length === 4) {
      onSubmit(next);
    }
  };

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex gap-3">
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
        onClear={() => setBuffer("")}
        onBackspace={() => setBuffer((b) => b.slice(0, -1))}
        size="compact"
      />
    </div>
  );
}

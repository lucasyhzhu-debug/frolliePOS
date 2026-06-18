import { useEffect, useCallback } from "react";
import { Delete } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NumericKeypadProps {
  onPress: (key: string) => void;
  onClear?: () => void;
  onBackspace?: () => void;
  size?: "compact" | "comfortable";
}

const DIGIT_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["C", "0", "⌫"],
] as const;

export function NumericKeypad({
  onPress,
  onClear,
  onBackspace,
  size = "comfortable",
}: NumericKeypadProps) {
  const handleClear = useCallback(
    () => (onClear ? onClear() : onPress("C")),
    [onClear, onPress]
  );

  const handleBackspace = useCallback(
    () => (onBackspace ? onBackspace() : onPress("⌫")),
    [onBackspace, onPress]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") {
        onPress(e.key);
      } else if (e.key === "Backspace") {
        handleBackspace();
      } else if (e.key === "Escape") {
        handleClear();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onPress, handleBackspace, handleClear]);

  const isCompact = size === "compact";

  return (
    <div className={cn("grid grid-cols-3", isCompact ? "gap-1.5" : "gap-2")}>
      {DIGIT_ROWS.map((row) =>
        row.map((key) => {
          if (key === "C") {
            return (
              <Button
                key="C"
                type="button"
                variant="secondary"
                aria-label="Clear"
                className={cn(
                  "tabular text-base font-medium",
                  "border border-border text-foreground",
                  isCompact ? "h-12" : "h-14"
                )}
                onClick={handleClear}
              >
                C
              </Button>
            );
          }

          if (key === "⌫") {
            return (
              <Button
                key="⌫"
                type="button"
                variant="secondary"
                aria-label="Backspace"
                className={cn(
                  "border border-border text-foreground",
                  isCompact ? "h-12" : "h-14"
                )}
                onClick={handleBackspace}
              >
                <Delete className="h-5 w-5" />
              </Button>
            );
          }

          return (
            <Button
              key={key}
              type="button"
              variant="outline"
              aria-label={`Digit ${key}`}
              className={cn(
                "tabular font-medium",
                "border-border bg-secondary text-foreground hover:bg-accent hover:text-accent-foreground",
                isCompact ? "h-12 text-xl" : "h-14 text-2xl"
              )}
              onClick={() => onPress(key)}
            >
              {key}
            </Button>
          );
        })
      )}
    </div>
  );
}

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

interface PinSheetProps {
  open: boolean;
  title: string;
  label: string;
  pending?: boolean;
  error?: string;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
  extraField?: React.ReactNode;
}

export function PinSheet({
  open,
  title,
  label,
  pending = false,
  error,
  onSubmit,
  onCancel,
  extraField,
}: PinSheetProps) {
  const t = useT();
  const [pin, setPin] = useState("");

  // Clear pin buffer whenever error changes (failed attempt)
  useEffect(() => {
    if (error) setPin("");
  }, [error]);

  // Reset buffer on open
  useEffect(() => {
    if (open) setPin("");
  }, [open]);

  // Radix Dialog can leave `body { pointer-events: none }` stuck when it closes
  // amid a burst of state updates (e.g. manager-override success → reactive
  // stage change → re-stage), which deadens every control BEHIND the dialog —
  // including the login PIN keypad (UAT BLOCKER: override → re-login dead keypad).
  // Defensively restore pointer-events one tick after close.
  useEffect(() => {
    if (open) return;
    const id = window.setTimeout(() => {
      document.body.style.pointerEvents = "";
    }, 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const handlePress = (key: string) => {
    if (pending) return;
    if (key === "C") {
      setPin("");
      return;
    }
    if (key === "⌫") {
      setPin((p) => p.slice(0, -1));
      return;
    }
    if (pin.length >= 4) return;
    const next = pin + key;
    setPin(next);
    if (next.length === 4) {
      onSubmit(next);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel();
      }}
    >
      <DialogContent className="max-w-xs px-4 pb-4">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <DialogDescription className="text-sm text-muted-foreground text-center">
          {label}
        </DialogDescription>

        {/* 4-dot PIN display */}
        <div className="flex justify-center gap-3 py-1">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={cn(
                "h-4 w-4 rounded-full border-2 border-foreground transition-colors",
                i < pin.length && "bg-foreground"
              )}
            />
          ))}
        </div>

        {extraField && <div>{extraField}</div>}

        {error && (
          <p className="text-sm text-destructive text-center" role="alert">
            {error}
          </p>
        )}

        {pending && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t("pinSheet.verifying")}</span>
          </div>
        )}

        <NumericKeypad
          onPress={handlePress}
          onClear={() => {
            if (!pending) setPin("");
          }}
          onBackspace={() => {
            if (!pending) setPin((p) => p.slice(0, -1));
          }}
          size="compact"
        />

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

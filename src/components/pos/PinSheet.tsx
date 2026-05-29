import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { cn } from "@/lib/utils";

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
  const [pin, setPin] = useState("");

  // Clear pin buffer whenever error changes (failed attempt)
  useEffect(() => {
    if (error) setPin("");
  }, [error]);

  // Reset buffer on open
  useEffect(() => {
    if (open) setPin("");
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

        <p className="text-sm text-muted-foreground text-center">{label}</p>

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
            <span>Verifying…</span>
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
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

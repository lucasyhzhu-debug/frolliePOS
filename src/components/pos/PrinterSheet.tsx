import { useState } from "react";
import { Printer } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { type PrinterStatus } from "@/hooks/useThermalPrinter";
import { usePrinter } from "@/components/pos/PrinterProvider";
import { encodeReceipt, SAMPLE_RECEIPT } from "@/lib/escpos";
import { cn } from "@/lib/utils";

const LABEL: Record<PrinterStatus, string> = {
  unsupported: "Tidak didukung",
  disconnected: "Terputus",
  connecting: "Menghubungkan…",
  connected: "Terhubung",
  printing: "Mencetak…",
  error: "Error",
};

// Glanceable status dot on the header chip — green = linked, amber pulse =
// working, grey = not linked, red = error (mirrors ConnDot's palette).
const DOT: Record<PrinterStatus, string> = {
  unsupported: "bg-slate-300",
  disconnected: "bg-slate-400",
  connecting: "bg-amber-500 animate-pulse",
  connected: "bg-emerald-500",
  printing: "bg-amber-500 animate-pulse",
  error: "bg-red-500",
};

export function PrinterSheet() {
  const [open, setOpen] = useState(false);
  const { status, connect, disconnect, print } = usePrinter();

  const onTest = async () => {
    try {
      await print(
        encodeReceipt(
          SAMPLE_RECEIPT.viewModel,
          SAMPLE_RECEIPT.status,
          SAMPLE_RECEIPT.statusLabel,
        ),
      );
      toast.success("Tes cetak terkirim");
    } catch {
      toast.error("Gagal mencetak — periksa printer");
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Printer: ${LABEL[status]}`}
        title={`Printer: ${LABEL[status]}`}
        className="relative"
        onClick={() => setOpen(true)}
      >
        <Printer
          className={
            status === "connected" || status === "printing"
              ? "text-teal-600"
              : "text-muted-foreground"
          }
        />
        <span
          aria-hidden
          className={cn(
            "absolute right-0.5 top-0.5 h-2 w-2 rounded-full ring-1 ring-background",
            DOT[status],
          )}
        />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Printer struk</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">Status: {LABEL[status]}</div>
            {status === "unsupported" ? (
              <p className="text-sm text-destructive">Browser ini tidak mendukung Bluetooth.</p>
            ) : status === "connected" || status === "printing" ? (
              <>
                <Button className="w-full" onClick={onTest} disabled={status === "printing"}>
                  Tes cetak
                </Button>
                <Button className="w-full" variant="outline" onClick={disconnect}>
                  Putuskan
                </Button>
              </>
            ) : (
              <Button className="w-full" onClick={connect} disabled={status === "connecting"}>
                Hubungkan printer
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

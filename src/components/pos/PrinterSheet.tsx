import { useState } from "react";
import { Printer } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useThermalPrinter, type PrinterStatus } from "@/hooks/useThermalPrinter";
import { encodeReceipt, SAMPLE_RECEIPT } from "@/lib/escpos";

const LABEL: Record<PrinterStatus, string> = {
  unsupported: "Tidak didukung",
  disconnected: "Terputus",
  connecting: "Menghubungkan…",
  connected: "Terhubung",
  printing: "Mencetak…",
  error: "Error",
};

export function PrinterSheet() {
  const [open, setOpen] = useState(false);
  const { status, connect, disconnect, print } = useThermalPrinter();

  const onTest = async () => {
    try {
      await print(
        encodeReceipt(
          SAMPLE_RECEIPT.viewModel,
          SAMPLE_RECEIPT.status,
          SAMPLE_RECEIPT.statusLabel,
          "https://frollie.id/r/contoh",
        ),
      );
      toast.success("Tes cetak terkirim");
    } catch {
      toast.error("Gagal mencetak — periksa printer");
    }
  };

  return (
    <>
      <Button variant="ghost" size="icon" aria-label="Printer" onClick={() => setOpen(true)}>
        <Printer className={status === "connected" ? "text-teal-600" : "text-muted-foreground"} />
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

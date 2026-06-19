import { useState } from "react";
import { Printer } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { type PrinterStatus } from "@/hooks/useThermalPrinter";
import { usePrinter } from "@/components/pos/PrinterProvider";
import { encodeReceipt, SAMPLE_RECEIPT } from "@/lib/escpos";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

function usePrinterLabels(t: ReturnType<typeof useT>): Record<PrinterStatus, string> {
  return {
    unsupported: t("printerSheet.statusUnsupported"),
    disconnected: t("printerSheet.statusDisconnected"),
    connecting: t("printerSheet.statusConnecting"),
    connected: t("printerSheet.statusConnected"),
    printing: t("printerSheet.statusPrinting"),
    error: t("printerSheet.statusError"),
  };
}

// Glanceable status dot on the header chip — green = linked, amber pulse =
// working, grey = not linked, red = error (mirrors ConnDot's palette).
const DOT: Record<PrinterStatus, string> = {
  unsupported: "bg-muted-foreground/40",
  disconnected: "bg-muted-foreground/60",
  connecting: "bg-warning animate-pulse",
  connected: "bg-success",
  printing: "bg-warning animate-pulse",
  error: "bg-error",
};

export function PrinterSheet() {
  const t = useT();
  const LABEL = usePrinterLabels(t);
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
      toast.success(t("printerSheet.testSuccess"));
    } catch {
      toast.error(t("printerSheet.testError"));
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("printerSheet.ariaLabel", { status: LABEL[status] })}
        title={t("printerSheet.ariaLabel", { status: LABEL[status] })}
        className="relative"
        onClick={() => setOpen(true)}
      >
        <Printer
          className={
            status === "connected" || status === "printing"
              ? "text-primary"
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
            <DialogTitle>{t("printerSheet.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">{t("printerSheet.statusRow", { status: LABEL[status] })}</div>
            {status === "unsupported" ? (
              <p className="text-sm text-destructive">{t("printerSheet.unsupported")}</p>
            ) : status === "connected" || status === "printing" ? (
              <>
                <Button className="w-full" onClick={onTest} disabled={status === "printing"}>
                  {t("printerSheet.testPrint")}
                </Button>
                <Button className="w-full" variant="outline" onClick={disconnect}>
                  {t("printerSheet.disconnect")}
                </Button>
              </>
            ) : (
              <Button className="w-full" onClick={connect} disabled={status === "connecting"}>
                {t("printerSheet.connect")}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

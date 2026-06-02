import { createContext, useContext, type ReactNode } from "react";
import { useThermalPrinter } from "@/hooks/useThermalPrinter";

export type PrinterApi = ReturnType<typeof useThermalPrinter>;

// Safe no-op default for consumers rendered outside a PrinterProvider (e.g. the
// component tests, which don't wrap in the provider). `print` rejects rather
// than silently succeeding so a misconfiguration surfaces instead of hiding.
const DEFAULT_PRINTER: PrinterApi = {
  status: "unsupported",
  connect: async () => {},
  disconnect: () => {},
  print: async () => {
    throw new Error("PRINTER_NOT_CONNECTED");
  },
};

const PrinterContext = createContext<PrinterApi>(DEFAULT_PRINTER);

/**
 * App-global thermal-printer connection. Mounted once in RootLayout (above the
 * router Outlet) so the BLE GATT connection survives route changes — connect
 * once at shift start and it stays connected across the sale → charge →
 * success screens (single-device, no-auto-logout booth model).
 *
 * A per-screen useThermalPrinter() re-mounts on every navigation and drops the
 * connection (the characteristic ref dies with the component); hoisting it to
 * one shared instance is what makes "connect once" actually hold.
 */
export function PrinterProvider({ children }: { children: ReactNode }) {
  const printer = useThermalPrinter();
  return <PrinterContext.Provider value={printer}>{children}</PrinterContext.Provider>;
}

/** Consume the shared printer connection. */
export function usePrinter(): PrinterApi {
  return useContext(PrinterContext);
}

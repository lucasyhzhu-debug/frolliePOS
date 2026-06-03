import { Button } from "@/components/ui/button";

const REASON_COPY: Record<string, string> = {
  EXPIRED: "expired between cart-build and payment",
  INACTIVE: "is no longer active",
  MIN_CART_VALUE: "needs a higher cart total",
  NOT_FOUND: "was removed by the manager",
};

/**
 * Charge-screen advisory banner surfacing V8's `voucher_rejected` signal.
 *
 * Triggered when commitCart applies the cart WITHOUT the offline-cached voucher
 * because the server re-validation failed (ADR-009 server-revalidates-on-sync).
 * The sale proceeds at full price; this banner gives the user a clear path to
 * cancel and pick a different voucher, OR ignore and pay full price.
 *
 * Advisory palette (amber), not alarm (red): the sale is still valid.
 */
export function VoucherRejectBanner({
  rejected,
  onPickAnother,
}: {
  rejected: { code: string; reason: "NOT_FOUND" | "INACTIVE" | "EXPIRED" | "MIN_CART_VALUE" };
  onPickAnother: () => void;
}) {
  return (
    <div
      role="alert"
      className="border border-amber-500 bg-amber-50 dark:bg-amber-950 rounded-md p-3 flex items-center justify-between gap-2"
    >
      <p className="text-sm">
        Voucher <span className="font-mono font-semibold">{rejected.code}</span>{" "}
        {REASON_COPY[rejected.reason] ?? "is invalid"} — applied without it.
      </p>
      <Button size="sm" variant="outline" onClick={onPickAnother}>
        Pick a different voucher
      </Button>
    </div>
  );
}

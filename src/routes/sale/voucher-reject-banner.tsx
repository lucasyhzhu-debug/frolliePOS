import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

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
  const t = useT();
  const REASON_COPY: Record<string, string> = {
    EXPIRED: t("voucherBanner.reasonExpired"),
    INACTIVE: t("voucherBanner.reasonInactive"),
    MIN_CART_VALUE: t("voucherBanner.reasonMinCart"),
    NOT_FOUND: t("voucherBanner.reasonNotFound"),
  };
  return (
    <div
      role="alert"
      className="border border-warning/30 bg-warning/15 rounded-md p-3 flex items-center justify-between gap-2"
    >
      <p className="text-sm">
        {t("voucherBanner.message", { code: rejected.code, reason: REASON_COPY[rejected.reason] ?? t("voucherBanner.reasonInvalid") })}
      </p>
      <Button size="sm" variant="outline" onClick={onPickAnother}>
        {t("voucherBanner.pickAnother")}
      </Button>
    </div>
  );
}

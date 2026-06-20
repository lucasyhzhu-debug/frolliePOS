import { useState, useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useCart } from "@/hooks/useCart";
import { useCatalogCache } from "@/hooks/useCatalogCache";
import {
  validateVoucherAgainst,
  type VoucherForValidate,
} from "../../../convex/lib/voucherValidate";
import { rp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

// REASON_MESSAGES is now built inside the component using t() — moved below.

// Narrowed catalog-snapshot shape — we only read `vouchers` here.
// The full snapshot has products/skus/components/stockLevels too.
type CatalogSnapshot = {
  vouchers: VoucherForValidate[];
} & Record<string, unknown>;

export default function SaleVoucher() {
  const t = useT();
  const navigate = useNavigate();
  const { subtotal, voucherCode, setVoucher, clearVoucher } = useCart();
  const [code, setCode] = useState("");

  const REASON_MESSAGES: Record<string, string> = {
    NOT_FOUND: t("voucher.reasonNotFound"),
    INACTIVE: t("voucher.reasonInactive"),
    EXPIRED: t("voucher.reasonExpired"),
    MIN_CART_VALUE: t("voucher.reasonMinCart"),
  };

  const upperCode = code.toUpperCase();

  // Live BE validation — undefined while loading OR when the WebSocket is
  // disconnected (offline). When undefined we fall back to the cached
  // catalog snapshot below; the server still re-validates on commit (V8).
  const live = useQuery(
    api.vouchers.public.validateVoucher,
    upperCode.length > 0 ? { code: upperCode, cartSubtotal: subtotal } : "skip",
  );

  // Catalog cache already includes active + non-expired vouchers
  // (convex/catalog/public.ts), so an offline lookup is a local find().
  const liveCatalog = useQuery(api.catalog.public.catalog, {});
  const { snapshot } = useCatalogCache<CatalogSnapshot>(
    liveCatalog as CatalogSnapshot | undefined,
  );

  const cachedValidation = useMemo(() => {
    if (upperCode.length === 0) return undefined;
    if (!snapshot) return undefined;
    const v = snapshot.vouchers.find((x) => x.code === upperCode) ?? null;
    return validateVoucherAgainst(v, subtotal, Date.now());
  }, [upperCode, snapshot, subtotal]);

  const validation = live ?? cachedValidation;
  const usingCache = live === undefined && cachedValidation !== undefined;

  const handleApply = () => {
    if (!validation?.valid) return;
    setVoucher(upperCode);
    toast.success(t("voucher.toastApplied"));
    navigate("/sale");
  };

  const handleRemove = () => {
    clearVoucher();
    navigate("/sale");
  };

  return (
    <SpokeLayout title={t("voucher.title")} backTo="/sale">
      <section className="flex flex-1 flex-col gap-4 p-4">
        {/* Code input */}
        <div className="flex gap-2">
          <Input
            aria-label={t("voucher.codeAriaLabel")}
            placeholder={t("voucher.codePlaceholder")}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="flex-1 font-mono tracking-widest uppercase"
          />
          <Button
            disabled={!validation?.valid}
            onClick={handleApply}
          >
            {t("voucher.apply")}
          </Button>
        </div>

        {/* Offline-fallback hint — only when actually falling back. */}
        {usingCache && (
          <p className="text-xs text-muted-foreground">
            {t("voucher.offlineHint")}
          </p>
        )}

        {/* Validation feedback (live or cached) */}
        {upperCode.length > 0 && validation !== undefined && (
          <div className="rounded-md border px-4 py-3">
            {validation.valid ? (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-success">{t("voucher.valid")}</span>
                <span className="text-sm tabular-nums text-success">
                  −{rp(validation.discountAmount)}
                </span>
              </div>
            ) : (
              <p className="text-sm text-destructive">
                {validation.reason != null
                  ? (REASON_MESSAGES[validation.reason] ?? t("voucher.invalid"))
                  : t("voucher.invalid")}
              </p>
            )}
          </div>
        )}

        {/* Remove affordance if a voucher is already applied */}
        {voucherCode && (
          <div className="rounded-md border border-dashed border-border px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {t("voucher.applied", { code: voucherCode })}
              </span>
              <button
                type="button"
                className="text-xs text-destructive underline-offset-2 hover:underline"
                onClick={handleRemove}
              >
                {t("voucher.remove")}
              </button>
            </div>
          </div>
        )}

        {/* Cancel / back */}
        <Button variant="outline" className="w-full" onClick={() => navigate("/sale")}>
          {t("common.cancel")}
        </Button>
      </section>
    </SpokeLayout>
  );
}

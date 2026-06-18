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

const REASON_MESSAGES: Record<string, string> = {
  NOT_FOUND: "Code not found",
  INACTIVE: "Voucher inactive",
  EXPIRED: "Voucher expired",
  MIN_CART_VALUE: "Cart below minimum for this voucher",
};

// Narrowed catalog-snapshot shape — we only read `vouchers` here.
// The full snapshot has products/skus/components/stockLevels too.
type CatalogSnapshot = {
  vouchers: VoucherForValidate[];
} & Record<string, unknown>;

export default function SaleVoucher() {
  const navigate = useNavigate();
  const { subtotal, voucherCode, setVoucher, clearVoucher } = useCart();
  const [code, setCode] = useState("");

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
    toast.success("Voucher applied");
    navigate("/sale");
  };

  const handleRemove = () => {
    clearVoucher();
    navigate("/sale");
  };

  return (
    <SpokeLayout title="Apply voucher" backTo="/sale">
      <section className="flex flex-1 flex-col gap-4 p-4">
        {/* Code input */}
        <div className="flex gap-2">
          <Input
            aria-label="Voucher code"
            placeholder="Enter voucher code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="flex-1 font-mono tracking-widest uppercase"
          />
          <Button
            disabled={!validation?.valid}
            onClick={handleApply}
          >
            Apply
          </Button>
        </div>

        {/* Offline-fallback hint — only when actually falling back. */}
        {usingCache && (
          <p className="text-xs text-muted-foreground">
            Offline — applying from cached list. Server re-validates on commit.
          </p>
        )}

        {/* Validation feedback (live or cached) */}
        {upperCode.length > 0 && validation !== undefined && (
          <div className="rounded-md border px-4 py-3">
            {validation.valid ? (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-success">Valid</span>
                <span className="text-sm tabular-nums text-success">
                  −{rp(validation.discountAmount)}
                </span>
              </div>
            ) : (
              <p className="text-sm text-destructive">
                {validation.reason != null
                  ? (REASON_MESSAGES[validation.reason] ?? "Invalid voucher")
                  : "Invalid voucher"}
              </p>
            )}
          </div>
        )}

        {/* Remove affordance if a voucher is already applied */}
        {voucherCode && (
          <div className="rounded-md border border-dashed border-border px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Applied: <span className="font-medium text-foreground">{voucherCode}</span>
              </span>
              <button
                type="button"
                className="text-xs text-destructive underline-offset-2 hover:underline"
                onClick={handleRemove}
              >
                Remove
              </button>
            </div>
          </div>
        )}

        {/* Cancel / back */}
        <Button variant="outline" className="w-full" onClick={() => navigate("/sale")}>
          Cancel
        </Button>
      </section>
    </SpokeLayout>
  );
}

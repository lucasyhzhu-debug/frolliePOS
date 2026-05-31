import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useCart } from "@/hooks/useCart";
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

export default function SaleVoucher() {
  const navigate = useNavigate();
  const { subtotal, voucherCode, setVoucher, clearVoucher } = useCart();
  const [code, setCode] = useState("");

  const upperCode = code.toUpperCase();

  const validation = useQuery(
    api.vouchers.public.validateVoucher,
    upperCode.length > 0 ? { code: upperCode, cartSubtotal: subtotal } : "skip",
  );

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

        {/* Live validation feedback */}
        {upperCode.length > 0 && validation !== undefined && (
          <div className="rounded-md border px-4 py-3">
            {validation.valid ? (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-green-600">Valid</span>
                <span className="text-sm tabular-nums text-green-600">
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

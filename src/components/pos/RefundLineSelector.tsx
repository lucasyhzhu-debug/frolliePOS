import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rp } from "@/lib/format";
import { useT } from "@/lib/i18n";

type LineProps = {
  productName: string;
  qty: number;
  refunded_qty: number;
  refundable: number;
  unitPrice: number;
  value: number;          // current selected refund qty (0..refundable)
  onChange: (newQty: number) => void;
};

export function RefundLineSelector({
  productName, qty, refunded_qty, refundable, unitPrice, value, onChange,
}: LineProps): ReactNode {
  const t = useT();
  const dec = () => onChange(Math.max(0, value - 1));
  const inc = () => onChange(Math.min(refundable, value + 1));

  const alreadyRefundedFragment = refunded_qty > 0
    ? ` · ${t("refundSelect.alreadyRefunded", { count: refunded_qty })}`
    : "";

  return (
    <div className="border border-border rounded-md p-3 mb-2">
      <div className="text-sm font-semibold mb-1">{productName}</div>
      <div className="text-xs text-muted-foreground mb-2">
        {t("refundSelect.lineInfo", { qty, refundable, price: rp(unitPrice) })}{alreadyRefundedFragment}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="icon" onClick={dec} disabled={value === 0} aria-label={t("refundSelect.decreaseQty")}>−</Button>
        <Input
          type="number"
          min={0}
          max={refundable}
          value={value}
          onChange={(e) => {
            const n = parseInt(e.target.value || "0", 10);
            if (Number.isNaN(n)) return;
            onChange(Math.max(0, Math.min(refundable, n)));
          }}
          className="w-16 text-center"
          aria-label={t("refundSelect.qtyAriaLabel", { productName })}
        />
        <Button type="button" variant="outline" size="icon" onClick={inc} disabled={value === refundable} aria-label={t("refundSelect.increaseQty")}>+</Button>
        <span className="text-xs text-muted-foreground ml-auto">{t("refundSelect.ofRefundable", { refundable })}</span>
      </div>
    </div>
  );
}

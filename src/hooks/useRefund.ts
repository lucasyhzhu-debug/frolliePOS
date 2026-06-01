import { useState, useCallback, useMemo } from "react";

export type RefundLineSelection = {
  line_id: string;
  qty: number;       // > 0; entries with qty=0 are filtered out by `lines`
};

export function useRefund(_initialLines: Array<{ _id: string; refundable: number }>) {
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");

  const setQty = useCallback((lineId: string, qty: number) => {
    setSelections((s) => ({ ...s, [lineId]: qty }));
  }, []);

  const totalQty = useMemo(
    () => Object.values(selections).reduce((sum, q) => sum + q, 0),
    [selections],
  );

  const lines: RefundLineSelection[] = useMemo(
    () =>
      Object.entries(selections)
        .filter(([, qty]) => qty > 0)
        .map(([line_id, qty]) => ({ line_id, qty })),
    [selections],
  );

  const canSubmit = lines.length > 0 && reason.trim().length > 0;

  const qtyFor = useCallback(
    (lineId: string) => selections[lineId] ?? 0,
    [selections],
  );

  const reset = useCallback(() => {
    setSelections({});
    setReason("");
  }, []);

  return {
    setQty,
    qtyFor,
    reason, setReason,
    lines,
    totalQty,
    canSubmit,
    reset,
  };
}

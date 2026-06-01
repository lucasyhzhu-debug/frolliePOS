import { useState, useCallback, useMemo } from "react";

export type RefundLineSelection = {
  line_id: string;
  qty: number;       // > 0; entries with qty=0 are filtered out by `lines`
};

/**
 * Refund-selection hook. Manages per-line qty + reason for the refund detail
 * route. State is keyed by `line_id` at write time, so the hook doesn't need
 * the initial line list — callers just call `setQty(lineId, qty)`.
 *
 * N10 (B28b): dropped unused `_initialLines` arg + unused `totalQty` / `reset`
 * returns — no production caller read them.
 */
export function useRefund() {
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");

  const setQty = useCallback((lineId: string, qty: number) => {
    setSelections((s) => ({ ...s, [lineId]: qty }));
  }, []);

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

  return {
    setQty,
    qtyFor,
    reason, setReason,
    lines,
    canSubmit,
  };
}

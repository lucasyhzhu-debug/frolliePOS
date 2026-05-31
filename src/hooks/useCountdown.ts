import { useEffect, useState } from "react";

/** Xendit QR Code default lifetime (15 min). Used as the progress denominator. */
export const DEFAULT_LIFETIME_MS = 15 * 60_000;

/**
 * Counts down toward `targetEpoch` (Unix ms). Re-ticks every second.
 *
 * @param targetEpoch  - Unix ms timestamp of expiry (from `invoice.created_at + lifetime`).
 *                       Pass `undefined` when no invoice is active — renders a `--:--` placeholder.
 * @param totalLifetimeMs - Total invoice lifetime; used to compute `pctRemaining` (0–1).
 *                          Defaults to 15 min (Xendit QR lifetime).
 *
 * Returns:
 *   - `mmss`         — `"MM:SS"` formatted remaining time, or `"--:--"` when no target.
 *   - `pctRemaining` — 0–1 fraction of lifetime remaining (clamped at 0 when expired).
 *   - `expired`      — `true` when remaining time has reached 0.
 */
export function useCountdown(
  targetEpoch: number | undefined,
  totalLifetimeMs: number = DEFAULT_LIFETIME_MS,
): { mmss: string; pctRemaining: number; expired: boolean } {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!targetEpoch) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [targetEpoch]);

  if (!targetEpoch) return { mmss: "--:--", pctRemaining: 0, expired: false };

  const remaining = Math.max(0, targetEpoch - now);
  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1_000);

  return {
    mmss: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
    pctRemaining: Math.min(1, Math.max(0, remaining / totalLifetimeMs)),
    expired: remaining === 0,
  };
}

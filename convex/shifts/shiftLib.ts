// Pure shift helpers (V8-safe). Replaces deriveBoothState — booth open/closed is
// now stored (outlets.is_open), so there is no state to derive; only shift math.
export function shiftHoursMs(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

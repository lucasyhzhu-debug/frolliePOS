// convex/shifts/lib.ts
import type { Id } from "../_generated/dataModel";

// Legacy: kept for internal.ts shiftEventFields type annotation and pos_shift_events schema.
// deriveBoothState (ADR-050) deleted — booth state is now two stored levels (ADR-053).
export type ShiftEventType =
  | "start_of_day" | "lock" | "resume"
  | "signoff_close" | "handover_out" | "handover_in" | "manager_takeover";

export function computeShiftHoursMs(shiftStartedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - shiftStartedAt);
}

/**
 * Resolve a staff display name from the `_listStaffNames_internal` result set.
 * Centralises the repeated `.find()` pattern across public.ts and actions.ts.
 *
 * @param names  Output of `_listStaffNames_internal` (array of {_id, name}).
 * @param staffId  Staff ID to look up, or null (returns fallback immediately).
 * @param fallback  Returned when not found or staffId is null (default "Unknown").
 */
export function resolveStaffName(
  names: Array<{ _id: Id<"staff">; name: string }>,
  staffId: Id<"staff"> | null,
  fallback = "Unknown",
): string {
  if (!staffId) return fallback;
  return names.find((s) => String(s._id) === String(staffId))?.name ?? fallback;
}

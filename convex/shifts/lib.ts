// convex/shifts/lib.ts
import type { Id } from "../_generated/dataModel";

export type ShiftEventType =
  | "start_of_day" | "lock" | "resume"
  | "signoff_close" | "handover_out" | "handover_in" | "manager_takeover";
export type BoothState = "closed" | "open" | "locked" | "handover_pending";
export type LatestEvent = {
  type: ShiftEventType; staff_id: Id<"staff">; created_at: number; shift_started_at: number;
} | null;

const OPEN_TYPES: ShiftEventType[] = ["start_of_day", "resume", "handover_in", "manager_takeover"];

export function deriveBoothState(
  latest: LatestEvent, wibDayStartMs: number,
): { state: BoothState; staffId: Id<"staff"> | null; staleAutoclose: boolean } {
  if (!latest || latest.type === "signoff_close") {
    return { state: "closed", staffId: null, staleAutoclose: false };
  }
  // A non-closed event from a prior WIB day = forgot to close → treat as closed.
  if (latest.created_at < wibDayStartMs) {
    return { state: "closed", staffId: null, staleAutoclose: true };
  }
  if (latest.type === "lock") return { state: "locked", staffId: latest.staff_id, staleAutoclose: false };
  if (latest.type === "handover_out") return { state: "handover_pending", staffId: latest.staff_id, staleAutoclose: false };
  if (OPEN_TYPES.includes(latest.type)) return { state: "open", staffId: latest.staff_id, staleAutoclose: false };
  return { state: "closed", staffId: null, staleAutoclose: false };
}

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

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

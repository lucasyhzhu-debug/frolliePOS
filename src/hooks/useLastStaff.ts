import { LAST_STAFF_KEY } from "@/lib/storage-keys";
import type { Id } from "../../convex/_generated/dataModel";

export function rememberLastStaff(staffId: Id<"staff">): void {
  localStorage.setItem(LAST_STAFF_KEY, staffId);
}

export function getLastStaff(): Id<"staff"> | null {
  return (localStorage.getItem(LAST_STAFF_KEY) ?? null) as Id<"staff"> | null;
}

/**
 * Forward-looking API. Not called from any v0.5.0 site — wired in v0.5.3+
 * manager-portal "forget this device" flow.
 */
export function forgetLastStaff(): void {
  localStorage.removeItem(LAST_STAFF_KEY);
}

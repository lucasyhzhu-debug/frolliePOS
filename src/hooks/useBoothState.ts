import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useDeviceId } from "./useDeviceId";
import type { BoothState } from "../../convex/shifts/lib";
import type { Id } from "../../convex/_generated/dataModel";

export type BoothStateResult = {
  state: BoothState;
  staffId: Id<"staff"> | null;
  staffName: string | null;
  staleAutoclose: boolean;
};

/**
 * Reactive hook that streams the current booth state for this device.
 *
 * Returns `undefined` while either:
 *  - `useDeviceId` hasn't resolved yet (IDB reconcile in flight), or
 *  - the `boothState` query is still loading.
 *
 * Passes `"skip"` to `useQuery` while `deviceId` is `null` so we never
 * fire a Convex query with an undefined device id (Convex `useQuery` skip
 * pattern — ADR-031 server-time-wins; null device = transient state).
 */
export function useBoothState(): BoothStateResult | undefined {
  const deviceId = useDeviceId();

  const result = useQuery(
    api.shifts.public.boothState,
    deviceId !== null ? { deviceId } : "skip",
  );

  return result ?? undefined;
}

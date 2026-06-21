import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useDeviceId } from "./useDeviceId";

export type OutletStatus = {
  outletDeviceId: string | null;
  /**
   * True when THIS device should be subject to the start-of-day / handover SOP
   * gate. The backend bakes in the backward-compat policy: when no outlet is
   * designated (`outletDeviceId === null`) every device is an outlet.
   */
  isOutlet: boolean;
};

/**
 * Streams whether the current device is the designated booth outlet. Returns
 * `undefined` while `useDeviceId` resolves or the query is in flight — callers
 * must treat undefined as "unknown" (RootLayout defers the SOP gate until it
 * resolves, defaulting to NOT trapping a viewer device).
 */
export function useOutletStatus(): OutletStatus | undefined {
  const deviceId = useDeviceId();
  return useQuery(
    api.settings.public.outletStatus,
    deviceId !== null ? { deviceId } : "skip",
  );
}

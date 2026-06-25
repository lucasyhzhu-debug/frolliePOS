import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useDeviceId } from "./useDeviceId";
import type { Id } from "../../convex/_generated/dataModel";

export type LoginContext = {
  outletOpen: boolean;
  holderStaffId: Id<"staff"> | null;
  holderName: string | null;
};

export function useLoginContext(): LoginContext | undefined {
  const deviceId = useDeviceId();
  return useQuery(
    api.shifts.shifts.loginContext,
    deviceId !== null ? { deviceId } : "skip",
  );
}

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

export type ApprovalStatus =
  | "loading"
  | "pending"
  | "resolved"
  | "denied"
  | "expired"
  | "missing";

export function useApproval(
  requestId: Id<"pos_approval_requests"> | null,
): ApprovalStatus {
  const res = useQuery(
    api.approvals.public.getRequestStatus,
    requestId ? { requestId } : "skip",
  );
  if (requestId === null) return "missing";
  if (res === undefined) return "loading";
  if (res === null) return "missing";
  return res.status;
}

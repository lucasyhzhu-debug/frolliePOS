import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const STORAGE_KEY = "frollie-session-id";

export type SessionState =
  | { status: "loading"; sessionId: null; staff: null }
  | { status: "none"; sessionId: null; staff: null }
  | {
      status: "active";
      sessionId: Id<"staff_sessions">;
      staff: { _id: Id<"staff">; name: string; role: "staff" | "manager" };
    };

export function useSession(): SessionState {
  const [stored, setStored] = useState<string | null>(() =>
    typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null,
  );

  // Cross-tab sync
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setStored(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const validation = useQuery(
    api.auth.getSession,
    stored ? { sessionId: stored as Id<"staff_sessions"> } : "skip",
  );

  if (!stored) return { status: "none", sessionId: null, staff: null };
  if (validation === undefined) return { status: "loading", sessionId: null, staff: null };
  if (validation === null) {
    localStorage.removeItem(STORAGE_KEY);
    return { status: "none", sessionId: null, staff: null };
  }
  return {
    status: "active",
    sessionId: validation.sessionId,
    staff: validation.staff,
  };
}

export function storeSession(sessionId: string): void {
  localStorage.setItem(STORAGE_KEY, sessionId);
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

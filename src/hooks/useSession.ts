import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const STORAGE_KEY = "frollie-session-id";

// Module-level subscriber set for same-tab sync.
// The `storage` event only fires in OTHER tabs; we need this for same-tab.
const listeners = new Set<(value: string | null) => void>();

function notify(value: string | null) {
  listeners.forEach((cb) => cb(value));
}

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

  // Same-tab sync via module-level listener set + cross-tab sync via storage event.
  useEffect(() => {
    listeners.add(setStored);
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setStored(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(setStored);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const validation = useQuery(
    api.auth.public.getSession,
    stored ? { sessionId: stored as Id<"staff_sessions"> } : "skip",
  );

  // Fix V17: remove the dead session from storage in an effect, not during render.
  // `validation === null` means the session row no longer exists (expired/deleted).
  const isDead = stored != null && validation === null;
  useEffect(() => {
    if (isDead) {
      localStorage.removeItem(STORAGE_KEY);
      notify(null);
    }
  }, [isDead]);

  if (!stored) return { status: "none", sessionId: null, staff: null };
  if (validation === undefined) return { status: "loading", sessionId: null, staff: null };
  if (validation === null) return { status: "none", sessionId: null, staff: null };
  return {
    status: "active",
    sessionId: validation.sessionId,
    staff: validation.staff,
  };
}

export function storeSession(sessionId: string): void {
  localStorage.setItem(STORAGE_KEY, sessionId);
  notify(sessionId);
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
  notify(null);
}

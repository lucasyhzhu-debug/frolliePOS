/**
 * src/contexts/OutletContext.tsx
 * Owner cockpit — outlet scope context (v1.3.0 Task 8).
 *
 * Provides the selected outlet scope ("all" | a specific outlet Id) to every
 * cockpit screen. The selection is persisted to localStorage so the owner's
 * preferred view survives page reloads.
 *
 * Wire-in: wrap the cockpit <Outlet /> in <OutletProvider> inside CockpitShell
 * (RootLayout.tsx). Consumers call useOutletContext().
 */
import { createContext, useContext, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { COCKPIT_CURRENT_OUTLET_KEY } from "@/lib/storage-keys";

// ── types ─────────────────────────────────────────────────────────────────────

export type CockpitOutlet = {
  _id: Id<"outlets">;
  code: string;
  name: string;
  address?: string;
  timezone: string;
  active: boolean;
  created_at: number;
};

type OutletContextValue = {
  /** Live list from `api.cockpit.outlets.listOutlets`; `undefined` while loading. */
  outlets: CockpitOutlet[] | undefined;
  /** "all" = business-wide view; an Id = single-outlet view. Default: "all". */
  currentOutletId: Id<"outlets"> | "all";
  /** Update the selection and persist it to localStorage. */
  setCurrentOutlet: (id: Id<"outlets"> | "all") => void;
};

// ── context ───────────────────────────────────────────────────────────────────

const OutletCtx = createContext<OutletContextValue | null>(null);

// ── provider ──────────────────────────────────────────────────────────────────

export function OutletProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();

  // Only query when we have an active cockpit session — `useQuery` with "skip"
  // is a no-op that returns `undefined`, which is the correct loading state.
  const sessionId =
    session.status === "active" && session.kind === "cockpit"
      ? session.sessionId
      : null;

  const outlets = useQuery(
    api.cockpit.outlets.listOutlets,
    sessionId ? { sessionId } : "skip",
  );

  // Lazy-init from localStorage so the previous selection survives a page reload.
  const [currentOutletId, setCurrentOutletId] = useState<
    Id<"outlets"> | "all"
  >(() => {
    try {
      const stored = localStorage.getItem(COCKPIT_CURRENT_OUTLET_KEY);
      return stored ? (stored as Id<"outlets"> | "all") : "all";
    } catch {
      return "all";
    }
  });

  const setCurrentOutlet = (id: Id<"outlets"> | "all") => {
    setCurrentOutletId(id);
    try {
      localStorage.setItem(COCKPIT_CURRENT_OUTLET_KEY, id);
    } catch {
      // Ignore storage errors (private browsing, quota exceeded).
    }
  };

  return (
    <OutletCtx.Provider value={{ outlets, currentOutletId, setCurrentOutlet }}>
      {children}
    </OutletCtx.Provider>
  );
}

// ── hook ──────────────────────────────────────────────────────────────────────

export function useOutletContext(): OutletContextValue {
  const ctx = useContext(OutletCtx);
  if (!ctx) {
    throw new Error("useOutletContext must be used within <OutletProvider>");
  }
  return ctx;
}

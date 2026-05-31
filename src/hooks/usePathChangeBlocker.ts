import { useCallback } from "react";
import { useBlocker, type Blocker } from "react-router";

/**
 * Block route transitions only when `when` is true AND the destination path
 * differs from the current path. Wraps the predicate in useCallback so the
 * Blocker stays referentially stable across renders (an unstable predicate
 * causes useBlocker to thrash — v0.5.0 LESSON 4).
 *
 * Returns the raw Blocker so callers can drive their abandon-confirmation UI
 * (proceed / reset).
 */
export function usePathChangeBlocker(when: boolean): Blocker {
  const predicate = useCallback(
    ({
      currentLocation,
      nextLocation,
    }: {
      currentLocation: { pathname: string };
      nextLocation: { pathname: string };
    }) => when && currentLocation.pathname !== nextLocation.pathname,
    [when],
  );
  return useBlocker(predicate);
}

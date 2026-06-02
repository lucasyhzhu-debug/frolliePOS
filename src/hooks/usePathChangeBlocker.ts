import { useCallback } from "react";
import { useBlocker, type Blocker } from "react-router";

/**
 * Pure blockable-decision for the navigation guard. Extracted so it can be
 * unit-tested without a data router (useBlocker needs one).
 *
 * Blocks when `when` is armed AND the destination path differs from the
 * current one — UNLESS `allowWithin` is set and the destination is inside that
 * prefix. The `allowWithin` escape hatch is what lets a caller permit in-flow
 * navigation (e.g. /sale → /sale/charge/<id>) without tripping the guard: the
 * cart is cleared just before navigating, but `when` is captured from the prior
 * render and is still `true` at navigate time, so a pure `when` check would
 * block a legitimate charge. Matching on the destination prefix sidesteps that
 * stale-state race entirely.
 */
export function shouldBlockNavigation(
  when: boolean,
  current: string,
  next: string,
  allowWithin?: string,
): boolean {
  if (!when || current === next) return false;
  if (allowWithin != null && next.startsWith(allowWithin)) return false;
  return true;
}

/**
 * Block route transitions only when `when` is true AND the destination path
 * differs from the current path. Wraps the predicate in useCallback so the
 * Blocker stays referentially stable across renders (an unstable predicate
 * causes useBlocker to thrash — v0.5.0 LESSON 4).
 *
 * `allowWithin` (optional) whitelists a destination path prefix as in-flow, so
 * intentional navigations within a flow (charge / save-draft / voucher under
 * /sale) never raise the abandon dialog — only leaving the flow does. Callers
 * that omit it keep the original block-any-path-change behavior.
 *
 * Returns the raw Blocker so callers can drive their abandon-confirmation UI
 * (proceed / reset).
 */
export function usePathChangeBlocker(when: boolean, allowWithin?: string): Blocker {
  const predicate = useCallback(
    ({
      currentLocation,
      nextLocation,
    }: {
      currentLocation: { pathname: string };
      nextLocation: { pathname: string };
    }) =>
      shouldBlockNavigation(when, currentLocation.pathname, nextLocation.pathname, allowWithin),
    [when, allowWithin],
  );
  return useBlocker(predicate);
}

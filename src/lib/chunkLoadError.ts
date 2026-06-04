/**
 * Classifies an error as a stale-deploy chunk-load failure.
 *
 * After a redeploy, a client holding a cached `index.html` lazy-imports a
 * route chunk whose hash no longer exists. Modern browsers throw with a
 * message containing one of the three phrases below. This helper centralises
 * the detection so the `RouteErrorBoundary` and any future hook can share
 * the regex and the test cases.
 *
 * Returns `false` for null/undefined/empty inputs so the boundary can safely
 * call `isChunkLoadError(useRouteError())` without an extra null-check.
 */
const CHUNK_LOAD_RE = /dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i;

export function isChunkLoadError(err: unknown): boolean {
  if (err == null) return false;
  const msg =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message?: unknown }).message ?? "")
      : String(err);
  // An empty string can't match the pattern, so no separate length guard.
  return CHUNK_LOAD_RE.test(msg);
}

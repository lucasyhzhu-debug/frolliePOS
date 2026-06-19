// convex/api/v1/_request.ts
// Request-parsing helpers shared by the v1 feed endpoints.
import { ApiError } from "./_auth";

/**
 * Parse the optional `from`/`to` window-bound query params (CONTRACT §6a —
 * date filtering). Both are inclusive-lower / exclusive-upper epoch-ms bounds
 * on the endpoint's order key (paidAt for transactions, createdAt for refunds).
 *
 * Absent/empty → undefined (no bound), preserving the pre-amendment drain
 * behaviour exactly. Present but unparseable, non-integer, or negative → 400
 * BAD_RANGE. `from > to` (an empty/inverted window) is rejected rather than
 * silently returning zero rows, so a caller bug surfaces loudly.
 *
 * Composes with the cursor: the internal queries clamp the effective lower
 * bound to max(cursor-watermark, from), so a window can be paged.
 */
export function parseRange(url: URL): { fromMs?: number; toMs?: number } {
  const fromMs = parseBound(url.searchParams.get("from"), "from");
  const toMs = parseBound(url.searchParams.get("to"), "to");
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new ApiError(400, "BAD_RANGE", "from must be <= to");
  }
  return { fromMs, toMs };
}

function parseBound(raw: string | null, name: string): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiError(400, "BAD_RANGE", `${name} must be a non-negative integer epoch ms`);
  }
  return n;
}

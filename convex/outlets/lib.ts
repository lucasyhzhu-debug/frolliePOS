/**
 * Plain V8-safe helpers for the `outlets` table.
 * Consumed by `convex/cockpit/` (and future modules) so they never reach
 * directly into the outlets table via ctx.db — honouring the
 * no-cross-module-db-access ESLint fence (ADR-034).
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Lookup an outlet by its unique short code. Returns the full doc or null.
 * Safe from both query and mutation contexts (read-only).
 */
export async function getOutletByCode(
  ctx: QueryCtx | MutationCtx,
  code: string,
): Promise<Doc<"outlets"> | null> {
  return ctx.db
    .query("outlets")
    .withIndex("by_code", (q) => q.eq("code", code))
    .first();
}

/**
 * Insert a new outlet row. `created_by` is REQUIRED — pass the ownerStaffId.
 * Returns the new outlet's Id.
 *
 * `is_open` is the ADR-053 Level-1 SOP flag, REQUIRED on the outlets schema since
 * the 2026-06-26 enforce. A freshly-created outlet has never had a shift opened, so
 * it always starts CLOSED — booth staff open it via `openBooth` at start-of-day
 * (mirrors `seedDefaultOutlet`, which also stamps `is_open: false`).
 */
export async function insertOutletRow(
  ctx: MutationCtx,
  fields: {
    code: string;
    name: string;
    address?: string;
    geo?: { lat: number; lng: number };
    timezone: string;
    active: boolean;
    created_at: number;
    created_by: Id<"staff">; // cockpit callers always pass a real owner id; seed rows insert directly via ctx.db
  },
): Promise<Id<"outlets">> {
  return ctx.db.insert("outlets", { ...fields, is_open: false });
}

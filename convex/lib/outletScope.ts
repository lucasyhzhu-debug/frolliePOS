import type { Id } from "../_generated/dataModel";

/**
 * Advisory ergonomics helper: chains a withIndex + eq("outlet_id", outletId)
 * onto a query builder. The lint fence (`no-cross-module-db-access`) is the
 * real enforcement — this helper only reduces boilerplate.
 *
 * Usage:
 *   const rows = await outletScoped(ctx.db.query("pos_transactions"), "by_outlet_date", outlet_id)
 *     .order("desc")
 *     .take(50);
 *
 * V8-safe (no "use node").
 */
export function outletScoped(q: any, indexName: string, outletId: Id<"outlets">) {
  return q.withIndex(indexName, (ix: any) => ix.eq("outlet_id", outletId));
}

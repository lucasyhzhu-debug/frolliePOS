/**
 * Shared seed helpers for convex/transactions/__tests__/. Extracted from
 * history-queries.test.ts + share-receipt.test.ts in the v0.5.3a simplify
 * wave — both files seeded staff + sessions with the same shape.
 *
 * File-specific helpers (seedPaidTxn) stay inline in the consumer test files
 * because they differ across files (one seeds a product+line, the other
 * doesn't — that's local concern).
 */
import { convexTest } from "convex-test";
import type { Id } from "../../_generated/dataModel";

/**
 * Seeds the default outlet (PKW / Pakuwon Mall) for tests that exercise
 * _confirmPaid_internal, which now requires at least one active outlet to
 * allocate a receipt number.
 */
export async function seedDefaultOutlet(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"outlets">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("outlets", {
      code: "PKW",
      name: "x",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    } as any),
  );
}

export async function seedStaff(
  t: ReturnType<typeof convexTest>,
  args: { name: string; role: "staff" | "manager"; code: string },
): Promise<Id<"staff">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("staff", {
      name: args.name,
      role: args.role,
      active: true,
      pin_hash: "x",
      code: args.code,
      created_at: 0,
    } as any),
  );
}

export async function seedSession(
  t: ReturnType<typeof convexTest>,
  staffId: Id<"staff">,
): Promise<Id<"staff_sessions">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: "d1",
      started_at: 0,
      ended_at: null,
      end_reason: null,
    } as any),
  );
}

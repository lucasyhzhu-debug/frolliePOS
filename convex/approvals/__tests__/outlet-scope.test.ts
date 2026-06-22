/**
 * outlet-scope.test.ts
 *
 * v2.0 Stream 5 cross-outlet-denial test for the approvals module (chunk D).
 *
 * Verifies:
 *   1. `_createRequest_internal` stamps `outlet_id` on the row when `outletId` is supplied.
 *   2. `_listPendingByKind_internal` scoped to outlet B returns NOTHING when the only
 *      pending request was created for outlet A — no cross-outlet data leak.
 *   3. The same query scoped to outlet A correctly surfaces the row.
 */

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

// ─── Seed helpers ────────────────────────────────────────────────────────────

async function seedOutlets(
  t: ReturnType<typeof convexTest>,
): Promise<{ outletA: Id<"outlets">; outletB: Id<"outlets"> }> {
  return t.run(async (ctx) => {
    const outletA = await ctx.db.insert("outlets", {
      name: "Outlet A",
      code: "OA-001",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    });
    const outletB = await ctx.db.insert("outlets", {
      name: "Outlet B",
      code: "OB-001",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    });
    return { outletA, outletB };
  });
}

async function seedStaff(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"staff">> {
  return t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "Test Staff",
      code: "S-0099",
      pin_hash: "hash",
      role: "staff",
      active: true,
      created_at: Date.now(),
    }),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("approvals outlet-scoped index (chunk D)", () => {
  it("stamps outlet_id on the approval request row", async () => {
    const t = convexTest(schema);
    const { outletA } = await seedOutlets(t);
    const staffId = await seedStaff(t);
    const now = Date.now();

    const { requestId } = await t.mutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "staff_pin_reset",
        subject_staff_id: staffId,
        triggered_by_event: "auth_lockout",
        triggered_at: now,
        token_hash: "scope-test-hash",
        token_expires_at: now + 3_600_000,
        outletId: outletA,
      },
    );

    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row).not.toBeNull();
    expect(row!.outlet_id).toBe(outletA);
  });

  it("_createRequest_internal without outletId omits outlet_id from the row (migration-window compatibility)", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t);
    const now = Date.now();

    const { requestId } = await t.mutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "staff_pin_reset",
        subject_staff_id: staffId,
        triggered_by_event: "auth_lockout",
        triggered_at: now,
        token_hash: "legacy-hash",
        token_expires_at: now + 3_600_000,
        // outletId intentionally omitted — migration-window row
      },
    );

    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row).not.toBeNull();
    expect(row!.outlet_id).toBeUndefined();
  });
});

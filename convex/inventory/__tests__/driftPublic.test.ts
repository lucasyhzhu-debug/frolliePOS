import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

async function seedOutlet(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    } as any)
  ) as any;
}

async function seedDrift(
  t: ReturnType<typeof convexTest>,
  sku_code: string,
  outletId: any,
  resolved = false,
) {
  const sku = await t.run(async (ctx) =>
    ctx.db.insert("pos_inventory_skus", {
      sku: sku_code,
      name: `Sku ${sku_code}`,
      unit: "piece",
      low_threshold: 0,
      active: true,
      created_at: Date.now(),
      outlet_id: outletId,
    } as never),
  );
  const driftPatch = resolved
    ? { resolved_at: Date.now(), resolution_note: "pre-resolved" }
    : {};
  return await t.run(async (ctx) =>
    ctx.db.insert("pos_stock_drift_log", {
      inventory_sku_id: sku,
      sku_code,
      cached_on_hand: 10,
      reconstructed_on_hand: 7,
      delta: 3,
      detected_at: Date.now(),
      outlet_id: outletId,
      ...driftPatch,
    } as never),
  );
}

describe("inventory.listStockDrift", () => {
  it("returns unresolved drifts only by default", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    await seedDrift(t, "A", outletId, false);
    await seedDrift(t, "B", outletId, true); // resolved — should not appear
    await seedDrift(t, "C", outletId, false);

    const rows = await t.query(api.inventory.public.listStockDrift, { sessionId });
    expect(rows.map((r) => r.sku_code).sort()).toEqual(["A", "C"]);
  });

  it("returns all when includeResolved=true", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    await seedDrift(t, "A", outletId, false);
    await seedDrift(t, "B", outletId, true);
    const rows = await t.query(api.inventory.public.listStockDrift, {
      sessionId,
      includeResolved: true,
    });
    expect(rows.map((r) => r.sku_code).sort()).toEqual(["A", "B"]);
  });

  it("rejects non-manager session", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const staff = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "S",
        code: "S-0002",
        role: "staff",
        active: true,
        pin_hash: "x",
        created_at: Date.now(),
      } as never),
    );
    const sid = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staff,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as never),
    );
    await expect(
      t.query(api.inventory.public.listStockDrift, { sessionId: sid }),
    ).rejects.toThrow();
  });
});

describe("inventory.resolveDrift", () => {
  it("happy path patches + audits + idempotent replay no-op", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    const driftId = await seedDrift(t, "A", outletId, false);

    await t.mutation(api.inventory.public.resolveDrift, {
      idempotencyKey: "k1",
      sessionId,
      driftId,
      note: "Counted by Lucas",
    });

    const row = await t.run(async (ctx) => ctx.db.get(driftId));
    expect(row?.resolved_at).toBeGreaterThan(0);
    expect(row?.resolution_note).toBe("Counted by Lucas");

    // Replay (same key) — must not throw, must not write a second audit
    await t.mutation(api.inventory.public.resolveDrift, {
      idempotencyKey: "k1",
      sessionId,
      driftId,
      note: "Counted by Lucas",
    });
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "stock.recon_drift_resolved"))
        .collect(),
    );
    expect(audits).toHaveLength(1);
  });

  it("rejects non-manager session", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const staff = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "S",
        code: "S-0002",
        role: "staff",
        active: true,
        pin_hash: "x",
        created_at: Date.now(),
      } as never),
    );
    const sid = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staff,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as never),
    );
    const driftId = await seedDrift(t, "A", outletId, false);
    await expect(
      t.mutation(api.inventory.public.resolveDrift, {
        idempotencyKey: "k",
        sessionId: sid,
        driftId,
        note: "x",
      }),
    ).rejects.toThrow();
  });
});

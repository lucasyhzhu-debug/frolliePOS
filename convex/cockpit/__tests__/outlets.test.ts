import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

async function seedSource(ctx: any) {
  const owner = await ctx.db.insert("staff", {
    name: "O",
    code: "O1",
    role: "owner",
    pin_hash: "x",
    active: true,
    created_at: 1,
  });
  const src = await ctx.db.insert("outlets", {
    code: "SRC",
    name: "Src",
    timezone: "Asia/Jakarta",
    active: true,
    created_at: 1,
    created_by: null,
  });
  const sku = await ctx.db.insert("pos_inventory_skus", {
    sku: "dubai",
    name: "Dubai",
    unit: "piece",
    low_threshold: 5,
    active: true,
    created_at: 1,
    outlet_id: src,
  });
  const prod = await ctx.db.insert("pos_products", {
    sku_family: "dubai",
    code: "DUBAI_8PC",
    name: "Dubai 8pcs",
    pack_label: "8pcs",
    price_idr: 100000,
    active: true,
    sort_order: 0,
    tax_rate: 0,
    created_at: 1,
    updated_at: 1,
    outlet_id: src,
  });
  await ctx.db.insert("pos_product_components", {
    product_id: prod,
    inventory_sku_id: sku,
    qty: 8,
    outlet_id: src,
  });
  await ctx.db.insert("pos_settings", {
    founders_summary_enabled: true,
    receipt_business_name: "Frollie",
    updated_at: 1,
    outlet_id: src,
  });
  // stock that must NOT be cloned:
  await ctx.db.insert("pos_stock_levels", {
    inventory_sku_id: sku,
    on_hand: 99,
    outlet_id: src,
    updated_at: 1,
  } as any);
  return { owner, src };
}

test("clone creates outlet with created_by, copies catalog, skips stock", async () => {
  const t = convexTest(schema);
  const { outlet_id } = await t.run(async (ctx) => {
    const { owner, src } = await seedSource(ctx);
    return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
      idempotencyKey: "clone-test-1",
      ownerStaffId: owner,
      mode: "clone",
      source_outlet_id: src,
      name: "Frollie Two",
      code: "TWO",
      timezone: "Asia/Jakarta",
      settings: {},
      staff_ids: [],
      provision_managers_chat: false,
    });
  });
  await t.run(async (ctx) => {
    const o = await ctx.db.get(outlet_id);
    expect(o?.created_by).not.toBeNull(); // owner stamped
    const prods = await ctx.db
      .query("pos_products")
      .withIndex("by_outlet_active_sort", (q) => q.eq("outlet_id", outlet_id))
      .collect();
    expect(prods.length).toBe(1); // catalog copied
    // pos_stock_levels index is by_outlet_sku (["outlet_id","inventory_sku_id"])
    const stock = await ctx.db
      .query("pos_stock_levels")
      .withIndex("by_outlet_sku", (q) => q.eq("outlet_id", outlet_id))
      .collect();
    expect(stock.length).toBe(0); // stock NOT copied
  });
});

test("blank mode creates outlet + settings, no catalog", async () => {
  const t = convexTest(schema);
  const { outlet_id } = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("staff", {
      name: "O",
      code: "O1",
      role: "owner",
      pin_hash: "x",
      active: true,
      created_at: 1,
    } as any);
    return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
      idempotencyKey: "blank-test-1",
      ownerStaffId: owner,
      mode: "blank",
      name: "Blank",
      code: "BLK",
      timezone: "Asia/Jakarta",
      settings: { receipt_business_name: "Blank Co" },
      staff_ids: [],
      provision_managers_chat: false,
    });
  });
  await t.run(async (ctx) => {
    const prods = await ctx.db
      .query("pos_products")
      .withIndex("by_outlet_active_sort", (q) => q.eq("outlet_id", outlet_id))
      .collect();
    expect(prods.length).toBe(0);
    const s = await ctx.db
      .query("pos_settings")
      .withIndex("by_outlet", (q) => q.eq("outlet_id", outlet_id))
      .first();
    expect(s?.receipt_business_name).toBe("Blank Co");
  });
});

test("duplicate code throws OUTLET_CODE_TAKEN, no partial outlet", async () => {
  const t = convexTest(schema);
  await expect(
    t.run(async (ctx) => {
      const owner = await ctx.db.insert("staff", {
        name: "O",
        code: "O1",
        role: "owner",
        pin_hash: "x",
        active: true,
        created_at: 1,
      } as any);
      await ctx.db.insert("outlets", {
        code: "DUP",
        name: "Existing",
        timezone: "Asia/Jakarta",
        active: true,
        created_at: 1,
        created_by: null,
      } as any);
      return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
        idempotencyKey: "dup-test-1",
        ownerStaffId: owner,
        mode: "blank",
        name: "X",
        code: "DUP",
        timezone: "Asia/Jakarta",
        settings: {},
        staff_ids: [],
        provision_managers_chat: false,
      });
    }),
  ).rejects.toThrow("OUTLET_CODE_TAKEN");
});

// ── Task-5 review fix: clone with no source_outlet_id throws ─────────────────

test("clone mode without source_outlet_id throws SOURCE_OUTLET_REQUIRED", async () => {
  const t = convexTest(schema);
  await expect(
    t.run(async (ctx) => {
      const owner = await ctx.db.insert("staff", {
        name: "O",
        code: "O1",
        role: "owner",
        pin_hash: "x",
        active: true,
        created_at: 1,
      } as any);
      return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
        idempotencyKey: "clone-fail-test-1",
        ownerStaffId: owner,
        mode: "clone",
        // source_outlet_id intentionally omitted
        name: "Clone Fail",
        code: "CLF",
        timezone: "Asia/Jakarta",
        settings: {},
        staff_ids: [],
        provision_managers_chat: false,
      });
    }),
  ).rejects.toThrow("SOURCE_OUTLET_REQUIRED");
});

// ── Task-6: listOutlets + listAssignableStaff + createOutlet (public API) ─────

/** Seed an owner staff + active cockpit session (last_active_at = now). */
async function seedCockpitSession(ctx: any) {
  const owner = await ctx.db.insert("staff", {
    name: "Owner",
    code: "O2",
    role: "owner",
    pin_hash: "x",
    active: true,
    created_at: 1,
  });
  const session = await ctx.db.insert("staff_sessions", {
    staff_id: owner,
    device_id: "cockpit-device",
    kind: "cockpit",
    started_at: Date.now(),
    last_active_at: Date.now(),
    ended_at: null,
    end_reason: null,
  });
  return { owner, session };
}

test("listOutlets rejects a booth session with NOT_COCKPIT_SESSION", async () => {
  const t = convexTest(schema);
  const boothSession = await t.run(async (ctx) => {
    const outlet = await ctx.db.insert("outlets", {
      code: "BT",
      name: "Booth",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: 1,
      created_by: null,
    } as any);
    const staff = await ctx.db.insert("staff", {
      name: "S",
      code: "S1",
      role: "staff",
      pin_hash: "x",
      active: true,
      created_at: 1,
    } as any);
    return ctx.db.insert("staff_sessions", {
      staff_id: staff,
      device_id: "d",
      kind: "booth",
      outlet_id: outlet,
      started_at: Date.now(),
      last_active_at: Date.now(),
      ended_at: null,
      end_reason: null,
    });
  });
  await expect(
    t.query(api.cockpit.outlets.listOutlets, { sessionId: boothSession }),
  ).rejects.toThrow("NOT_COCKPIT_SESSION");
});

test("listOutlets returns all active outlets for a cockpit session", async () => {
  const t = convexTest(schema);
  const { session } = await t.run(async (ctx) => {
    await ctx.db.insert("outlets", {
      code: "A1",
      name: "Outlet A",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: 1,
      created_by: null,
    } as any);
    await ctx.db.insert("outlets", {
      code: "B1",
      name: "Outlet B",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: 2,
      created_by: null,
    } as any);
    return seedCockpitSession(ctx);
  });
  const outlets = await t.query(api.cockpit.outlets.listOutlets, { sessionId: session });
  expect(outlets.length).toBe(2);
  expect(outlets.map((o: any) => o.code).sort()).toEqual(["A1", "B1"]);
  // No raw created_by leak — field not in the projection
  expect((outlets[0] as any).created_by).toBeUndefined();
});

test("listAssignableStaff rejects booth session", async () => {
  const t = convexTest(schema);
  const boothSession = await t.run(async (ctx) => {
    const outlet = await ctx.db.insert("outlets", {
      code: "BT2",
      name: "Booth2",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: 1,
      created_by: null,
    } as any);
    const staff = await ctx.db.insert("staff", {
      name: "S2",
      code: "S2",
      role: "staff",
      pin_hash: "x",
      active: true,
      created_at: 1,
    } as any);
    return ctx.db.insert("staff_sessions", {
      staff_id: staff,
      device_id: "d2",
      kind: "booth",
      outlet_id: outlet,
      started_at: Date.now(),
      last_active_at: Date.now(),
      ended_at: null,
      end_reason: null,
    });
  });
  await expect(
    t.query(api.cockpit.outlets.listAssignableStaff, { sessionId: boothSession }),
  ).rejects.toThrow("NOT_COCKPIT_SESSION");
});

test("listAssignableStaff returns active staff without pin_hash", async () => {
  const t = convexTest(schema);
  const { session } = await t.run(async (ctx) => {
    await ctx.db.insert("staff", {
      name: "Alice",
      code: "A1",
      role: "staff",
      pin_hash: "secret",
      active: true,
      created_at: 1,
    } as any);
    await ctx.db.insert("staff", {
      name: "Bob",
      code: "B1",
      role: "manager",
      pin_hash: "secret2",
      active: false, // inactive — must be excluded
      created_at: 2,
    } as any);
    return seedCockpitSession(ctx);
  });
  const staff = await t.query(api.cockpit.outlets.listAssignableStaff, { sessionId: session });
  // Only active NON-OWNER staff (Alice). The owner from seedCockpitSession is
  // excluded — owners aren't assignable booth operators (NIT #1 / B7 hygiene).
  expect(staff.length).toBe(1);
  expect(staff.some((s: any) => s.name === "Alice")).toBe(true);
  expect(staff.some((s: any) => s.role === "owner")).toBe(false);
  // No pin_hash leaks
  expect((staff[0] as any).pin_hash).toBeUndefined();
});

test("createOutlet idempotency: same key returns same outlet_id and creates only one outlet", async () => {
  const t = convexTest(schema);
  const { session } = await t.run(async (ctx) => seedCockpitSession(ctx));

  const args = {
    idempotencyKey: "idem-test-1",
    sessionId: session,
    mode: "blank" as const,
    name: "Idem Outlet",
    code: "IDEM",
    timezone: "Asia/Jakarta",
    settings: {},
    staff_ids: [],
    provision_managers_chat: false,
  };

  const first = await t.action(api.cockpit.outlets.createOutlet, args);
  const second = await t.action(api.cockpit.outlets.createOutlet, args);

  expect(first.outlet_id).toBe(second.outlet_id);

  // Only one outlet with code "IDEM" exists
  const outlets = await t.run(async (ctx) =>
    ctx.db.query("outlets").withIndex("by_code", (q) => q.eq("code", "IDEM")).collect(),
  );
  expect(outlets.length).toBe(1);
});

test("createOutlet writes audit row with source 'cockpit'", async () => {
  const t = convexTest(schema);
  const { session } = await t.run(async (ctx) => seedCockpitSession(ctx));

  await t.action(api.cockpit.outlets.createOutlet, {
    idempotencyKey: "audit-test-1",
    sessionId: session,
    mode: "blank" as const,
    name: "Audited Outlet",
    code: "AUD1",
    timezone: "Asia/Jakarta",
    settings: {},
    staff_ids: [],
    provision_managers_chat: false,
  });

  const auditRow = await t.run(async (ctx) =>
    ctx.db.query("audit_log").order("desc").first(),
  );
  expect(auditRow?.action).toBe("outlet.created");
  expect(auditRow?.source).toBe("cockpit");
});

// ── I2: inner mutation idempotency ────────────────────────────────────────────

test("_createOutletAtomic_internal: same idempotencyKey returns same outlet_id and creates only one outlet", async () => {
  const t = convexTest(schema);
  const { owner } = await t.run(async (ctx) => seedSource(ctx));

  const commonArgs = {
    idempotencyKey: "inner-idem-commit-1",
    ownerStaffId: owner,
    mode: "blank" as const,
    name: "Inner Idem Outlet",
    code: "IIDEM",
    timezone: "Asia/Jakarta",
    settings: {},
    staff_ids: [] as any[],
    provision_managers_chat: false,
  };

  // First call — inserts the outlet row.
  const first = await t.run(async (ctx) =>
    ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, commonArgs),
  );
  // Second call — same key, must short-circuit via withIdempotency cache.
  const second = await t.run(async (ctx) =>
    ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, commonArgs),
  );

  expect(first.outlet_id).toBe(second.outlet_id);

  // Exactly one outlet with this code must exist — no double-insert.
  const outlets = await t.run(async (ctx) =>
    ctx.db.query("outlets").withIndex("by_code", (q: any) => q.eq("code", "IIDEM")).collect(),
  );
  expect(outlets.length).toBe(1);
});

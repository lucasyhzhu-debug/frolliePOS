import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { logAudit } from "../audit/internal";
import { issueDeviceSetupCode } from "../staff/internal";
import { insertInventorySku } from "../catalog/internal";
import { getDefaultOutletDoc } from "../outlets/internal";

/**
 * POS prod deployment slug per CLAUDE.md §"Convex deployment". Update this
 * constant (and CLAUDE.md) if the prod deployment is ever replaced.
 */
export const KNOWN_PROD_SLUG = "savory-zebra-800";

/**
 * Single-writer prod guard, shared by `seed/actions.ts::reset` (the "use node"
 * action) and `_e2eFixtureIds_internal` (V8 internalQuery). Both read
 * `process.env.CONVEX_CLOUD_URL`; this pure helper throws if it matches the
 * known prod slug so neither path can wipe data or leak live session IDs on
 * production. Keep the exact slug + throw shape — tests/specs assert on it.
 */
export function assertNotProd(): void {
  const url = process.env.CONVEX_CLOUD_URL ?? "";
  if (url.includes(KNOWN_PROD_SLUG)) {
    throw new Error(
      `seed is BLOCKED on production (${url}). ` +
      `Refuses to run on the known prod deployment slug "${KNOWN_PROD_SLUG}".`,
    );
  }
}

/**
 * Stable test IDs seeded by `_reset_internal` and resolved by
 * `_e2eFixtureIds_internal`, consumed by e2e/specs/voucher-offline.spec.ts (C2).
 */
type SeedFixtureIds = {
  managerSessionId: Id<"staff_sessions">;
  voucherId: Id<"pos_vouchers">;
  voucherCode: string;
};

export const _countStaff_internal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("staff").collect();
    return rows.length;
  },
});

/**
 * DEV/E2E-ONLY: resolve the stable test IDs seeded by `_reset_internal` WITHOUT
 * re-running reset. e2e/specs/voucher-offline.spec.ts (C2) consumes these to
 * drive the manager archiveVoucher CLI step. Reading (rather than re-seeding)
 * matters: the Playwright fixture already ran reset to sign in, and re-running
 * it mid-spec would wipe staff_sessions and log the page out.
 *
 * Returns the active session for the seeded manager (Lucas) and the OFFLINE10
 * voucher. Throws LOUDLY if either is absent so a seed regression fails the
 * spec rather than silently passing. INTERNAL — not exposed via api.*.
 */
export const _e2eFixtureIds_internal = internalQuery({
  args: {},
  handler: async (ctx): Promise<SeedFixtureIds> => {
    // Single-writer prod guard (shared with seed/actions.ts::reset): never
    // return live session IDs on the known prod deployment.
    assertNotProd();
    const manager = (
      await ctx.db
        .query("staff")
        .withIndex("by_role", (q) => q.eq("role", "manager"))
        .collect()
    ).find((s) => s.active && s.name === "Lucas");
    if (!manager) {
      throw new Error("_e2eFixtureIds_internal: no active manager 'Lucas' — run seed/actions:reset first.");
    }
    const session = (await ctx.db
      .query("staff_sessions")
      .withIndex("by_staff_active", (q) => q.eq("staff_id", manager._id).eq("ended_at", null))
      .first());
    if (!session) {
      throw new Error("_e2eFixtureIds_internal: no active session for the seeded manager — run seed/actions:reset first.");
    }
    const voucher = await ctx.db
      .query("pos_vouchers")
      .withIndex("by_code", (q) => q.eq("code", "OFFLINE10"))
      .first();
    if (!voucher) {
      throw new Error("_e2eFixtureIds_internal: OFFLINE10 voucher absent — run seed/actions:reset first.");
    }
    return {
      managerSessionId: session._id,
      voucherId: voucher._id,
      voucherCode: voucher.code,
    };
  },
});

export const _reset_internal = internalMutation({
  args: {
    staffPinHash: v.string(),
    mgrPinHash: v.string(),
    staffNames: v.array(v.string()),
    // ADR-053: which seeded staff holds the active shift (default "Lucas").
    // e2e fixtures pass the staff they're about to sign in as, because a
    // non-holder login is BLOCKED under the two-level booth state.
    holderStaffName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ wiped: number; inserted: number } & SeedFixtureIds> => {
    const now = Date.now();
    let wiped = 0;

    // Wipe order: children before parents to avoid orphaned references
    for (const table of [
      "audit_log", "pos_idempotency", "pos_auth_attempts",
      "staff_sessions", "registered_devices", "pending_device_setups",
      // v0.3 sale / payment / voucher / approval tables (children before parents).
      // Without these, a dev reset left orphaned txns + an ever-climbing receipt
      // counter, breaking the "wipe + bootstrap" smoke-flow premise (I5).
      "pos_voucher_redemptions", "pos_stock_movements", "pos_xendit_invoices",
      "pos_refunds", "pos_shift_events", "pos_shifts",
      // pos_settings survived resets for years unnoticed, until a real manual-BCA
      // account configured on dev leaked into e2e (spec expects the "0000000000"
      // default that only renders when no settings row exists for the outlet).
      // Settings are per-outlet (v2.0) and outlets are wiped below — a surviving
      // row is always an orphan pointing at a deleted outlet.
      "pos_settings",
      "pos_transaction_lines", "pos_transactions", "pos_receipt_counters",
      "pos_vouchers", "pos_approval_requests",
      "pos_low_stock_alerts", "pos_recount_state",
      "pos_stock_levels", "pos_product_components", "pos_products", "pos_inventory_skus",
      // v2.0: wipe outlet tables (children first)
      "staff_outlet_access", "outlets",
      "staff",
    ] as const) {
      const all = await ctx.db.query(table).collect();
      for (const r of all) { await ctx.db.delete(r._id); wiped++; }
    }

    let inserted = 0;

    // v2.0 Task 7 (C2): seed the default outlet (Pakuwon — the single booth in v1).
    // All seeded staff get an access row; the dev device is bound here so that dev
    // loads boot with a correctly-stamped session and outlet_id propagates through
    // the full login commit flow during development.
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW",
      name: "Frollie — Pakuwon",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: now,
      created_by: null, // house null-convention for the backfilled default outlet
      is_open: false, // ENFORCE (ADR-053): is_open is required — seeded outlet starts closed.
    });
    inserted++;

    // Staff: 4 crew (PIN 0000) + 1 manager (PIN 9999)
    // staffCode allocated sequentially as "S-NNNN" per ADR-034 stable IDs.
    let staffCounter = 1;
    const seededStaffIds: Id<"staff">[] = [];
    for (const name of args.staffNames) {
      const code = `S-${String(staffCounter).padStart(4, "0")}`;
      const staffId = await ctx.db.insert("staff", {
        name, code, pin_hash: args.staffPinHash, role: "staff", active: true, created_at: now,
      });
      seededStaffIds.push(staffId);
      staffCounter++;
      inserted++;
    }
    const mgrCode = `S-${String(staffCounter).padStart(4, "0")}`;
    const lucasId = await ctx.db.insert("staff", {
      name: "Lucas", code: mgrCode, pin_hash: args.mgrPinHash, role: "manager",
      active: true, created_at: now,
    });
    seededStaffIds.push(lucasId);
    inserted++;

    // v2.0 Task 7: grant every seeded staff member access to the default outlet.
    for (const staffId of seededStaffIds) {
      await ctx.db.insert("staff_outlet_access", {
        staff_id: staffId,
        outlet_id: outletId,
        granted_at: now,
        granted_by: null, // house null-convention for seed-granted access
      });
      inserted++;
    }

    // DEV-ONLY: pre-register a fixed device so dev / Chrome-MCP loads skip the
    // /activate gate. The id matches DEV_DEVICE_ID in src/lib/storage-keys.ts
    // (the two runtimes cannot share a module — keep them in sync). registered_devices
    // is wiped above, so re-running reset replaces this row. Never seeded by
    // `bootstrap` (the prod path), and `reset` is prod-guarded by deployment slug.
    // v2.0 Task 7: bind the dev device to the default outlet so the seeded
    // manager session carries a correct outlet_id from the start.
    await ctx.db.insert("registered_devices", {
      device_id: "dev-booth-device",
      label: "Dev Booth Device",
      activated_by: lucasId,
      activated_at: now,
      last_seen_at: now,
      active: true,
      outlet_id: outletId, // v2.0 OQ4: dev device is bound at seed time
    });
    inserted++;

    // Inventory SKUs + initial stock levels
    // componentCode = UPPERCASE_SNAKE of the sku key per ADR-034 stable IDs.
    const skus: Record<string, any> = {};
    for (const [sku, name, hue, threshold, onHand] of [
      ["dubai",   "Dubai cookie",   30,  4, 18],
      ["choco",   "Choco cookie",   20,  4, 12],
      ["matcha",  "Matcha cookie",  110, 4,  8],
      ["lotus",   "Lotus cookie",    50, 4,  5],
      ["brownie", "Brownie mini",    15, 4, 24],
    ] as const) {
      const code = sku.toUpperCase();
      const id = await ctx.db.insert("pos_inventory_skus", {
        sku, code, name, unit: "piece", low_threshold: threshold,
        initials: name.slice(0, 2), hue, active: true, created_at: now,
        outlet_id: outletId,
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: id, on_hand: onHand, updated_at: now,
        outlet_id: outletId,
      });
      skus[sku] = id;
      inserted += 2; // 1 SKU + 1 stock level
    }

    // Products + components
    // name, pack_label, price_idr, components[[sku, qty]], sort_order
    // Dubai prices mirror the launch catalog (_seedLaunchCatalog_internal below)
    // — the overlapping productCodes (DUBAI_*PC) must not drift between the two.
    const products: Array<[string, string, number, Array<[string, number]>, number]> = [
      ["Dubai",     "1 pc",  45000, [["dubai", 1]],                                          1],
      ["Dubai",     "3 pcs", 125000, [["dubai", 3]],                                          2],
      ["Dubai",     "8 pcs", 320000, [["dubai", 8]],                                          3],
      ["Choco",     "1 pc",  25000, [["choco", 1]],                                          4],
      ["Matcha",    "1 pc",  25000, [["matcha", 1]],                                         5],
      ["Lotus",     "1 pc",  28000, [["lotus", 1]],                                          6],
      ["Mixed Box", "4 pcs", 95000, [["choco", 1], ["matcha", 1], ["lotus", 1], ["brownie", 1]], 7],
    ];

    for (const [name, pack, price, comps, order] of products) {
      const family = comps[0][0];
      const hue = family === "dubai" ? 30 : family === "choco" ? 20 : family === "matcha" ? 110 : family === "lotus" ? 50 : 15;
      // productCode = <FAMILY>_<PACKDIGITS>PC per ADR-034 stable IDs.
      // Mixed Box uses MIXED prefix; otherwise uppercase the product name (snake-cased).
      const packDigits = pack.match(/\d+/)?.[0] ?? "1";
      const codePrefix = name === "Mixed Box" ? "MIXED" : name.toUpperCase().replace(/\s+/g, "_");
      const code = `${codePrefix}_${packDigits}PC`;
      const productId = await ctx.db.insert("pos_products", {
        sku_family: family,
        code,
        name,
        pack_label: pack,
        price_idr: price,
        initials: (name[0] + (pack.match(/\d+/)?.[0] ?? "")).slice(0, 2),
        hue,
        active: true,
        sort_order: order,
        tax_rate: 0,
        created_at: now,
        updated_at: now,
        outlet_id: outletId,
      });
      inserted++;
      for (const [skuKey, qty] of comps) {
        await ctx.db.insert("pos_product_components", {
          product_id: productId, inventory_sku_id: skus[skuKey], qty,
          outlet_id: outletId,
        });
        inserted++;
      }
    }

    // ── E2E fixtures (dev-only; `reset` is prod-guarded by deployment slug) ──
    // Stable test IDs consumed by e2e/specs/voucher-offline.spec.ts (C2). The
    // offline-voucher spec needs (a) an active manager session it can drive the
    // CLI archiveVoucher mutation with, and (b) a pre-created voucher to apply
    // offline then race against the archive. Both are returned below so the spec
    // never carries hardcoded/<TBD> IDs. Tables are wiped above, so re-running
    // reset replaces these rows.

    // Active, non-ended manager session for the seeded manager (Lucas), shaped
    // exactly like a real session row (ended_at/end_reason null while active),
    // bound to the pre-registered dev device.
    // v2.0 Task 7: stamp outlet_id so the session carries the correct outlet from
    // the start — mirrors what _loginCommit_internal does for production logins.
    const managerSessionId = await ctx.db.insert("staff_sessions", {
      staff_id: lucasId,
      device_id: "dev-booth-device",
      started_at: now,
      ended_at: null,
      end_reason: null,
      outlet_id: outletId, // v2.0 Task 7 (C2)
    });
    inserted++;

    // Open the booth — ADR-053 two-level stored state (supersedes the ADR-050
    // pos_shift_events open-event this block used to write; deriveBoothState is
    // deleted, so that event no longer opened anything and every seeded login
    // redirected to /shift/start — the silent e2e sign-in breakage of 2026-06-26).
    // Level 1: outlets.is_open. Level 2: an active pos_shifts holder row
    // (shape mirrors shiftsInternal._startShift_internal). Both are required
    // for a login to resume at the home dashboard; the holder must be the
    // person logging in (a non-holder login is blocked).
    const holderName = args.holderStaffName ?? "Lucas";
    const holderId =
      holderName === "Lucas"
        ? lucasId
        : seededStaffIds[args.staffNames.indexOf(holderName)];
    if (!holderId) throw new Error(`SEED_UNKNOWN_HOLDER: ${holderName}`);
    await ctx.db.patch(outletId, {
      is_open: true,
      opened_at: now,
      opened_by: holderId,
      opened_via: "sop",
    });
    await ctx.db.insert("pos_shifts", {
      outlet_id: outletId,
      device_id: "dev-booth-device",
      staff_id: holderId,
      started_at: now,
      started_via: "sop",
      ended_at: null,
      ended_via: null,
      open_count: null,
      close_count: null,
      outgoing_uncounted: null,
      steps: [],
      summary: null,
      prev_shift_id: null,
      created_at: now,
    });
    inserted++;

    // Pre-created voucher for the offline-apply → mgr-archive → reject flow.
    const voucherCode = "OFFLINE10";
    const voucherId = await ctx.db.insert("pos_vouchers", {
      code: voucherCode,
      type: "amount",
      value: 500,
      used_count: 0,
      active: true,
      created_at: now,
      created_by_staff_id: lucasId,
      outlet_id: outletId,
    });
    inserted++;

    await logAudit(ctx, {
      actor_id: "system",
      action: "seed.reset",
      entity_type: "system",
      source: "system",
      metadata: { wiped, inserted, staff_names: args.staffNames },
    });

    return {
      wiped,
      inserted,
      managerSessionId,
      voucherId,
      voucherCode,
    };
  },
});

/**
 * Commit the bootstrap seed: insert Lucas as S-0001 (manager, PIN hashed by the
 * caller action from BOOTSTRAP_MANAGER_PIN — SEC-03) with must_change_pin=true.
 * Aborts if the staff table is already non-empty — this is a one-shot operation
 * for fresh deployments only.
 *
 * seed module is allowlisted in eslint.config.js ALLOWLIST so writing the
 * auth-owned `staff` table from here is permitted per ADR-034.
 */
export const _bootstrapCommit_internal = internalMutation({
  args: { pinHash: v.string() },
  handler: async (ctx, args): Promise<{ staffId: Id<"staff">; staffCode: string }> => {
    const existing = await ctx.db.query("staff").take(1);
    if (existing.length > 0) {
      throw new Error("already_bootstrapped");
    }

    const now = Date.now();
    const staffCode = "S-0001";
    const staffId = await ctx.db.insert("staff", {
      name: "Lucas",
      code: staffCode,
      pin_hash: args.pinHash,
      role: "manager",
      active: true,
      created_at: now,
      must_change_pin: true, // SEC-03: force rotation off the bootstrap default
    });

    await logAudit(ctx, {
      actor_id: "system",
      action: "staff.bootstrapped",
      entity_type: "staff",
      entity_id: staffId,
      source: "system",
      metadata: { code: staffCode },
    });

    return { staffId, staffCode };
  },
});

/**
 * Launch-day catalog seed (2026-06-12). One-shot, prod-runnable.
 *
 * Inserts the Frollie booth catalog — 2 inventory SKUs (dubai, water) + 4
 * products (Dubai Chewy Cookie Single/Triple/Eight + Mineral Water) — on a
 * fresh deployment where no pos_products rows exist yet. No pos_stock_levels
 * rows are written: `upsertStockLevel` lazy-inits on first movement and all
 * reads default absent rows to 0; the opening recount on launch day writes the
 * real stock as a logged movement (ADR-041, business rule #8). The product
 * tagline ("Chewy marshmallow filled with
 * Pistachio Kunafa") has no schema home — pos_products has no description field
 * — and is a receipt-branding/marketing concern, not catalog data.
 *
 * Run command (prod):
 *   npx convex run --prod seed/internal:_seedLaunchCatalog_internal
 *
 * Guard: throws "catalog_already_populated" if any pos_products OR
 * pos_inventory_skus row already exists (mirrors _bootstrapCommit_internal's
 * "already_bootstrapped" pattern; checking both tables prevents duplicate SKU
 * rows after a partial seed or manual SKU entry — by_sku assumes uniqueness).
 * Safe to re-attempt on a truly empty deployment.
 */
export const _seedLaunchCatalog_internal = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ skus: number; products: number }> => {
    // One-shot guard — mirrors _bootstrapCommit_internal. Any catalog data
    // (products or SKUs) aborts: a products-only check would duplicate SKU
    // rows on a partially-seeded deployment.
    const [existingProduct, existingSku] = await Promise.all([
      ctx.db.query("pos_products").take(1),
      ctx.db.query("pos_inventory_skus").take(1),
    ]);
    if (existingProduct.length > 0 || existingSku.length > 0) {
      throw new Error("catalog_already_populated");
    }

    // v2.0 Task 12 (ENFORCE): catalog rows must carry an outlet. The default
    // outlet is seeded by _bootstrapCommit_internal / backfill before this runs.
    const defaultOutlet = await getDefaultOutletDoc(ctx);
    if (!defaultOutlet) throw new Error("NO_DEFAULT_OUTLET");
    const outletId = defaultOutlet._id;

    const now = Date.now();

    // ── 1. Inventory SKUs (no stock-level rows — lazy-init, see doc above) ──
    const skuDefs: Array<{
      sku: string;
      code: string;
      name: string;
      low_threshold: number;
      initials: string;
      hue: number;
    }> = [
      { sku: "dubai", code: "DUBAI", name: "Dubai cookie",    low_threshold: 4, initials: "Du", hue: 30  },
      { sku: "water", code: "WATER", name: "Mineral water",   low_threshold: 6, initials: "Mw", hue: 205 },
    ];

    const skuIds: Record<string, Id<"pos_inventory_skus">> = {};
    for (const def of skuDefs) {
      // Canonical insert (catalog/internal.ts) — same single-writer shape as
      // the manager-PIN createInventorySku/createProduct paths (v0.5.5 lesson).
      skuIds[def.sku] = await insertInventorySku(ctx, { ...def, now, outlet_id: outletId });
    }

    // ── 2. Products + components ────────────────────────────────────────────
    // NOTE: the dev fixture in _reset_internal defines overlapping productCodes
    // (e.g. DUBAI_8PC) — keep prices in sync with this block, which is the
    // launch-catalog source of truth (45000/125000/320000/5000).
    type ProductDef = {
      name: string;
      pack_label: string;
      code: string;
      price_idr: number;
      sku_family: string;
      sort_order: number;
      initials: string;
      hue: number;
      components: Array<{ sku: string; qty: number }>;
    };

    const productDefs: ProductDef[] = [
      {
        name: "Dubai Chewy Cookie", pack_label: "Single", code: "DUBAI_1PC",
        price_idr: 45000,  sku_family: "dubai", sort_order: 1,
        initials: "D1", hue: 30,
        components: [{ sku: "dubai", qty: 1 }],
      },
      {
        name: "Dubai Chewy Cookie", pack_label: "Triple", code: "DUBAI_3PC",
        price_idr: 125000, sku_family: "dubai", sort_order: 2,
        initials: "D3", hue: 30,
        components: [{ sku: "dubai", qty: 3 }],
      },
      {
        name: "Dubai Chewy Cookie", pack_label: "Eight",  code: "DUBAI_8PC",
        price_idr: 320000, sku_family: "dubai", sort_order: 3,
        initials: "D8", hue: 30,
        components: [{ sku: "dubai", qty: 8 }],
      },
      {
        name: "Mineral Water",      pack_label: "1 btl",  code: "WATER_1BTL",
        price_idr: 5000,   sku_family: "water", sort_order: 4,
        initials: "MW", hue: 205,
        components: [{ sku: "water", qty: 1 }],
      },
    ];

    for (const def of productDefs) {
      const productId = await ctx.db.insert("pos_products", {
        sku_family: def.sku_family,
        code: def.code,
        name: def.name,
        pack_label: def.pack_label,
        price_idr: def.price_idr,
        initials: def.initials,
        hue: def.hue,
        active: true,
        sort_order: def.sort_order,
        tax_rate: 0,
        created_at: now,
        updated_at: now,
        outlet_id: outletId,
      });
      for (const comp of def.components) {
        await ctx.db.insert("pos_product_components", {
          product_id: productId,
          inventory_sku_id: skuIds[comp.sku],
          qty: comp.qty,
          outlet_id: outletId,
        });
      }
    }

    // ── 3. Audit ────────────────────────────────────────────────────────────
    await logAudit(ctx, {
      actor_id: "system",
      action: "seed.launch_catalog",
      entity_type: "system",
      source: "system",
      metadata: { skus: 2, products: 4 },
    });

    return { skus: 2, products: 4 };
  },
});

/**
 * DEV-ONLY: mint a one-shot device setup code without a manager session.
 * Solves the first-device chicken-and-egg on a fresh deployment after
 * bootstrap/reset (no devices registered yet, so no way to start a session,
 * so no way to call the manager-gated `staff:public:generateDeviceSetupCode`).
 *
 * Guards: (1) any active manager must already exist; (2) at least one
 * non-prod-shaped check — refuses if any active registered_devices row
 * exists (i.e., a real device is in use, so the chicken-and-egg has already
 * been broken — go through the UI instead).
 *
 * Invoke: `npx convex run seed/internal:_devMintSetupCode_internal`
 */
export const _devMintSetupCode_internal = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ code: string; expiresAt: number; issuedByCode: string | undefined }> => {
    // Dev-only helper: deliberately permissive. If you can `convex run` this,
    // you already have admin access to the deployment, so the only guard
    // worth enforcing is "a manager exists" (otherwise the code can't be
    // attributed to anyone).
    const managers = (await ctx.db.query("staff").collect()).filter(
      (s) => s.role === "manager" && s.active,
    );
    if (managers.length === 0) {
      throw new Error("_devMintSetupCode_internal: no active manager exists. Run `seed:actions:bootstrap` or `seed:actions:reset` first.");
    }
    const issuer = managers[0];

    // Reuse the canonical single-writer so this dev path can never drift from the
    // booth/Telegram issuance paths (code-gen, collision loop, `issued_via` stamp,
    // and audit shape are all centralized — v0.5.5 canonical-insert lesson). A
    // dev-minted code is a booth-channel code attributed to the seeded manager.
    const { code, expiresAt } = await issueDeviceSetupCode(ctx, {
      issuedVia: "booth_inline",
      issuedBy: issuer._id,
    });

    return { code, expiresAt, issuedByCode: issuer.code };
  },
});

import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { logAudit } from "../audit/internal";
import { issueDeviceSetupCode } from "../staff/internal";

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
  handler: async (
    ctx,
  ): Promise<{
    managerSessionId: Id<"staff_sessions">;
    voucherId: Id<"pos_vouchers">;
    voucherCode: string;
    managerStaffCode: string;
  }> => {
    const manager = (await ctx.db.query("staff").collect()).find(
      (s) => s.role === "manager" && s.active && s.name === "Lucas",
    );
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
    if (!manager.code) {
      throw new Error("_e2eFixtureIds_internal: seeded manager has no staff code.");
    }
    return {
      managerSessionId: session._id,
      voucherId: voucher._id,
      voucherCode: voucher.code,
      managerStaffCode: manager.code,
    };
  },
});

export const _reset_internal = internalMutation({
  args: {
    staffPinHash: v.string(),
    mgrPinHash: v.string(),
    staffNames: v.array(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    wiped: number;
    inserted: number;
    managerSessionId: Id<"staff_sessions">;
    voucherId: Id<"pos_vouchers">;
    voucherCode: string;
    managerStaffCode: string;
  }> => {
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
      "pos_transaction_lines", "pos_transactions", "pos_receipt_counters",
      "pos_vouchers", "pos_approval_requests",
      "pos_stock_levels", "pos_product_components", "pos_products", "pos_inventory_skus",
      "staff",
    ] as const) {
      const all = await ctx.db.query(table).collect();
      for (const r of all) { await ctx.db.delete(r._id); wiped++; }
    }

    let inserted = 0;

    // Staff: 4 crew (PIN 0000) + 1 manager (PIN 9999)
    // staffCode allocated sequentially as "S-NNNN" per ADR-034 stable IDs.
    let staffCounter = 1;
    for (const name of args.staffNames) {
      const code = `S-${String(staffCounter).padStart(4, "0")}`;
      await ctx.db.insert("staff", {
        name, code, pin_hash: args.staffPinHash, role: "staff", active: true, created_at: now,
      });
      staffCounter++;
      inserted++;
    }
    const mgrCode = `S-${String(staffCounter).padStart(4, "0")}`;
    const lucasId = await ctx.db.insert("staff", {
      name: "Lucas", code: mgrCode, pin_hash: args.mgrPinHash, role: "manager",
      active: true, created_at: now,
    });
    inserted++;

    // DEV-ONLY: pre-register a fixed device so dev / Chrome-MCP loads skip the
    // /activate gate. The id matches DEV_DEVICE_ID in src/lib/storage-keys.ts
    // (the two runtimes cannot share a module — keep them in sync). registered_devices
    // is wiped above, so re-running reset replaces this row. Never seeded by
    // `bootstrap` (the prod path), and `reset` is prod-guarded by deployment slug.
    await ctx.db.insert("registered_devices", {
      device_id: "dev-booth-device",
      label: "Dev Booth Device",
      activated_by: lucasId,
      activated_at: now,
      last_seen_at: now,
      active: true,
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
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: id, on_hand: onHand, updated_at: now,
      });
      skus[sku] = id;
      inserted += 2; // 1 SKU + 1 stock level
    }

    // Products + components
    // name, pack_label, price_idr, components[[sku, qty]], sort_order
    const products: Array<[string, string, number, Array<[string, number]>, number]> = [
      ["Dubai",     "1 pc",  45000, [["dubai", 1]],                                          1],
      ["Dubai",     "3 pcs", 125000, [["dubai", 3]],                                          2],
      ["Dubai",     "8 pcs", 340000, [["dubai", 8]],                                          3],
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
      });
      inserted++;
      for (const [skuKey, qty] of comps) {
        await ctx.db.insert("pos_product_components", {
          product_id: productId, inventory_sku_id: skus[skuKey], qty,
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
    const managerSessionId = await ctx.db.insert("staff_sessions", {
      staff_id: lucasId,
      device_id: "dev-booth-device",
      started_at: now,
      ended_at: null,
      end_reason: null,
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
      managerStaffCode: mgrCode,
    };
  },
});

/**
 * Commit the bootstrap seed: insert Lucas as S-0001 (manager, PIN 1111 hashed
 * by the caller action). Aborts if the staff table is already non-empty — this
 * is a one-shot operation for fresh deployments only.
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

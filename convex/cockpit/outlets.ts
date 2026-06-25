/**
 * convex/cockpit/outlets.ts
 * v1.3.0 owner cockpit — outlet management mutations.
 *
 * ALL outlets-table access routes through convex/outlets/lib.ts helpers
 * (no raw ctx.db on "outlets" here — ADR-034 / no-cross-module-db-access fence).
 */
import { action, internalMutation, query } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireCockpitSession } from "../auth/sessions";
import { withActionCache } from "../idempotency/action";
import { getOutletByCode, insertOutletRow } from "../outlets/lib";
import { cloneCatalogRows } from "../catalog/lib";
import { cloneSettingsRow, seedSettingsRow } from "../settings/lib";
import { grantOutletAccessRow } from "../auth/grantAccess";
import { logAudit } from "../audit/internal";

const settingsArg = v.object({
  receipt_business_name: v.optional(v.string()),
  receipt_address: v.optional(v.string()),
  receipt_contact: v.optional(v.string()),
  receipt_instagram_handle: v.optional(v.string()),
  receipt_footer_text: v.optional(v.string()),
  manual_bca_enabled: v.optional(v.boolean()),
  manual_bca_bank_name: v.optional(v.string()),
  manual_bca_account_name: v.optional(v.string()),
  manual_bca_account_number: v.optional(v.string()),
  founders_summary_enabled: v.optional(v.boolean()),
  txn_ticker_enabled: v.optional(v.boolean()),
});

/**
 * Atomic clone-or-blank outlet creation.
 * Any throw (OUTLET_CODE_TAKEN, SOURCE_OUTLET_REQUIRED, or any helper error)
 * rolls back ALL writes inside the transaction — Convex mutation semantics.
 *
 * Returns { outlet_id } on success.
 */
export const _createOutletAtomic_internal = internalMutation({
  args: {
    ownerStaffId: v.id("staff"),
    mode: v.union(v.literal("blank"), v.literal("clone")),
    source_outlet_id: v.optional(v.id("outlets")),
    name: v.string(),
    code: v.string(),
    address: v.optional(v.string()),
    geo: v.optional(v.object({ lat: v.number(), lng: v.number() })),
    timezone: v.string(),
    settings: settingsArg,
    staff_ids: v.array(v.id("staff")),
    provision_managers_chat: v.boolean(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // 1. Duplicate-code guard — runs BEFORE any write so a clean error is thrown
    //    and no partial rows are left on rollback.
    const dup = await getOutletByCode(ctx, args.code);
    if (dup) throw new Error("OUTLET_CODE_TAKEN");
    if (args.mode === "clone" && !args.source_outlet_id) {
      throw new Error("SOURCE_OUTLET_REQUIRED");
    }

    // 2. Create the outlet row (created_by REQUIRED per schema + ADR-034).
    const outlet_id = await insertOutletRow(ctx, {
      code: args.code,
      name: args.name,
      address: args.address,
      geo: args.geo,
      timezone: args.timezone,
      active: true,
      created_at: now,
      created_by: args.ownerStaffId,
    });

    // 3. Catalog + settings — branching by mode.
    let counts = { skus: 0, products: 0, components: 0 };
    if (args.mode === "clone") {
      // cloneCatalogRows copies active SKUs, products, and components only.
      // It never touches pos_stock_levels or pos_stock_movements — stock is NOT cloned.
      counts = await cloneCatalogRows(ctx, {
        sourceOutletId: args.source_outlet_id!,
        targetOutletId: outlet_id,
        now,
      });
      await cloneSettingsRow(ctx, {
        sourceOutletId: args.source_outlet_id!,
        targetOutletId: outlet_id,
        now,
        ownerStaffId: args.ownerStaffId,
        overrides: args.settings,
      });
    } else {
      // blank: seed a minimal settings row with any overrides supplied.
      await seedSettingsRow(ctx, {
        targetOutletId: outlet_id,
        now,
        ownerStaffId: args.ownerStaffId,
        values: args.settings,
      });
    }

    // 4. Grant staff access. The owner's own access is implicit — skip to avoid
    //    a redundant row and keep the audit metadata honest.
    let granted = 0;
    for (const sid of args.staff_ids) {
      if (String(sid) === String(args.ownerStaffId)) continue;
      const result = await grantOutletAccessRow(ctx, {
        staffId: sid,
        outletId: outlet_id,
        grantedBy: args.ownerStaffId,
        now,
      });
      if (result.created) granted++;
    }

    // 5. Single audit row records the entire clone/blank operation.
    await logAudit(ctx, {
      actor_id: args.ownerStaffId,
      action: "outlet.created",
      entity_type: "outlets",
      entity_id: outlet_id,
      source: "cockpit",
      metadata: {
        mode: args.mode,
        source_outlet_id: args.source_outlet_id ?? null,
        code: args.code,
        cloned_counts: counts,
        staff_granted: granted,
        provision_managers_chat: args.provision_managers_chat,
      },
    });

    return { outlet_id };
  },
});

// ── Public cockpit API ────────────────────────────────────────────────────────

/**
 * List all active outlets. Owner-cockpit gated.
 * Routes through internal._listActiveOutlets_internal — cockpit is NOT
 * allowlisted for raw outlets ctx.db access (ADR-034 fence compliance).
 */
export const listOutlets = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, { sessionId }): Promise<{ _id: Id<"outlets">; code: string; name: string; address?: string; timezone: string; active: boolean; created_at: number }[]> => {
    await requireCockpitSession(ctx, sessionId);
    const rows = await ctx.runQuery(
      internal.outlets.internal._listActiveOutlets_internal,
      {},
    );
    return rows.map((o) => ({
      _id: o._id,
      code: o.code,
      name: o.name,
      address: o.address,
      timezone: o.timezone,
      active: o.active,
      created_at: o.created_at,
    }));
  },
});

/**
 * List all active staff eligible for outlet assignment. Owner-cockpit gated.
 * Routes through _listAssignableStaff_internal — NO pin_hash in the response.
 */
export const listAssignableStaff = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, { sessionId }): Promise<{ _id: Id<"staff">; name: string; code: string; role: "staff" | "manager" | "owner" }[]> => {
    await requireCockpitSession(ctx, sessionId);
    return ctx.runQuery(internal.staff.internal._listAssignableStaff_internal, {});
  },
});

/**
 * Create a new outlet (blank or clone). Owner-cockpit gated, idempotent via
 * withActionCache. authCheck runs BEFORE the cache lookup (ADR-046).
 *
 * Returns { outlet_id } on success; subsequent calls with the same
 * idempotencyKey short-circuit to the cached result.
 */
export const createOutlet = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    mode: v.union(v.literal("blank"), v.literal("clone")),
    source_outlet_id: v.optional(v.id("outlets")),
    name: v.string(),
    code: v.string(),
    address: v.optional(v.string()),
    geo: v.optional(v.object({ lat: v.number(), lng: v.number() })),
    timezone: v.string(),
    settings: settingsArg,
    staff_ids: v.array(v.id("staff")),
    provision_managers_chat: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ outlet_id: string }> =>
    withActionCache<{ outlet_id: string }>(
      ctx,
      { key: args.idempotencyKey, mutationName: "cockpit.createOutlet" },
      // ADR-046: authCheck runs BEFORE cache lookup so a spent key cannot be
      // replayed by a caller whose cockpit session has since expired.
      async () => {
        await ctx.runQuery(
          internal.auth.ownerInternal._assertCockpitSession_internal,
          { sessionId: args.sessionId },
        );
      },
      async () => {
        const { staffId } = await ctx.runQuery(
          internal.auth.ownerInternal._assertCockpitSession_internal,
          { sessionId: args.sessionId },
        );
        return ctx.runMutation(
          internal.cockpit.outlets._createOutletAtomic_internal,
          {
            ownerStaffId: staffId,
            mode: args.mode,
            source_outlet_id: args.source_outlet_id,
            name: args.name,
            code: args.code,
            address: args.address,
            geo: args.geo,
            timezone: args.timezone,
            settings: args.settings,
            staff_ids: args.staff_ids,
            provision_managers_chat: args.provision_managers_chat,
          },
        );
      },
    ),
});

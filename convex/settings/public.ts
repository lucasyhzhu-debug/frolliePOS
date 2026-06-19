import { v } from "convex/values";
import { query, mutation } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireManagerSession, requireSession } from "../auth/sessions";
import { logAudit } from "../audit/internal";
import { withIdempotency } from "../idempotency/internal";

// Intentionally unauthenticated — returns only two non-sensitive notification
// booleans (not PII/financial). The toggle components need this before the
// manager session resolves (Switch stays disabled until loaded).
export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("pos_settings").first();
    return {
      founders_summary_enabled: row?.founders_summary_enabled ?? true,
      txn_ticker_enabled: row?.txn_ticker_enabled ?? true,
    };
  },
});

// withIdempotency serializes the handler return via JSON.stringify so the
// cache row's response_blob is non-null. Match the chatRegistry mgr* shape.
type ToggleResult = { ok: true };

export const setFoundersSummaryEnabled = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    enabled: v.boolean(),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      enabled: boolean;
    },
    ToggleResult
  >(
    "settings.setFoundersSummaryEnabled",
    async (ctx, args) => {
      // Re-resolve the session inside the handler so the staffId for audit
      // attribution comes from the validated session. authCheck (below) has
      // already proven manager-ness; this read is the typed source for staffId.
      const { staffId } = await requireManagerSession(ctx, args.sessionId);
      const row = await ctx.db.query("pos_settings").first();
      if (row) {
        await ctx.db.patch(row._id, {
          founders_summary_enabled: args.enabled,
          updated_at: Date.now(),
          updated_by: staffId,
        });
      } else {
        // txn_ticker_enabled defaults to true on a fresh row, symmetric with
        // setTxnTickerEnabled defaulting founders_summary_enabled to true.
        await ctx.db.insert("pos_settings", {
          founders_summary_enabled: args.enabled,
          txn_ticker_enabled: true,
          updated_at: Date.now(),
          updated_by: staffId,
        });
      }
      await logAudit(ctx, {
        actor_id: staffId,
        action: "settings.founders_summary_toggled",
        entity_type: "pos_settings",
        source: "booth_inline",
        metadata: { enabled: args.enabled },
      });
      return { ok: true as const };
    },
    {
      // Gate the cache lookup itself so a same-key replay from a non-manager
      // session can't read back the cached {ok:true} without authn (the
      // cache lookup runs BEFORE the handler). Precedent: staff/public.ts
      // issueDeviceSetupCode.
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

export const setTxnTickerEnabled = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    enabled: v.boolean(),
  },
  handler: withIdempotency<
    { idempotencyKey: string; sessionId: Id<"staff_sessions">; enabled: boolean },
    ToggleResult
  >(
    "settings.setTxnTickerEnabled",
    async (ctx, args) => {
      const { staffId } = await requireManagerSession(ctx, args.sessionId);
      const row = await ctx.db.query("pos_settings").first();
      if (row) {
        await ctx.db.patch(row._id, {
          txn_ticker_enabled: args.enabled,
          updated_at: Date.now(),
          updated_by: staffId,
        });
      } else {
        // Schema requires founders_summary_enabled (non-optional) + updated_at on
        // insert. Default founders to true so creating the row via THIS toggle does
        // not silently disable the founders summary (mirrors updateReceiptConfig).
        await ctx.db.insert("pos_settings", {
          founders_summary_enabled: true,
          txn_ticker_enabled: args.enabled,
          updated_at: Date.now(),
          updated_by: staffId,
        });
      }
      await logAudit(ctx, {
        actor_id: staffId,
        action: "settings.txn_ticker_toggled",
        entity_type: "pos_settings",
        source: "booth_inline",
        metadata: { enabled: args.enabled },
      });
      return { ok: true as const };
    },
    {
      // ADR-013: a same-key replay from a non-manager session must not read
      // back the cached {ok:true} — authCheck runs before the cache lookup.
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

// ─── Receipt config (v0.5.3b T11) ───────────────────────────────────────────
// Manager-only CRUD over the receipt sub-object of pos_settings. Reads via
// _getSettings_internal so defaults stay single-sourced (RECEIPT_DEFAULTS).
// Writes patch the singleton row (insert when absent). Logo is a _storage
// blob — `getReceiptConfig` resolves a download URL for the UI.

// Explicit return type breaks the cross-module ctx.runQuery type cycle that
// otherwise trips TS7022 (`implicitly has type 'any'`). Same pattern used by
// transactions/public.ts listDayTransactions / dashboardSummary.
type ReceiptConfigView = {
  business_name: string;
  address: string;
  contact: string;
  instagram_handle: string;
  footer_text: string;
  logo_storage_id: Id<"_storage"> | null;
  logo_url: string | null;
};

export const getReceiptConfig = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args): Promise<ReceiptConfigView> => {
    await requireManagerSession(ctx, args.sessionId);
    const s = await ctx.runQuery(
      internal.settings.internal._getSettings_internal,
      {},
    );
    const logo_url = s.receipt.logo_storage_id
      ? await ctx.storage.getUrl(s.receipt.logo_storage_id)
      : null;
    return {
      business_name: s.receipt.business_name,
      address: s.receipt.address,
      contact: s.receipt.contact,
      instagram_handle: s.receipt.instagram_handle,
      footer_text: s.receipt.footer_text,
      logo_storage_id: s.receipt.logo_storage_id,
      logo_url,
    };
  },
});

type GenerateLogoUploadUrlResult = { uploadUrl: string };

export const generateLogoUploadUrl = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
  },
  handler: withIdempotency<
    { idempotencyKey: string; sessionId: Id<"staff_sessions"> },
    GenerateLogoUploadUrlResult
  >(
    "settings.generateLogoUploadUrl",
    async (ctx) => {
      // Idempotency caches the URL so a network retry of the same key returns
      // the same upload target. Upload URLs are short-lived but valid for the
      // typical retry window; this matches the plan's spec.
      const uploadUrl = await ctx.storage.generateUploadUrl();
      return { uploadUrl };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

type UpdateReceiptConfigResult = { ok: true };

export const updateReceiptConfig = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    business_name: v.string(),
    address: v.string(),
    contact: v.string(),
    instagram_handle: v.string(),
    footer_text: v.string(),
    logo_storage_id: v.optional(v.id("_storage")),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      business_name: string;
      address: string;
      contact: string;
      instagram_handle: string;
      footer_text: string;
      logo_storage_id?: Id<"_storage">;
    },
    UpdateReceiptConfigResult
  >(
    "settings.updateReceiptConfig",
    async (ctx, args) => {
      const { staffId: mgrId } = await requireManagerSession(ctx, args.sessionId);
      // Bound each user-supplied receipt string at 120 chars — keeps printed
      // receipts visually sane; UI Task 16 mirrors this bound client-side.
      for (const [k, val] of Object.entries({
        business_name: args.business_name,
        address: args.address,
        contact: args.contact,
        instagram_handle: args.instagram_handle,
        footer_text: args.footer_text,
      })) {
        if (val.length > 120) throw new Error(`FIELD_TOO_LONG:${k}`);
      }
      const patch = {
        receipt_business_name: args.business_name,
        receipt_address: args.address,
        receipt_contact: args.contact,
        receipt_instagram_handle: args.instagram_handle,
        receipt_footer_text: args.footer_text,
        ...(args.logo_storage_id !== undefined
          ? { receipt_logo_storage_id: args.logo_storage_id }
          : {}),
        updated_at: Date.now(),
        updated_by: mgrId,
      };
      const row = await ctx.db.query("pos_settings").first();
      if (row) {
        await ctx.db.patch(row._id, patch);
      } else {
        await ctx.db.insert("pos_settings", {
          founders_summary_enabled: true,
          ...patch,
        });
      }
      // Purge the receipt HTML cache so the next /r/<token> render picks up
      // the new branding. Full-scan delete is fine at v1 scale; see
      // _purgeAllReceiptCache_internal for the upgrade path. Placed AFTER
      // the patch/insert so a partial failure doesn't blow the cache for an
      // un-applied change; placed BEFORE logAudit because the audit row just
      // captures *that* the update happened.
      await ctx.runMutation(
        internal.receipts.internal._purgeAllReceiptCache_internal,
        {},
      );
      await logAudit(ctx, {
        actor_id: mgrId,
        action: "settings.receipt_updated",
        entity_type: "pos_settings",
        source: "booth_inline",
        metadata: { logo_changed: args.logo_storage_id !== undefined },
      });
      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

// ─── Manual-BCA account config (v1.2 #10 T4) ─────────────────────────────────
// Manager-only CRUD + staff-readable read over the manual_bca sub-object of
// pos_settings. Reads via _getSettings_internal so defaults stay single-sourced
// (MANUAL_BCA_DEFAULTS). Mirrors the receipt-config pattern above.

// Explicit return type breaks the cross-module ctx.runQuery type cycle (TS7022).
type ManualBcaView = {
  enabled: boolean;
  bank_name: string;
  account_name: string;
  account_number: string;
};

// Both reads return the same view (defaults single-sourced in _getSettings_internal);
// they differ only in the auth gate, so share the read body.
async function readManualBca(ctx: QueryCtx): Promise<ManualBcaView> {
  const s = await ctx.runQuery(
    internal.settings.internal._getSettings_internal,
    {},
  );
  return { ...s.manual_bca };
}

/** Manager-only read — settings screen. */
export const getManualBcaConfig = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args): Promise<ManualBcaView> => {
    await requireManagerSession(ctx, args.sessionId);
    return readManualBca(ctx);
  },
});

/** Any active staff — charge screen displays account details to customer. */
export const getManualBcaAccount = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args): Promise<ManualBcaView> => {
    await requireSession(ctx, args.sessionId);
    return readManualBca(ctx);
  },
});

// NOTE: there is intentionally NO public mutation to WRITE the manual-BCA account
// — it is a money destination and must not be editable from any client surface.
// The writer is `settings.internal._updateManualBcaConfig_internal` (internalMutation,
// dashboard/CLI/ops only). Managers may VIEW via getManualBcaConfig above.

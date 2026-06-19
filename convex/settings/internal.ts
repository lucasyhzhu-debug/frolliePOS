import { internalQuery, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { logAudit } from "../audit/internal";

// Receipt-config defaults — equal to the pre-v0.5.3b hardcoded values so an
// absent/partial pos_settings row renders receipts identically to before.
export const RECEIPT_DEFAULTS = {
  business_name: "FROLLIE",
  address: "Pakuwon Mall, Surabaya",
  contact: "+62 821-xxxx-xxxx · frollie.id",
  instagram_handle: "@frollie.id",
  footer_text: "Terima kasih! 💛",
} as const;

// v1.2 #10 manual-BCA account defaults — the live company account. Editable via
// settings.public.updateManualBcaConfig; these are the fallback when the row /
// field is absent.
// POC tradeoff: a real money destination (account number) is hardcoded as the
// read-time default so the booth works out-of-the-box with zero config, exactly
// mirroring RECEIPT_DEFAULTS. Acceptable for a single-booth internal tool where
// the account is the company's own and a manager can override via /mgr. If this
// pattern ever serves multiple tenants, the default must move to per-tenant
// config (a hardcoded payout account is a cross-tenant hazard).
export const MANUAL_BCA_DEFAULTS = {
  enabled: true,
  bank_name: "BCA",
  account_name: "PT Malo Group Bahagia",
  account_number: "6044830994",
} as const;

export const _getSettings_internal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("pos_settings").first();
    return {
      founders_summary_enabled: row?.founders_summary_enabled ?? true,
      // v1.0.1: read-time default true — no migration needed for existing prod row
      txn_ticker_enabled: row?.txn_ticker_enabled ?? true,
      receipt: {
        business_name: row?.receipt_business_name ?? RECEIPT_DEFAULTS.business_name,
        address: row?.receipt_address ?? RECEIPT_DEFAULTS.address,
        contact: row?.receipt_contact ?? RECEIPT_DEFAULTS.contact,
        instagram_handle: row?.receipt_instagram_handle ?? RECEIPT_DEFAULTS.instagram_handle,
        footer_text: row?.receipt_footer_text ?? RECEIPT_DEFAULTS.footer_text,
        logo_storage_id: row?.receipt_logo_storage_id ?? null,
      },
      manual_bca: {
        enabled: row?.manual_bca_enabled ?? MANUAL_BCA_DEFAULTS.enabled,
        bank_name: row?.manual_bca_bank_name ?? MANUAL_BCA_DEFAULTS.bank_name,
        account_name: row?.manual_bca_account_name ?? MANUAL_BCA_DEFAULTS.account_name,
        account_number: row?.manual_bca_account_number ?? MANUAL_BCA_DEFAULTS.account_number,
      },
    };
  },
});

/**
 * v1.2 #10 (hardened) — write the static manual-BCA settlement account.
 *
 * INTERNAL-ONLY by design: the account is a money destination, so it must NOT be
 * editable from any client surface. There is no public mutation and no booth UI —
 * the only callers are the Convex dashboard / `npx convex run` (ops, deploy-key
 * gated) and trusted server code. This closes the redirect-the-payout vector a
 * manager-session public mutation would have left open. Managers may still VIEW
 * the config via settings.public.getManualBcaConfig (read-only).
 *
 * Audited as `actor_id:"system"` / `source:"system"` (no booth session on this
 * path). Validation mirrors the prior public writer (≤120 chars, non-blank).
 */
export const _updateManualBcaConfig_internal = internalMutation({
  args: {
    enabled: v.boolean(),
    bank_name: v.string(),
    account_name: v.string(),
    account_number: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    for (const [k, val] of Object.entries({
      bank_name: args.bank_name,
      account_name: args.account_name,
      account_number: args.account_number,
    })) {
      if (val.length > 120) throw new Error(`FIELD_TOO_LONG:${k}`);
      if (val.trim().length === 0) throw new Error(`FIELD_REQUIRED:${k}`);
    }
    const patch = {
      manual_bca_enabled: args.enabled,
      manual_bca_bank_name: args.bank_name,
      manual_bca_account_name: args.account_name,
      manual_bca_account_number: args.account_number,
      updated_at: Date.now(),
    };
    const row = await ctx.db.query("pos_settings").first();
    if (row) {
      await ctx.db.patch(row._id, patch);
    } else {
      await ctx.db.insert("pos_settings", { founders_summary_enabled: true, ...patch });
    }
    await logAudit(ctx, {
      actor_id: "system",
      action: "settings.manual_bca_updated",
      entity_type: "pos_settings",
      source: "system",
      metadata: { enabled: args.enabled, via: "backend" },
    });
    return { ok: true as const };
  },
});

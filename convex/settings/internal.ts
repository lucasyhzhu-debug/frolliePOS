import { internalQuery } from "../_generated/server";

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

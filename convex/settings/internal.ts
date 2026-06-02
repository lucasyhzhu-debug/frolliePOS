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

export const _getSettings_internal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("pos_settings").first();
    return {
      founders_summary_enabled: row?.founders_summary_enabled ?? true,
      receipt: {
        business_name: row?.receipt_business_name ?? RECEIPT_DEFAULTS.business_name,
        address: row?.receipt_address ?? RECEIPT_DEFAULTS.address,
        contact: row?.receipt_contact ?? RECEIPT_DEFAULTS.contact,
        instagram_handle: row?.receipt_instagram_handle ?? RECEIPT_DEFAULTS.instagram_handle,
        footer_text: row?.receipt_footer_text ?? RECEIPT_DEFAULTS.footer_text,
        logo_storage_id: row?.receipt_logo_storage_id ?? null,
      },
    };
  },
});

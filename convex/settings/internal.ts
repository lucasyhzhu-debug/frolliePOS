import { internalQuery } from "../_generated/server";

export const _getSettings_internal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("pos_settings").first();
    return { founders_summary_enabled: row?.founders_summary_enabled ?? true };
  },
});

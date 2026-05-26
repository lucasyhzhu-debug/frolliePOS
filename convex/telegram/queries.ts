import { query } from "../_generated/server";

export const listRecentLog = query({
  args: {},
  handler: async (ctx) => {
    // by_created_at returns oldest-first; we want newest-first, capped at 30.
    return await ctx.db
      .query("telegram_log")
      .withIndex("by_created_at")
      .order("desc")
      .take(30);
  },
});

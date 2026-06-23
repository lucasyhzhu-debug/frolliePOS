// V8-safe — no "use node". Uses runQuery/runAction only (no Node built-ins).

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal, api } from "../_generated/api";

export const sendErrorAlert = internalAction({
  args: { reportId: v.id("pos_error_reports") },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true } | { skipped: "role_unbound" } | { skipped: "not_found" }> => {
    const report = await ctx.runQuery(internal.ops.internal._getErrorReport_internal, {
      reportId: args.reportId,
    });
    if (!report) return { skipped: "not_found" };

    // Narrow-catch role resolve (ownersSummary.ts pattern): unbound → skip,
    // transient/unknown → rethrow so the platform surfaces it.
    let chatId: string;
    try {
      chatId = await ctx.runQuery(
        internal.telegram.chatRegistry.internal.getChatIdByRole,
        { role: "ops" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No Telegram chat assigned to role")) return { skipped: "role_unbound" };
      throw err;
    }

    await ctx.runAction(api.telegram.send.sendTemplate, {
      role: "ops",
      kind: "system_error",
      payload: {
        kind: report.kind,
        message: report.message,
        route: report.route,
        staff_code: report.staff_code,
        device_id: report.device_id,
        app_version: report.app_version,
        occurred_at: report.created_at,
      },
      idempotencyKey: `ops_error:${args.reportId}`,
      chatIdOverride: chatId,
      // loud — operators must be notified
    });
    return { ok: true };
  },
});

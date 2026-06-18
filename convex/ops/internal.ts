import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorSignature, truncate, MESSAGE_MAX, STACK_MAX,
  DEDUP_WINDOW_MS, GLOBAL_ALERT_COOLDOWN_MS,
} from "./lib";

export const _recordError_internal = internalMutation({
  args: {
    kind: v.union(
      v.literal("crash"), v.literal("unhandled"), v.literal("payment"),
      v.literal("mutation"), v.literal("backend"),
    ),
    message: v.string(),
    stack: v.optional(v.string()),
    route: v.optional(v.string()),
    staff_code: v.optional(v.string()),
    device_id: v.optional(v.string()),
    online: v.optional(v.boolean()),
    app_version: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const signature = errorSignature({ kind: args.kind, route: args.route, message: args.message });

    // Dedup: any same-signature row within the window suppresses the alert.
    const recentSame = await ctx.db
      .query("pos_error_reports")
      .withIndex("by_signature_created", (q) =>
        q.eq("signature", signature).gte("created_at", now - DEDUP_WINDOW_MS),
      )
      .first();

    // Storm cap: most recent alerted row within global cooldown suppresses the alert.
    const lastAlerted = await ctx.db
      .query("pos_error_reports")
      .withIndex("by_created")
      .order("desc")
      .filter((q) => q.eq(q.field("alerted"), true))
      .first();
    const stormCapped =
      lastAlerted !== null && now - lastAlerted.created_at < GLOBAL_ALERT_COOLDOWN_MS;

    const alerted = recentSame === null && !stormCapped;

    const reportId = await ctx.db.insert("pos_error_reports", {
      kind: args.kind,
      message: truncate(args.message, MESSAGE_MAX),
      stack: args.stack ? truncate(args.stack, STACK_MAX) : undefined,
      route: args.route,
      staff_code: args.staff_code,
      device_id: args.device_id,
      online: args.online,
      app_version: args.app_version,
      signature,
      alerted,
      created_at: now,
    });

    if (alerted) {
      await ctx.scheduler.runAfter(0, internal.ops.actions.sendErrorAlert, { reportId });
    }
  },
});

export const _getErrorReport_internal = internalQuery({
  args: { reportId: v.id("pos_error_reports") },
  handler: async (ctx, args) => ctx.db.get(args.reportId),
});

import { v } from "convex/values";
import { query, mutation } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { requireManagerSession } from "../auth/sessions";
import { logAudit } from "../audit/internal";
import { withIdempotency } from "../idempotency/internal";

export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("pos_settings").first();
    return { founders_summary_enabled: row?.founders_summary_enabled ?? true };
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
        await ctx.db.insert("pos_settings", {
          founders_summary_enabled: args.enabled,
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

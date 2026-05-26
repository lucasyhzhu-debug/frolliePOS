import { query } from "../_generated/server";
import { v } from "convex/values";
import { requireManagerSession } from "../auth/sessions";
import { auditListHandler } from "./internal";

/** Public audit log — manager session required. */
export const list = query({
  args: {
    sessionId: v.id("staff_sessions"),
    limit: v.optional(v.number()),
    action: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireManagerSession(ctx, args.sessionId);
    return auditListHandler(ctx, args);
  },
});

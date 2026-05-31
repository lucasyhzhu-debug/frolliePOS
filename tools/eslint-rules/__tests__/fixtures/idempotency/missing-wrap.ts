import { mutation } from "/convex/foo/public.ts";
import { v } from "convex/values";
export const doThing = mutation({
  args: { idempotencyKey: v.string() },
  handler: async (_ctx, _args) => ({ ok: true }),
});

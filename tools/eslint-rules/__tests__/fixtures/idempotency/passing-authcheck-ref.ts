// fixture: passes — authCheck is a variable reference (extracted shared function)
import { mutation } from "/convex/foo/public.ts";
import { v } from "convex/values";

declare const withIdempotency: any;
declare const sharedAuthCheck: (ctx: any, args: any) => Promise<void>;

export const doThing = mutation({
  args: { idempotencyKey: v.string() },
  handler: withIdempotency("foo.doThing", async (_ctx, _args) => ({ ok: true }), {
    authCheck: sharedAuthCheck,
  }),
});

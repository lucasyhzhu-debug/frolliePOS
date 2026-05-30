// fixture: passes all three assertions
import { mutation } from "/convex/foo/public.ts";  // path is fictional — fixture content only
import { v } from "convex/values";

declare const withIdempotency: any;

export const doThing = mutation({
  args: { idempotencyKey: v.string() },
  handler: withIdempotency("foo.doThing", async (_ctx, _args) => ({ ok: true }), {
    authCheck: async (_ctx, _args) => {},
  }),
});

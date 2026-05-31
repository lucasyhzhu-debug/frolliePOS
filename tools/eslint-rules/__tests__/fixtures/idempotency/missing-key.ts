import { mutation } from "/convex/foo/public.ts";
import { v } from "convex/values";
declare const withIdempotency: any;
export const doThing = mutation({
  args: { value: v.number() },
  handler: withIdempotency("foo.doThing", async () => ({ ok: true }), { authCheck: async () => {} }),
});

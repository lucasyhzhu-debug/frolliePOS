// fixture: same shape as missing-authcheck.ts, but at a nested module path
import { mutation } from "/convex/foo/bar/public.ts";
import { v } from "convex/values";
declare const withIdempotency: any;
export const doThing = mutation({
  args: { idempotencyKey: v.string() },
  handler: withIdempotency("foo.bar.doThing", async () => ({ ok: true })),
});

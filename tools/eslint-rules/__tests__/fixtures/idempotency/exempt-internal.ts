import { internalMutation } from "/convex/foo/internal.ts";
import { v } from "convex/values";
export const doThing = internalMutation({
  args: { value: v.number() },
  handler: async (_ctx, _args) => ({ ok: true }),
});

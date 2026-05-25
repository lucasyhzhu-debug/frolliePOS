import { internalMutation, internalQuery, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

const TTL_MS = 24 * 60 * 60 * 1000; // 24h per ADR-013

/**
 * Wrap a mutation handler so the same idempotencyKey replays the stored response
 * instead of re-executing. Public mutations MUST go through this. See ADR-013.
 *
 * Errors are NOT cached in v0.2 — a handler that throws does not write to
 * pos_idempotency, so a retry with the same key re-executes. This is the
 * intentional v0.2 behavior; v0.3 may revisit (e.g. cache distinct error
 * codes that should NOT be retried) once payments expose the tradeoff.
 *
 * If `staffIdFromArgs` is provided, the resolved staff_id is stored on the
 * idempotency row for debugging. Pre-auth mutations (e.g. activateDevice)
 * omit it.
 */
export function withIdempotency<Args extends { idempotencyKey: string }, R>(
  mutationName: string,
  handler: (ctx: MutationCtx, args: Args) => Promise<R>,
  options: {
    staffIdFromArgs?: (args: Args) => Id<"staff"> | undefined;
  } = {},
) {
  return async (ctx: MutationCtx, args: Args): Promise<R> => {
    const cached = await ctx.db
      .query("pos_idempotency")
      .withIndex("by_key", (q) => q.eq("key", args.idempotencyKey))
      .unique();

    if (cached) {
      return JSON.parse(cached.response_blob) as R;
    }

    const response = await handler(ctx, args);

    await ctx.db.insert("pos_idempotency", {
      key: args.idempotencyKey,
      mutation_name: mutationName,
      staff_id: options.staffIdFromArgs?.(args),
      response_blob: JSON.stringify(response),
      expires_at: Date.now() + TTL_MS,
    });

    return response;
  };
}

/**
 * Internal lookup used by actions that want to short-circuit on cache hit
 * BEFORE running expensive work (argon2id verify, etc.). Not exposed publicly.
 */
export const _lookup_internal = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db
      .query("pos_idempotency")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    return row?.response_blob ?? null;
  },
});

// Test-only mutations. Both INTERNAL — never reachable from a public client.
export const __test_echo = internalMutation({
  args: { idempotencyKey: v.string(), value: v.number() },
  handler: withIdempotency<{ idempotencyKey: string; value: number }, { echoed: number }>(
    "__test_echo",
    async (_ctx, args) => ({ echoed: args.value }),
  ),
});

export const __test_throw = internalMutation({
  args: { idempotencyKey: v.string() },
  handler: withIdempotency<{ idempotencyKey: string }, never>(
    "__test_throw",
    async () => {
      throw new Error("boom");
    },
  ),
});

import { internalMutation, internalQuery, MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";

const TTL_MS = 24 * 60 * 60 * 1000; // 24h per ADR-013

/**
 * Wrap a mutation handler so the same idempotencyKey replays the stored response
 * instead of re-executing. Public mutations MUST go through this. See ADR-013.
 *
 * Errors are NOT cached — a handler that throws does NOT write to pos_idempotency.
 * Because the cache insert and all state changes live in the same Convex mutation
 * transaction, a throw rolls back everything atomically. A retry with the same key
 * re-executes from scratch (no partial commit, no phantom cache row).
 *
 * If `staffIdFromArgs` is provided, the resolved staff_id is stored on the
 * idempotency row for debugging. Pre-auth mutations (e.g. activateDevice)
 * omit it.
 *
 * ─── ACTION-LEVEL IDEMPOTENCY PATTERN (v0.3+) ───────────────────────────────
 *
 * Actions that perform side-effecting HTTP (Xendit Invoice creation, Telegram
 * sends) cannot be wrapped by `withIdempotency` directly — actions are not
 * transactions. Instead, they use a three-step pattern:
 *
 *   1. Pre-check: call `ctx.runQuery(internal.idempotency.internal._lookup_internal,
 *      { key: args.idempotencyKey })`. On cache hit, parse and return immediately
 *      without re-running HTTP or re-committing Convex state.
 *
 *   2. Upstream idempotency: pass `X-IDEMPOTENCY-KEY: args.idempotencyKey` to the
 *      upstream API where supported. Xendit's Invoice API deduplicates on this
 *      header — a network retry re-fires HTTP safely and Xendit returns the same
 *      invoice object.
 *
 *   3. Atomic commit: call `ctx.runMutation(internal.<domain>.internal.<commitFn>,
 *      { idempotencyKey: args.idempotencyKey, ...payload })` where `<commitFn>`
 *      is wrapped with `withIdempotency`. The wrapper writes the cache row in the
 *      same transaction as all Convex state changes (transaction lines, stock
 *      decrements, audit rows). Either everything commits together or nothing does.
 *
 * Net guarantee for a full action call:
 *   • First call  → HTTP fires + Convex state + cache row commit atomically.
 *   • Network retry → HTTP re-fires (Xendit deduplication absorbs it) + commit
 *     mutation detects existing cache row → returns cached response immediately
 *     without double-writing state.
 *   • Process restart before step 3 → no cache row → next call re-executes from
 *     step 1 (Xendit dedup prevents a second invoice; commit mutation runs clean).
 *
 * The `__test_echo_actionStyle` / `__test_echo_actionStyle_throws` mutations
 * below exercise steps 1–3 in isolation to verify the atomicity guarantee.
 */
export function withIdempotency<Args extends { idempotencyKey: string }, R>(
  mutationName: string,
  handler: (ctx: MutationCtx, args: Args) => Promise<R>,
  options: {
    staffIdFromArgs?: (args: Args) => Id<"staff"> | undefined;
    authCheck?: (ctx: MutationCtx, args: Args) => Promise<void>; // runs BEFORE cache lookup
  } = {},
) {
  return async (ctx: MutationCtx, args: Args): Promise<R> => {
    if (options.authCheck) {
      await options.authCheck(ctx, args);
    }

    const cached = await ctx.db
      .query("pos_idempotency")
      .withIndex("by_key", (q) => q.eq("key", args.idempotencyKey))
      .first(); // .first() tolerates duplicate rows; .unique() would throw

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
      .first(); // .first() tolerates duplicate rows; .unique() would throw
    return row?.response_blob ?? null;
  },
});

/**
 * Write a response into the idempotency cache from an action that has no other
 * Convex state to commit (e.g. payments.manuallyConfirmPayment — the paid
 * funnel already wrote the transaction/audit rows in its own mutation, so this
 * is a stand-alone cache write). Owned by the idempotency module so callers in
 * other modules don't write pos_idempotency directly (ADR-034 boundary).
 *
 * No-op if a row for `key` already exists (mirrors withIdempotency's guard);
 * the second writer simply observes the first writer's row.
 */
export const _writeCache_internal = internalMutation({
  args: { key: v.string(), mutationName: v.string(), response: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pos_idempotency")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (existing) return;
    await ctx.db.insert("pos_idempotency", {
      key: args.key,
      mutation_name: args.mutationName,
      response_blob: args.response,
      expires_at: Date.now() + TTL_MS,
    });
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

// ─── Action-level pattern test fixtures ──────────────────────────────────────
// These mutations simulate the "commit" step (step 3) of the action-level
// idempotency pattern: the action calls ctx.runMutation(...) with one of these,
// and the cache row is written atomically with any Convex state changes.

/** Happy-path: simulates a commit mutation called by an action after HTTP succeeds — the handler body is intentionally minimal; the test exercises the harness contract, not domain logic. */
export const __test_echo_actionStyle = internalMutation({
  args: { idempotencyKey: v.string(), value: v.number() },
  handler: withIdempotency<{ idempotencyKey: string; value: number }, { echoed: number }>(
    "__test_echo_actionStyle",
    async (_ctx, args) => ({ echoed: args.value }),
  ),
});

/**
 * Crash-after-work: simulates an action commit mutation that throws AFTER doing
 * work. Verifies that the cache row and any state changes are rolled back together
 * (atomicity guarantee). A retry should re-execute from scratch.
 */
export const __test_echo_actionStyle_throws = internalMutation({
  args: { idempotencyKey: v.string(), value: v.number() },
  handler: withIdempotency<{ idempotencyKey: string; value: number }, { echoed: number }>(
    "__test_echo_actionStyle_throws",
    async (_ctx, args) => {
      if (args.value > 0) throw new Error("simulated post-work crash");
      return { echoed: args.value };
    },
  ),
});

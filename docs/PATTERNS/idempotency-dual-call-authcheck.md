# Pattern: idempotency-dual-call authCheck

**Added:** v0.5.0 (2026-05-31)
**Enforced by:** ESLint rule `idempotency-required` (`tools/eslint-rules/`)

## The rule

Every public mutation in `convex/<module>/public.ts` must:

1. Accept `idempotencyKey: v.string()` in its args validator.
2. Wrap its handler in `withIdempotency(ctx, args, handler, options)`.
3. Pass an `authCheck` function in the `options` object.
4. RE-CALL `require*Session(ctx, args.sessionId)` (or the appropriate auth helper) **inside the handler body** to obtain the typed session.

```typescript
// CORRECT pattern
export const myMutation = mutation({
  args: {
    sessionId: v.string(),
    idempotencyKey: v.string(),
    // ... domain args
  },
  handler: withIdempotency<
    { sessionId: Id<"staff_sessions">; idempotencyKey: string; /* ... */ },
    ReturnType,
  >(
    "module.myMutation",  // mutation_name for the idempotency cache key
    async (ctx, args) => {
      // Re-call inside the handler — this is intentional and load-bearing
      const session = await requireSession(ctx, args.sessionId);
      // ... domain logic
    },
    {
      authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); },
    },
  ),
});
```

## Why there are two calls to `requireSession`

This looks like duplication. It is not. The two calls serve different roles:

### The `authCheck` slot (runs BEFORE the cache lookup)

`withIdempotency` checks `authCheck` **before** reading the `pos_idempotency` table. If the caller is not authenticated, the function throws — no cached response is returned.

Without this guard, a caller who knows a valid `idempotencyKey` from a **previous** authorized request could replay the cached response without a valid session. Example attack:

1. Authorized staffer calls `confirmPayment(txId, idempotencyKey: "abc123")` → succeeds, cached.
2. Session expires (staffer locks the device).
3. Attacker (knowing `"abc123"`) calls `confirmPayment(txId, idempotencyKey: "abc123")` with no session → without `authCheck`, the cache would happily return the success response.

`authCheck` closes this hole. The cache is only consulted after the auth check passes.

### The inline `requireSession` call (runs AFTER the cache lookup)

Once the cache check misses (first call, or expired dedupe window), the handler body runs. The handler needs the session object to perform domain logic (e.g. read `session.staffId`, check `session.role`).

The `authCheck` slot returns `void` — it either throws or passes. It does **not** return the session for the handler to use. Hence the handler must call `requireSession` again.

This second call is cheap: it is one indexed query against `staff_sessions` on `[_id]`, which Convex executes in a single BTree lookup. There is no network round-trip; it is in-process within the mutation's transaction.

## Why not collapse them

The mechanical duplication is the point. ESLint enforces the presence of both. If you were to collapse by, e.g., hoisting a shared session variable outside the `withIdempotency` call, you would either:

- Move the `requireSession` call before `withIdempotency`, which means auth runs before the idempotency harness has a chance to intercept — breaking the contract order; or
- Remove `authCheck` from the options and rely solely on the inline call, which re-opens the replay attack.

The two-call pattern is the cheapest structure that is both correct and mechanically verifiable by a lint rule.

## Adding a new public mutation

```typescript
export const newMutation = mutation({
  args: {
    sessionId: v.string(),
    idempotencyKey: v.string(),
    myArg: v.string(),
  },
  handler: withIdempotency<
    { sessionId: Id<"staff_sessions">; idempotencyKey: string; myArg: string },
    { ok: true },
  >(
    "module.newMutation",
    async (ctx, args) => {
      const session = await requireSession(ctx, args.sessionId); // <-- inline re-call
      // domain logic here
      await logAudit(ctx, { ... });
      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); }, // <-- authCheck
    },
  ),
});
```

For manager-only mutations, replace both `requireSession` calls with `requireManagerSession`.

## The ESLint rule

`tools/eslint-rules/idempotency-required.js` checks:

- `idempotencyKey` is present in `args`.
- `withIdempotency` is called in the handler.
- The `options` object passed to `withIdempotency` contains an `authCheck` property.

It does **not** enforce the inline re-call (too hard to lint statically), but code review catches omissions because the handler won't compile without the session object.

## Related

- [ADR-013](../ADR/013-idempotency-keys.md) — idempotency key design
- [ADR-029](../ADR/029-token-authorizes-view-pin-authorizes-act.md) — token/PIN authority model (same defence-in-depth philosophy)
- `convex/idempotency/internal.ts` — `withIdempotency` implementation
- `convex/auth/sessions.ts` — `requireSession` / `requireManagerSession`

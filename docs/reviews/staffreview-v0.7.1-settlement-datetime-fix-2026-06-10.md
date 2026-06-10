# Staffreview — v0.7.1 settlement date-time fix

**Date:** 2026-06-10
**Branch:** `v0.7.1-settlement-datetime-fix` (uncommitted working tree; base == head, viewed via `git diff main -- convex/`)
**Lens:** Senior-engineer architectural review through ADR-034 (deep modules / surface APIs)
**Scope:** `convex/settlements/cronActions.ts`, `convex/settlements/__tests__/lookback.test.ts` (new), `convex/settlements/__tests__/sync.test.ts`, `convex/payments/__tests__/listTransactions.test.ts`

## Summary

**Verdict on module depth: net-neutral-to-positive — the change preserves the settlements module's depth; the only surface delta is one exported pure helper whose export is justified by the regression test it anchors, though it could equally live in `convex/lib/time.ts`.**

This is a correct ~15-line bug fix. The v0.7 settlement poll passed a bare `YYYY-MM-DD` to Xendit's `GET /transactions` `updated[gte]` param, which 400s with `updated/gte must match format "date-time"`. The fix replaces the private `wibDateNDaysAgo` helper (WIB-calendar `YYYY-MM-DD`) with an exported `settlementLookbackIso(now, lookbackDays)` returning a full RFC3339 UTC date-time. The mocked sync test (which bypasses the real fetch) gained a regression assertion so CI now catches the format class; a new `lookback.test.ts` pins the helper directly. All five touched tests pass. `wibDateLabel` remains used by `settlements/lib.ts`, so dropping its import from `cronActions.ts` leaves no orphan.

The fix is well-commented, V8-safe (no Buffer/Node), and the UTC-instant choice is architecturally correct for a `gte` lower bound. No graft risk. The findings below are about *where* the helper lives and one semantic-comment nicety — none block.

## Critical Issues

None.

## Improvements

### I1 — Helper location: cronActions.ts is defensible, but `convex/lib/time.ts` is the stronger home

The fix exports `settlementLookbackIso` from `cronActions.ts` so the new test can import it. Exporting is the right call over "exercise it only through the action": the action (`syncSettlements`) hits the live Xendit fetch, so testing the date-window contract through it requires a mock and an `expect.objectContaining` indirection (which the sync test already does as a *regression guard*). A direct unit test on a pure function is the cleaner primary assertion, and a pure helper that's imported is a smaller surface than an `internalAction` that's invoked. So: **export — yes.**

The open question is the *module*. `convex/lib/time.ts` is already the single owner of the "epoch → time string" idiom — its own docstring on `wibDateLabel` says it is "the single owner of the 'epoch → WIB date string' idiom that the settlement poll (cronActions lookback) and aggregator (lib) both need." The fix moves the lookback *out* of that ownership (cronActions no longer imports `wibDateLabel`), mildly contradicting that doc. `settlementLookbackIso` is `new Date(now - days*86_400_000).toISOString()` — a generic "epoch minus N days as RFC3339" with zero settlement-specific logic. It's a time util wearing a settlement-specific name.

**Recommendation (weak-preference, non-blocking):** move it to `convex/lib/time.ts` as a generically-named `isoDaysAgo(now, days)` (or `rfc3339DaysAgo`), and have `cronActions.ts` import it. Rationale: (a) `lib/time.ts` is the declared owner of epoch→string conversions and already V8-safe; (b) the name stops over-claiming domain specificity; (c) it keeps cronActions.ts a pure orchestration file with no inline date arithmetic, matching the file's own "we only call ctx.run* and the plain fetch helper" framing.

**Counter-argument for leaving it (also valid):** the lookback's *contract* is settlement-specific — the docstring explains the Xendit-400 reason and the "slightly inclusive lower bound for a `gte` window" semantics, which only make sense in the settlement-poll context. A generic `lib/time.ts` helper would shed that rationale or carry an out-of-place Xendit comment. Co-locating the helper with its only caller and its only justification is the Ousterhout "define errors/edge-cases where they're understood" instinct. If the team values that, leaving it in `cronActions.ts` is fine — it is one exported pure function in a module that already exports several internal actions; the marginal surface cost is near-zero.

Either choice is architecturally sound. I'd nudge to `lib/time.ts` on the "single-owner of time strings" consistency argument, but this is a judgment call, not a defect.

## Refinements

### R1 — Document the WIB→UTC semantic drift at the lookback boundary (one comment line)

The old helper was WIB-calendar-aligned (`wibDateLabel` → midnight-WIB date); the new one is a plain UTC instant. This is the *correct* change — `updated[gte]` wants an absolute RFC3339 instant, not a calendar date, and a UTC instant N×86.4M-ms back is an unambiguous, monotonic lower bound. Encoding a *lower bound for an API filter* as a calendar date was the latent design smell that the 400 surfaced; a `gte` cutoff is an instant, and instants belong in UTC. So the UTC choice is architecturally *cleaner*, not just expedient.

The drift worth a one-liner: the lookback bound is now UTC-based while the **bucketing** downstream (`settlements/lib.ts::wibCalendarDate` → `wibDateLabel`) is still WIB-calendar. That's correct and intentional — the bound only needs to be *wide enough* (7 days × 24h is generously inclusive of any WIB-vs-UTC ±7h edge), and per-row WIB bucketing is independent of it. But a future reader diffing this against the deleted WIB helper might wonder if the WIB-alignment was load-bearing and "lost." The existing docstring already says "a correct (slightly inclusive) lower bound," which covers the inclusiveness; consider appending half a sentence making the bound-vs-bucket split explicit, e.g.:

> *The bound is a UTC instant (window width, not a calendar boundary); per-row WIB-date bucketing happens downstream in `settlements/lib.ts` and is unaffected by this being UTC.*

Non-blocking; the current comment is already above-average. Purely to pre-empt a "why did we drop WIB here?" question in a later review.

### R2 — Test data-flow nuance (informational, no action)

`sync.test.ts` mocks `listTransactions`, so its new regression assertion validates the *format the cron passes*, not what Xendit accepts — the comment in the test correctly says exactly this ("This mocked test bypasses the real fetch, so without this assertion the format bug stays invisible to CI"). Good: the comment names the test's own blind spot. The genuine end-to-end format guarantee remains KYB-gated (#66) and lives in the live-verify follow-up, which is the honest place for it. No change needed — flagging only so the next reviewer doesn't mistake the green sync test for live-API proof.

### R3 — Graft integrity (confirmed clean)

Nothing here touches the external API surface (`convex/api/v1/`), stable string IDs, or any cross-deployment contract. `settlementLookbackIso` is an internal poll-window helper; `pos_settlements` shape is unchanged; the Frollie Pro v1.1+ integration consumes settlements (if at all) through the future versioned HTTP surface, never through this lookback. No assumption is locked in that complicates the graft. Confirmed: **no graft risk.**

---

## Verification performed

- `npx vitest run` on all three touched test files → **5 passed** (lookback 1, sync 2, listTransactions 2).
- Confirmed `wibDateLabel` still imported by `settlements/lib.ts` → no orphaned export after removing it from `cronActions.ts`.
- Traced the lookback value's full data flow: `settlementLookbackIso` → `listTransactions({settledAfterIso})` → `updated[gte]` URL param + `no_settlements` audit metadata. No downstream date-math consumer; the WIB→UTC change affects only the API lower bound and the audit string. Per-row bucketing (`aggregateSettledByDate`) is independent.
- Confirmed `cronActions.ts` stays V8-safe (no `"use node"`, no Buffer; `toISOString()` is standard).

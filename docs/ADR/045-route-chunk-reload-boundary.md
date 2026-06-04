# ADR-045 — Route-level chunk-reload error boundary

**Status:** Accepted
**Date:** 2026-06-03
**Phase:** v0.5.5

## Context

After every prod deploy of the Vercel frontend, clients holding a cached
`index.html` (PWA service worker, `registerType: "autoUpdate"`) may lazy-import
a route chunk whose content-hash filename no longer exists on the new bundle.
Modern browsers throw with one of:

- `Failed to fetch dynamically imported module: /assets/<chunk>.js`
- `Importing a module script failed`
- (Safari) `error loading dynamically imported module`

Without an error boundary, React Router renders its default "you can provide
your own error boundary" screen — useless to booth staff during the morning
rush, and even worse on the customer-facing `/r/:receiptNumber` route opened
via Telegram.

## Decision

1. **Pure helper `isChunkLoadError(err)`** in `src/lib/chunkLoadError.ts`
   centralises the message-pattern match and is unit-tested.
2. **`RouteErrorBoundary`** (`src/components/layout/RouteErrorBoundary.tsx`)
   is wired as `errorElement` on (a) the app-shell parent route and
   (b) a `PublicShell` wrapper around the three public sibling routes
   (`/activate`, `/approve/:token`, `/r/:receiptNumber`).
3. **One-shot reload guard:** when a chunk-load failure is detected, the
   boundary checks `sessionStorage["chunk-reload-at"]`. If absent or older
   than 30s, it stamps the current timestamp and calls `location.reload()`.
   A second failure within 30s falls through to the friendly fallback —
   no infinite loop.
4. **Branded fallback** (no stack trace, ever). Copy is Indonesian under
   `/r/*` (customer-facing) and English elsewhere. A "Reload" button clears
   the timestamp and reloads.

   Note: the fallback is the boundary's catch-all for *any* non-chunk render
   error too, not just stale chunks. A genuine data error on
   `/r/:receiptNumber` (e.g. a malformed receipt) therefore renders the same
   Indonesian "reopen the link" screen. That is an acceptable trade — a booth
   customer can't action a stack trace either way, and "reopen from Telegram"
   is the correct recovery for the common (stale-link) case. Debugging real
   data errors happens server-side from the receipt token, not the client.

## Why timestamp not a boolean flag

A boolean flag from a previous session would force the fallback on a
genuinely-fresh chunk failure days later. A 30-second window scopes the
guard tightly to the just-now reload attempt, with no client-side cleanup
required.

## Why a `PublicShell`

Without it, the same `errorElement` would have to be declared three times
(once per public sibling). The wrapper is a single `<Suspense><Outlet /></Suspense>`
component that costs ~10 lines and centralises the boundary.

## Out of scope

- Per-route boundaries (one root-level boundary per shell is enough).
- Replacing the PWA `autoUpdate` strategy — the boundary is the catch-net
  between a new SW landing and the running tab's cached `index.html`.
- Stack-trace toggle in dev — staff debug at the booth too; raw stacks are
  worse than the branded fallback even when we'd benefit from seeing them.

## Consequences

- One more dependency: every public route is now mounted under `PublicShell`,
  which adds a tiny `<Suspense>` boundary above each. No behaviour change for
  the routes themselves.
- Future public routes get the same treatment automatically by being added
  under the `PublicShell` children entry in `src/router.tsx`.
- The 30-second window means a quick double-deploy could trip the fallback;
  acceptable trade-off given booth deploys are infrequent and the fallback
  has a Reload button.

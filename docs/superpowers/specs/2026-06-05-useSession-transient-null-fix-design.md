# Design — `useSession` transient-null fix (issue #44)

**Date:** 2026-06-05
**Status:** Approved design, pending implementation plan
**Author:** brainstorming session
**Tracking:** [GitHub issue #44](https://github.com/lucasyhzhu-debug/frolliePOS/issues/44) · supersedes the `test.skip` layer landed in PR #43 and the 1500ms warm-up workaround in PR #41.

## Problem

After a successful login, a hard navigation (`page.goto(...)` in Playwright; full reload in a real browser) bounces the user back to `/login`. In CI every PIN-gated e2e spec reproduces this; locally it's race-dependent on Convex WebSocket reconnect timing. Six specs are currently `test.skip`-ed with this issue cited inline as the tracking pointer.

The suspect is `src/hooks/useSession.ts:47–55`:

```ts
const isDead = stored != null && validation === null;
useEffect(() => {
  if (isDead) {
    localStorage.removeItem(SESSION_KEY);
    notify(null);
  }
}, [isDead]);
```

Flow on `page.goto` after login:

1. React tree fully remounts. `useSession` reads `sessionId` from `localStorage`.
2. `useQuery(api.auth.public.getSession, { sessionId })` starts. The Convex WebSocket subscription is being (re)established.
3. **In the resubscribe window, the query transiently returns `null`** before the real session row resolves.
4. `isDead` flips `true`, the effect wipes `localStorage` and notifies subscribers.
5. Next render: `stored === null` → `status: "none"` → `RootLayout:48` redirects to `/login`. Even when the subscription stabilises moments later, the storage is already gone — the redirect is irreversible until the user logs in again.

The hook treats Convex's tri-state query incorrectly: `undefined` means "loading", and `null` means "row returned absent" — but during a reconnect the subscription path can yield a stale-window `null` that is semantically the same as `undefined`. We need to defer trust of `null` until we're confident it's not transient.

## Goals

- Hard-nav after a successful login no longer redirects to `/login`.
- Genuine "session row no longer exists server-side" detection still works (eventually clears `localStorage` and routes to `/login`).
- The 6 currently-skipped e2e specs run un-skipped and pass in CI.
- No backend change. No Convex client/SDK change.

## Non-goals

- Switching `getSession` to a different query shape (Option C in the issue) or making it resilient via server-side semantics. The symptom is client-side; fix it client-side.
- Suspense-based `useQuery` migration.
- Splitting validation into a separate `sessionStatus` lightweight query.
- Adding a global "Stale session" banner UI — `/login` is already the right destination for genuinely-stale state; we only need to stop the false-positive clear.

## Decisions (locked during brainstorming)

1. **Fix shape: debounced timeout (corrected Option A).** Defer the `localStorage` clear by `DEAD_SESSION_CONFIRM_MS = 1500ms`. If `validation` flips back to a real session (or to `undefined`) within that window, the effect's cleanup fn cancels the timer. Only a *sustained* null clears.

   The issue's literal Option A — a `nullStrikes` ref that increments on each render — is broken: a stable null only triggers the effect once (`[validation, stored]` doesn't change), so `nullStrikes` stops at 1 and the clear never fires. A `setTimeout` is the correct mechanism because the "second strike" is a *time-based confirmation*, not a render-based one.

   Rejected: **Option B** (only clear on `realSession → null` transition). Risk: a stale `localStorage` from a deleted session would never auto-clear; the user would land on `/login` every load (status:none does redirect), which is *fine* UX-wise, but the stale ID lingers in storage indefinitely — adds noise to debugging and is gratuitously dirty state. Option A handles both transient and genuinely-stale cases with one mechanism.

   Rejected: **Option C** (backend-side fix). Server query semantics are already correct (`null` = row absent / ended). The bug is the client treating a reconnect-window `null` as ground truth too eagerly.

2. **Confirmation window: 1500ms**, hoisted to a named module-level constant `DEAD_SESSION_CONFIRM_MS`. This matches the empirically-tuned warm-up sleep already baked into `e2e/fixtures.ts:awaitSignedIn` (the `page.waitForTimeout(1500)` introduced in PR #41) — that number works as a workaround precisely because it's longer than the WS reconnect window. The named constant makes the choice grep-able and tune-able without hunting magic numbers; a comment names the failure mode and the linked workaround it replaces.

3. **Remove the fixture-level workaround.** Once the hook handles the race correctly, `page.waitForTimeout(1500)` in `awaitSignedIn` is dead weight (a 1.5s tax on *every* signed-in spec). Delete it in the same change, including the comment that names this very bug as its rationale.

4. **Un-skip the 6 specs in the same PR.** Revert `test.skip` → `test` and delete the tracking-note blocks pointing to issue #44:

   - `e2e/specs/refund.spec.ts`
   - `e2e/specs/sale-bca-va.spec.ts`
   - `e2e/specs/sale-qris.spec.ts`
   - `e2e/specs/spoilage.spec.ts`
   - `e2e/specs/voucher-offline.spec.ts`
   - `e2e/specs/voucher-online.spec.ts`

   No spec body changes — they were green before PR #43 added the skip layer.

5. **No new audit / no logging.** This is a client-only race fix. Nothing to audit, no server state mutated.

6. **Verify the null-hypothesis once before claiming the fix.** The issue's reasoning assumes `useQuery` transiently yields `null` (not `undefined`) during WS resubscribe after hard-nav. If empirically the transient state is `undefined` end-to-end, the debounced effect is a **no-op for the e2e symptom** — fix lands, the 6 specs still fail, and we burn a PR + CI cycle to discover it. Plan's first task is a throwaway instrumentation pass: add a temporary `console.warn("[useSession]", { stored, validation })` (or a `sessionStorage` debug-key with the last 5 validation transitions); run one CI draft pass on a signedIn spec; confirm the log contains `validation: null` after `page.goto`; strip the instrumentation; then implement the fix. If the log shows only `undefined`, escalate before writing the fix — the symptom has a different root cause and Option A is the wrong shape.

## Detailed approach

### Hook change — `src/hooks/useSession.ts`

Replace the `isDead`-derived effect (lines 47–55 today) with a debounced timeout:

```ts
// Confirm an apparent dead session for this long before wiping localStorage.
// Avoids false positives during Convex WS resubscribe after hard-nav, where
// useQuery transiently returns null before the real session row resolves.
// 1500ms is wider than the empirically-observed reconnect window in CI and
// supersedes the fixture-level workaround formerly in e2e/fixtures.ts.
const DEAD_SESSION_CONFIRM_MS = 1500;

// ...inside useSession()...

useEffect(() => {
  if (stored == null || validation !== null) return;
  const t = setTimeout(() => {
    localStorage.removeItem(SESSION_KEY);
    notify(null);
  }, DEAD_SESSION_CONFIRM_MS);
  return () => clearTimeout(t);
}, [validation, stored]);
```

Notes:

- The early `return` keeps the effect a no-op for the happy paths (no stored ID, or `validation` is `undefined` (loading) or a real session). Only the `validation === null && stored != null` combination starts a timer.
- The cleanup fires whenever `[validation, stored]` changes — i.e., whenever the subscription pushes a new value or `storeSession`/`clearSession` mutate storage. So a transient `null → realSession` flip cancels the pending clear; a transient `null → undefined` flip also cancels (defensive — we're not certain Convex will do this, but if it does, we still don't want to clear).
- Render-time return logic (lines 57–64 today) is unchanged. The hook still returns `status: "loading"` while `validation === undefined`, which `RootLayout:40` already handles via `RouteFallback`. The user sees a brief loading state during reconnect rather than a redirect-flash.

### Constant placement

Top of `useSession.ts`, above the `listeners` set, with a comment that names:
- The failure mode it prevents (transient null on WS resubscribe after hard-nav).
- The replaced workaround (`page.waitForTimeout(1500)` in `e2e/fixtures.ts`).
- The link back to issue #44.

### Fixture change — `e2e/fixtures.ts`

Delete the trailing `await page.waitForTimeout(1500)` from `awaitSignedIn` (current `e2e/fixtures.ts:41`) **and** the 4-line comment block above it (lines 37-40) that names the bug. The three positive readiness checks above (heading visible, "New sale" tile visible, URL not `/login`) are the real settle signals and stay.

### Stale comment to delete in `useSession.ts`

The existing `// Fix V17: …` comment on lines 47-48 becomes stale once the effect is debounced. Replace it with the new docstring naming `DEAD_SESSION_CONFIRM_MS` + the failure mode + issue #44, not in addition to it.

### Spec un-skip — `e2e/specs/*.spec.ts`

In each of the 6 specs:
- `test.skip(...)` → `test(...)`.
- Delete the `// SKIPPED: session-loss-on-hard-nav…` comment block. **Block size varies:** `refund.spec.ts` has a 9-line block (lines 4-12, with the longer rationale + business-coverage pointer); the other 5 specs (`sale-bca-va`, `sale-qris`, `spoilage`, `voucher-offline`, `voucher-online`) each have a 2-line block. Remove the entire block in each — not just the first line.

No other spec body changes. They use `signedInAsLucas` / `signedInAsStaff` fixtures and were green before PR #43.

## Test plan

### Unit — `src/hooks/useSession.test.tsx`

Extend the existing file (currently mocks `useQuery: () => undefined`). Add five tests with a **controllable mock** so the test can drive `useQuery`'s return value across renders, plus `vi.useFakeTimers()` for the 1500ms boundary.

**Mock plumbing — use `vi.hoisted()` + force a `rerender`.** Two non-obvious gotchas the plan must account for:

(a) **`vi.mock()` factories are hoisted above imports.** A bare `let mockReturn: any = undefined` outside the factory and referenced inside it is fragile under strict hoisting (works today, breaks on a vitest minor bump). Use `vi.hoisted()`:

```ts
const { mockUseQuery } = vi.hoisted(() => ({
  mockUseQuery: vi.fn<[], unknown>().mockReturnValue(undefined),
}));
vi.mock("convex/react", () => ({ useQuery: mockUseQuery }));
```

(b) **Changing the mock return value does NOT trigger a re-render.** The real Convex `useQuery` subscribes to a server signal; the mock has no such mechanism. Tests that flip the mock value must force a re-render via `renderHook`'s `rerender`, wrapped in `act()`:

```ts
const { result, rerender } = renderHook(() => useSession());
// ...later, after seeding localStorage and asserting "loading":
mockUseQuery.mockReturnValue({ sessionId: "s_1", staff: {...} });
act(() => { rerender(); });
```

**`act()` + fake-timer hygiene.** Every `vi.advanceTimersByTime(…)` must be wrapped in `act()` because the timer callback runs `localStorage.removeItem + notify(null)` → `setStored(null)` on every listening hook (a React state update). The suite must use either `vi.useFakeTimers()` at the top of each timing test with `vi.useRealTimers()` in `afterEach`, OR a global `beforeEach`/`afterEach` that calls `vi.useFakeTimers()` / `vi.clearAllTimers() + vi.useRealTimers()`. Without timer cleanup, a test that doesn't advance the clock leaks a pending timer into the next test.

**Default mock value stays `undefined`.** Existing 3 tests (status:none, storeSession-notify, clearSession-notify) keep passing because `mockUseQuery.mockReturnValue(undefined)` is the default; they never observe `validation === null`.

**The 5 tests:**

1. **Transient null is ignored.** Seed `localStorage` with a sessionId; mock returns `null`; `act(() => { vi.advanceTimersByTime(500); })`; flip mock to a real session object; `act(() => { rerender(); })`; advance another 2000ms to be safe; assert `localStorage[SESSION_KEY]` still present, `status` ends `"active"`.

2. **Sustained null clears after 1500ms.** Seed `localStorage`; mock returns `null`; `act(() => { vi.advanceTimersByTime(1500); })`; assert `localStorage[SESSION_KEY]` removed, `status: "none"`, listeners notified (assert via a second mounted hook seeing the change).

3. **Real-session → null transition is honoured.** Mock returns a real session value; mount; assert `status: "active"`; flip mock to `null`; `act(() => { rerender(); vi.advanceTimersByTime(1500); })`; assert cleared. (Covers the genuine "logged out elsewhere" acceptance criterion.)

4. **`clearSession()` mid-pending-timer doesn't race.** Seed; mock = null; advance 500ms (timer pending); call `clearSession()`; advance the remaining 1000ms; assert localStorage cleared **once**, no duplicate notify (assert via a counter listener), status ends `"none"`.

5. **`storeSession(newId, …)` mid-pending-timer cancels the clear.** Seed with `oldId`; mock = null; advance 500ms (timer pending); call `storeSession("newId", ...)`; advance another 1500ms (well past the original deadline); assert `localStorage[SESSION_KEY] === "newId"` (NOT cleared). Validates the spec's Risk 3 claim with a direct test instead of inference.

### E2E — `e2e/specs/*.spec.ts`

Acceptance is the 6 specs going green un-skipped in CI:

```
e2e/specs/refund.spec.ts
e2e/specs/sale-bca-va.spec.ts
e2e/specs/sale-qris.spec.ts
e2e/specs/spoilage.spec.ts
e2e/specs/voucher-offline.spec.ts
e2e/specs/voucher-online.spec.ts
```

Plus `auth.spec.ts` continues to pass. Total: all 8 specs green (vs current 1 passed / 7 skipped per workflow run #27001616950).

No spec body changes (so no new behaviour to test); CI green is the contract.

## Risks and mitigations

- **WS reconnect window ever exceeds 1500ms in CI under load.** Transient-null could still leak past the timer. Mitigation: tune up (e.g., 3000ms) at the named constant — single-point fix. Empirically the reconnect happens in tens-to-hundreds of ms, so 1500ms has comfortable headroom.
- **Genuine stale-session detection delayed by 1.5s.** Acceptable: user lands on a loading state for at most 1.5s before being redirected to `/login`. UX cost is invisible against the rare case (server-side row deletion, typically only on cleanup crons or manual ops).
- **Race against `storeSession` arriving during the pending timer.** `storeSession` writes to `localStorage`, notifies listeners → `setStored` fires in every mounted `useSession` → `[validation, stored]` change → effect cleanup → timer cleared. Safe by construction. Documented as part of the cleanup-on-deps-change guarantee.

## Out of scope

- Backend `getSession` semantics change (Option C).
- Suspense / `useSuspenseQuery` migration.
- Adding a dedicated `useSessionStatus` lightweight ping query.
- A user-facing "Session reconnecting…" banner.
- Investigating whether Convex itself should preserve last-known values across WS reconnect (potential upstream issue — out of v1 scope).

## Files touched

| File | Change |
|---|---|
| `src/hooks/useSession.ts` | Replace `isDead` effect with debounced-timeout effect; add `DEAD_SESSION_CONFIRM_MS` constant + comment. |
| `src/hooks/useSession.test.tsx` | Make `useQuery` mock controllable; add 3 timing tests with `vi.useFakeTimers()`. |
| `e2e/fixtures.ts` | Remove `page.waitForTimeout(1500)` + workaround comment in `awaitSignedIn`. |
| `e2e/specs/refund.spec.ts` | `test.skip` → `test`; delete tracking-note block. |
| `e2e/specs/sale-bca-va.spec.ts` | same |
| `e2e/specs/sale-qris.spec.ts` | same |
| `e2e/specs/spoilage.spec.ts` | same |
| `e2e/specs/voucher-offline.spec.ts` | same |
| `e2e/specs/voucher-online.spec.ts` | same |
| `docs/CHANGELOG.md` | One-line bug-fix entry citing issue #44. Target version: **v0.5.8** if this ships isolated; **v0.5.7.1** if it lands as a hotfix under the v0.5.7 banner; final call deferred to plan time based on what else is in flight. |

## Acceptance (mirrors issue #44)

- Hard-nav via `page.goto` after login no longer redirects to `/login`.
- Real stale-session detection still works (`localStorage` cleared when `sessionId` no longer matches any server row, within ~1.5s).
- All 6 previously-skipped specs revert to `test` and pass in CI.
- `e2e` GH Action runs all 8 specs green.

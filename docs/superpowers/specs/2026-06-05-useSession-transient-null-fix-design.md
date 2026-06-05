# Design — `useSession` transient-null fix (issue #44, Option B re-spec)

**Date:** 2026-06-05
**Status:** Approved design, pending implementation plan. **Supersedes the Option A debounce-shaped design** that landed in PR #45 under the same filename.
**Author:** brainstorming session + architectural-options review
**Tracking:** [GitHub issue #44](https://github.com/lucasyhzhu-debug/frolliePOS/issues/44) · supersedes the `test.skip` layer landed in PR #43 and the 1500ms warm-up workaround in PR #41.
**Architectural review:** [`docs/reviews/staffreview-issue-44-architectural-options-2026-06-05.md`](../../reviews/staffreview-issue-44-architectural-options-2026-06-05.md) — ranks 4 options A/B/C/D against the codebase. This spec implements **Option B** (transition-based null detection), which the architectural review identified as the root-cause-aware fix.

## Why a re-spec

The first design (Option A) shipped a debounced `setTimeout(clear, 1500ms)` inside the existing `isDead` effect. After a user challenge — *"isn't waiting 1.5 seconds just addressing symptoms?"* — the architectural review demonstrated that A is a mitigation, not a root-cause fix:

- A widens the trust window from 0ms to 1500ms but re-emerges if Convex reconnect ever exceeds 1500ms (same dynamic that grew the original fixture sleep over time).
- The actual root cause is **the client treating `useQuery`-null as definitive ground truth without checking whether it has ever observed a real validation**. The trust criterion in A is arbitrary (time elapsed); the trust criterion in B is semantic ("I've successfully validated this session at least once, so a subsequent null means a real transition").
- B's trust criterion is logically tied to the problem; A's is not.

This spec is Option B as outlined in the original issue body: **track whether we've ever seen a real session via `useRef`; treat a `null` as ground truth only after we've seen evidence the subscription is healthy.** Both the destructive effect AND the render-time branch consult the same ref.

(Note: an earlier framing in the architectural review called Option B "decouple `localStorage` wipe from query null and stop there." That's incomplete — even with the effect deleted, `RootLayout`'s `Navigate to="/login" replace` fires on a single render frame of `status: "none"` and the URL flip is sticky. The render-time branch needs the same evidence the effect does. This spec corrects that.)

## Problem

After a successful login, a hard navigation (`page.goto(...)` in Playwright; full reload in a real browser) bounces the user back to `/login`. In CI every PIN-gated e2e spec reproduces this; locally it's race-dependent on Convex WebSocket reconnect timing. Six specs are currently `test.skip`-ed with this issue cited inline as the tracking pointer.

The suspect block is `src/hooks/useSession.ts:47-55` (the `isDead` effect) AND `src/hooks/useSession.ts:59` (the render-time mapping of `validation === null` to `status: "none"`).

Flow on `page.goto` after login under the current code:

1. React tree fully remounts. `useSession` reads `sessionId` from `localStorage`.
2. `useQuery(api.auth.public.getSession, { sessionId })` starts. The Convex WebSocket subscription is being (re)established.
3. **In the resubscribe window, the query transiently returns `null`** before the real session row resolves.
4. `isDead` flips `true`, the effect wipes `localStorage` and notifies subscribers.
5. Next render: `stored === null` → `status: "none"` → `RootLayout:48` redirects to `/login`. Even when the subscription stabilises moments later, the storage is already gone — the redirect is irreversible until the user logs in again.

Even if step 4 were prevented (just deleting the effect), step 5 would still fire on the single render where `validation === null` and `stored` is still truthy — because the render-time branch at line 59 returns `status: "none"`, which `RootLayout:48` immediately redirects on. **The bug is BOTH the wipe AND the render-time interpretation.** Both need to be evidence-aware.

## Goals

- Hard-nav after a successful login no longer redirects to `/login`.
- Genuine "session row no longer exists server-side" detection still works (`localStorage` cleared and `/login` reached, just via a semantically grounded path instead of a time-based one).
- The 6 currently-skipped e2e specs run un-skipped and pass in CI.
- No backend change. No Convex client/SDK change. No `setTimeout` in the hook.

## Non-goals

- Adding a debounce, timeout, or any time-based mitigation inside the hook (Option A from the architectural review).
- Using Convex's `ConnectionState` to filter `null` interpretation (Option C — solves the wrong problem; the WS can be healthy while the query is mid-resubscribe).
- Migrating `getSession` to a tagged-union return shape (Option D — right pattern long-term, deferred to a follow-up issue once a second public query needs the same discriminator).
- Auditing or fixing other hooks with the same null-handling pattern (`useApproval.ts:22` has the same shape) — out of scope for this PR; filed as a follow-up.

## Decisions (locked during re-brainstorming)

1. **Fix shape: track `hasEverBeenReal` via `useRef`; consult it in BOTH the effect AND the render-time branch.** Concretely:

   ```ts
   const hasEverBeenReal = useRef(false);
   if (validation !== null && validation !== undefined) {
     hasEverBeenReal.current = true;
   }

   // Effect: wipe only on REAL → null transition (genuine logout-elsewhere).
   useEffect(() => {
     if (validation === null && stored != null && hasEverBeenReal.current) {
       localStorage.removeItem(SESSION_KEY);
       notify(null);
     }
   }, [validation, stored]);

   // Render-time: distinguish first-null (still loading) from post-real-null (dead).
   if (!stored) return { status: "none", sessionId: null, staff: null };
   if (validation === undefined) return { status: "loading", sessionId: null, staff: null };
   if (validation === null) {
     return {
       status: hasEverBeenReal.current ? "none" : "loading",
       sessionId: null,
       staff: null,
     };
   }
   return { status: "active", sessionId: validation.sessionId, staff: validation.staff };
   ```

   **Trace through the three real cases:**
   - **Transient null on cold-mount reconnect (the bug).** `validation` goes `undefined → null → realSession`. On the null render, `hasEverBeenReal` is `false` (we haven't seen a real value yet) → status returns `"loading"` → `RootLayout` shows `RouteFallback` (no redirect). Effect does nothing (gated on `hasEverBeenReal`). Next render: real value arrives → `hasEverBeenReal` flips `true` → status `"active"`. **Bug fixed without any timeout.**
   - **Genuine logged-out-elsewhere (real → null).** `validation` was a real session, then becomes null. On the null render, `hasEverBeenReal` is `true` (we saw the real session earlier) → status returns `"none"` → `RootLayout` redirects to `/login`. Effect fires (`hasEverBeenReal` true, `validation` null, `stored` present) → `localStorage` wiped. **Original UX preserved.**
   - **Genuinely-stale `localStorage` on cold mount** (rare: user closes app with active session, server reaper deletes the row overnight, user opens app the next morning). `validation` goes `undefined → null` (never resolves to a real session because the row is gone). On the null render, `hasEverBeenReal` is `false` → status returns `"loading"` indefinitely. **UX hole: user sees `Loading…` and can't escape.** Mitigated by the `RootLayout` escape hatch in decision #2.

   Rejected: **Option A** (debounce). Mitigation, not root cause. Window-widening tactic that re-emerges if reconnect ever exceeds the constant. The 1500ms fixture sleep we're removing got there the same way.

   Rejected: **Option C** (filter by Convex connection state). API exists in 1.31.7 (`useConvex().connectionState()`, verified — `ConnDot.tsx` already uses it). But a healthy WS can still emit a transient null between subscription reset and first real value, so C narrows the window the same way A does, with more moving parts.

   Rejected: **Option D** (tagged-union from `getSession`). Cleanest at the API layer, right pattern long-term. Higher cost (backend change + new return-shape pattern this codebase doesn't have at the public-query boundary yet). Not justified for one query. Filed as a follow-up — see decision #6.

2. **`RootLayout` stuck-loading escape hatch.** To handle the genuinely-stale `localStorage` case (where the hook returns `"loading"` indefinitely because `hasEverBeenReal` never flips true), add a small affordance in `RouteFallback`: after 5 seconds in `status: "loading"` with `stored != null`, render a "Stuck on loading? Lock device and sign in again." link that calls `clearSession()`.

   This:
   - Frames the stale-state recovery as a user-authorised action (which is what ADR-003 *already* sanctions — "the **Lock** screen ends the session explicitly").
   - Has no impact on the bug scenario (the real session resolves in tens-to-hundreds of ms, well before the 5s threshold).
   - Costs one small UI element + a 5-second timer in `RootLayout`, not in `useSession`. The hook itself remains time-free.

   The 5s threshold is generous (real WS reconnect is hundreds of ms). It's a discoverability threshold for a rare edge case, not a "trust" threshold like Option A's 1500ms. If real reconnects ever exceed 5s in prod, the escape hatch's button being visible is still safe — clicking it triggers a legitimate Lock-and-re-login flow, which is harmless.

3. **Remove the fixture-level workaround.** Once the hook handles the transient-null race semantically, the `page.waitForTimeout(1500)` in `e2e/fixtures.ts:awaitSignedIn` (lines 37-41) is dead weight (a 1.5s tax on every signed-in spec). Delete the timeout AND the 4-line comment block above it that names this bug as its rationale.

4. **Un-skip the 6 specs in the same PR.** Revert `test.skip` → `test` and delete the tracking-note blocks pointing to issue #44:

   - `e2e/specs/refund.spec.ts` (8-line `// SKIPPED:` block at lines 4-11; `test.skip` on line 12)
   - `e2e/specs/sale-bca-va.spec.ts` (2-line block at lines 4-5)
   - `e2e/specs/sale-qris.spec.ts` (2-line block at lines 4-5)
   - `e2e/specs/spoilage.spec.ts` (2-line block at lines 3-4)
   - `e2e/specs/voucher-offline.spec.ts` (2-line block at lines 4-5)
   - `e2e/specs/voucher-online.spec.ts` (2-line block at lines 4-5)

   No spec body changes — they were green before PR #43 added the skip layer.

5. **No new audit / no logging.** Client-only behaviour change. Nothing to audit, no server state mutated.

6. **Two follow-ups filed in the same PR** (mitigation-vs-root-cause discipline; per the new memory `always-distinguish-root-cause-from-symptom`):

   - **Issue:** *"Migrate `getSession` (and other ambiguous-null public queries) to tagged-union return shape (Option D from issue #44 architectural review)."* Park until a second motivating query exists. Rationale: D eliminates the ambiguity at the API boundary, B is the correct *client-side interpretation* of an ambiguous API. B is sufficient for one query; D becomes worth it when 2+ queries share the same null-ambiguity problem.
   - **Issue:** *"Audit other `useQuery`-driven hooks with destructive null-handling (starting with `useApproval.ts:22`)."* Same shape as the bug fixed here; lower stakes (no `localStorage` wipe, just a UI flash from `"pending"` to `"missing"` during reconnect) but worth a sweep. The `hasEverBeenReal` pattern transfers as a rule.

7. **Keep Task 0 hypothesis-verify as defence-in-depth.** Even though Option B removes the destructive wipe regardless of the actual transient state (`null` or `undefined`), one instrumentation pass tells us whether there's a *second* bug lurking. If `validation` stays `undefined` (never goes `null`) between hard-nav and the `/login` redirect under the OLD code, the bug has a different root cause (likely in `RootLayout`'s `deviceRegistered === undefined` gate or `useDeviceId`'s IDB race) and this spec is partially misaimed. Cheap insurance; ~10 min of CI to disambiguate.

## Detailed approach

### Hook change — `src/hooks/useSession.ts`

Three coordinated edits:

**(a) Add `hasEverBeenReal` ref + assignment.** Insert above the current `useQuery` call (current line 42):

```ts
// Issue #44: distinguish a transient null from useQuery (during Convex WS
// resubscribe after a hard-nav) from a genuine logout-elsewhere. We trust a
// null as ground truth only after we've successfully validated this session
// at least once — same evidence the subscription itself provides.
const hasEverBeenReal = useRef(false);
```

Then, immediately after the `useQuery` call returns, set the ref when the result is real (this is a render-time side effect on a ref, which is permitted in React — refs aren't reactive state):

```ts
const validation = useQuery(
  api.auth.public.getSession,
  stored ? { sessionId: stored as Id<"staff_sessions"> } : "skip",
);
if (validation !== null && validation !== undefined) {
  hasEverBeenReal.current = true;
}
```

**(b) Gate the effect on `hasEverBeenReal`.** Replace the current `isDead` derivation + effect (lines 47-55) with:

```ts
// Wipe localStorage only on a REAL → null transition (genuine logout-elsewhere).
// A null seen BEFORE we've ever observed a real session is the transient-reconnect
// case (issue #44) — not authoritative; do nothing.
useEffect(() => {
  if (validation === null && stored != null && hasEverBeenReal.current) {
    localStorage.removeItem(SESSION_KEY);
    notify(null);
  }
}, [validation, stored]);
```

**(c) Flip the render-time null branch on `hasEverBeenReal`.** Replace the current line 59:

```ts
// BEFORE:
if (validation === null) return { status: "none", sessionId: null, staff: null };

// AFTER:
if (validation === null) {
  return {
    status: hasEverBeenReal.current ? "none" : "loading",
    sessionId: null,
    staff: null,
  };
}
```

The other render-time branches (lines 57, 58, 60-63) are unchanged.

**Stale-comment cleanup:** the existing `// Fix V17: …` comment block on lines 47-48 becomes stale and is replaced by the new comments in (a) and (b).

### `RootLayout` stuck-loading escape hatch — `src/components/layout/RootLayout.tsx`

`RouteFallback` (current lines 65-71) renders just `<span>Loading…</span>`. Augment it to render an escape hatch after 5 seconds when the cause is the session-loading branch (not the device-loading branch — those resolve differently).

Concretely: the gate at line 40 currently shows `RouteFallback` for THREE reasons: `deviceId === null`, `deviceRegistered === undefined`, OR `session.status === "loading"`. We only want the escape hatch in the session-loading case. Plumb a small signal through:

```ts
// In RootLayout, before the gate:
const showSessionStuck =
  deviceId !== null &&
  deviceRegistered !== undefined &&
  session.status === "loading" &&
  typeof localStorage !== "undefined" &&
  localStorage.getItem(SESSION_KEY) !== null;

// And the gate passes it to RouteFallback:
if (deviceId === null || deviceRegistered === undefined || session.status === "loading") {
  return <RouteFallback showSessionStuck={showSessionStuck} />;
}
```

Then `RouteFallback`:

```ts
function RouteFallback({ showSessionStuck = false }: { showSessionStuck?: boolean }) {
  const [stuckVisible, setStuckVisible] = useState(false);
  useEffect(() => {
    if (!showSessionStuck) return;
    const t = setTimeout(() => setStuckVisible(true), 5000);
    return () => clearTimeout(t);
  }, [showSessionStuck]);

  return (
    <div className="flex-1 grid place-items-center text-muted-foreground text-sm gap-4">
      <span>Loading…</span>
      {stuckVisible && (
        <button
          type="button"
          onClick={() => clearSession()}
          className="text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground"
        >
          Stuck on loading? Lock device and sign in again.
        </button>
      )}
    </div>
  );
}
```

Import `clearSession` from `@/hooks/useSession` and `SESSION_KEY` from `@/lib/storage-keys` (or read from `useSession`'s `status`/`stored` indirectly). `clearSession()` wipes `localStorage` and notifies; the next render returns `status: "none"` → redirect to `/login`. User is unstuck.

Wording chosen to frame the action as the legitimate ADR-003 Lock pattern (`Lock device and sign in again`), not as "the app is broken."

### Files touched

| File | Change |
|---|---|
| `src/hooks/useSession.ts` | Add `hasEverBeenReal` ref + assignment; gate effect on it; flip render-time null branch from `"none"` to `"loading"` when `!hasEverBeenReal.current`. Replace stale `// Fix V17` comment with the new issue #44 reference. |
| `src/components/layout/RootLayout.tsx` | Compute `showSessionStuck` boolean; pass it to `RouteFallback`. Refactor `RouteFallback` to render the escape-hatch button after 5s. |
| `src/hooks/useSession.test.tsx` | Update 1 existing test's assertion (the `validation === null` case now returns `"loading"` on cold mount); add 2 new tests for the transition behaviour (real → null wipes; cold null doesn't wipe). No fake timers in this file — the hook has no time-based logic. |
| `src/components/layout/__tests__/RootLayout.test.tsx` *(new file)* | 2 tests with `vi.useFakeTimers()`: (a) escape hatch hidden initially, visible after 5s of session-loading-with-stored; (b) clicking the escape hatch calls `clearSession` and redirects to `/login`. |
| `e2e/fixtures.ts` | Remove `page.waitForTimeout(1500)` (line 41) + the 4-line workaround comment (lines 37-40). |
| `e2e/specs/refund.spec.ts` | `test.skip` → `test` (line 12); delete 8-line `// SKIPPED:` block (lines 4-11). |
| `e2e/specs/sale-bca-va.spec.ts` | `test.skip` → `test`; delete 2-line `// SKIPPED:` block (lines 4-5). |
| `e2e/specs/sale-qris.spec.ts` | same |
| `e2e/specs/spoilage.spec.ts` | `test.skip` → `test`; delete 2-line block (lines 3-4). |
| `e2e/specs/voucher-offline.spec.ts` | same as sale-bca-va |
| `e2e/specs/voucher-online.spec.ts` | same as sale-bca-va |
| `docs/CHANGELOG.md` | One-line v0.5.7.1 bug-fix entry citing issue #44 (v0.5.8 is taken by the orphan-wiring phase). |

## Test plan

### Unit — `src/hooks/useSession.test.tsx`

**Mock plumbing:** the existing `vi.mock("convex/react", () => ({ useQuery: () => undefined }))` keeps the 2 existing localStorage-layer tests green. The 2 new tests + 1 updated test need a controllable `useQuery`, so we switch to the `vi.hoisted()` + `vi.fn()` pattern (same as Option A's plan called for, but with much less coverage needed):

```ts
const { mockUseQuery } = vi.hoisted(() => ({
  mockUseQuery: vi.fn<[], unknown>().mockReturnValue(undefined),
}));
vi.mock("convex/react", () => ({ useQuery: mockUseQuery }));
```

`beforeEach` resets `mockUseQuery.mockReturnValue(undefined)`. **No `vi.useFakeTimers()` needed in this file** — `useSession` has no time-based logic.

**The 4 tests after the change** (2 existing untouched, 1 existing updated, 2 new):

1. **(existing, unchanged)** No stored session → status `"none"`.
2. **(existing, unchanged)** `storeSession` notifies same-tab listeners (asserts transition `"none"` → `"loading"`).
3. **(existing, ASSERTION UPDATED)** `clearSession` notifies same-tab listeners. The current assertion is `status: "loading"` → `clearSession()` → `status: "none"`. Unchanged — the `clearSession` path doesn't go through the new conditional, it's a direct user-action wipe. ✓ still green.
4. **(NEW) Cold-mount null → `"loading"`, NOT `"none"`, AND no localStorage wipe.** Seed `localStorage[SESSION_KEY] = "s_seed"`; `mockUseQuery.mockReturnValue(null)`; renderHook; assert `result.current.status === "loading"`; assert `localStorage.getItem(SESSION_KEY) === "s_seed"` (the bug-fix invariant — hook never wipes localStorage when it has never seen a real session).
5. **(NEW) Real-session → null wipes localStorage AND returns `"none"`.** Seed `localStorage`; `mockUseQuery.mockReturnValue({ sessionId: "s_seed", staff: {...}, deviceId: "dev-x", startedAt: 0 })`; renderHook; assert `status === "active"`. Flip mock to `null`; `act(() => { rerender(); })`; assert `localStorage.getItem(SESSION_KEY) === null` (wiped) AND `result.current.status === "none"` (real → null transition was honoured).

### Unit — `src/components/layout/__tests__/RootLayout.test.tsx` (new file)

Test the escape hatch with `vi.useFakeTimers()`. Mocks `useSession` and `useDeviceId` directly (per the existing `AppHeader.test.tsx` pattern).

6. **Escape hatch hidden initially.** Mount RootLayout with `useSession` returning `status: "loading"`, `useDeviceId` returning a registered device, and `localStorage[SESSION_KEY]` set. Without advancing timers, assert the "Stuck on loading?" button is NOT visible. Assert `Loading…` IS visible.
7. **Escape hatch visible after 5s + click calls `clearSession`.** From state #6, `act(() => vi.advanceTimersByTime(5000))`. Assert the button IS visible. Click it; assert `localStorage` is cleared (i.e., `clearSession` was called); assert subsequent render path redirects to `/login` (or assert the `clearSession` import was called via spy).

### E2E — `e2e/specs/*.spec.ts`

Acceptance is the 6 specs going green un-skipped in CI. No new e2e specs needed; the existing 6 + `auth.spec.ts` cover the round trip.

### Manual smoke test

- **Bug scenario:** sign in as Lucas on dev; hard-reload `/sale`; should stay on `/sale` after at most a `Loading…` flash, NOT redirect to `/login`.
- **Stuck scenario:** open dev tools, set `localStorage.frollie_pos_session = "fake_session_id"`, reload; see `Loading…` then after 5s see the "Stuck on loading?" link; click → land on `/login` with clean storage.
- **Logout-elsewhere scenario:** sign in, then in another browser tab run `npx convex run auth/internal:_reaperEndSession_internal '{ sessionId: "..." }'` (or whatever the reaper exposes) to manually end the session; observe the first tab transitions from `"active"` → redirect to `/login` AND `localStorage` is cleared.

## Risks and mitigations

- **The `hasEverBeenReal` ref is per-hook-instance.** Different `useSession()` mounts have separate refs. If a page mounts `useSession` in `RootLayout` AND in `AppHeader`, both refs start at false on hard-nav. Both correctly converge to true on the first real session observation — no consistency issue, but worth noting. (Same module-level `notify(null)` channel keeps `stored` in sync across instances; that's unaffected.)
- **React 19 StrictMode double-mount in dev.** `useRef` survives the double-effect cycle within a single mount lifecycle; on a fresh mount it correctly starts false. No real concern, but if a test exercises StrictMode it should still pass because the ref initialises false and the assignment happens on the first real validation.
- **The 5s stuck threshold could mask a slow real reconnect.** If prod Convex reconnects sometimes take >5s under poor cellular, the escape hatch becomes visible during what's actually a healthy slow reconnect — but **clicking it is still safe** (clearSession + re-login is the prescribed user action). Not a correctness bug, just slightly noisy UX in poor-network conditions. Mitigation: tune the threshold upward if observed.
- **`useApproval` and other `useQuery`-null-handling hooks have the same shape.** Out of scope here, filed as follow-up. The fix landed in this PR is portable as a rule but not as code — each hook needs the same render-time vs side-effect discipline applied individually.
- **The hypothesis itself.** If Task 0's instrumentation shows `validation` only ever goes `undefined` (never `null`), this fix is **still correct** (the hook treats undefined as loading regardless of `hasEverBeenReal`, so the new code paths are no-ops). But a different bug is then in play, surfaceable from the same Task 0 trace.

## Out of scope

- Backend `getSession` semantics change (Option D — tagged-union return). Filed as follow-up.
- Suspense / `useSuspenseQuery` migration.
- Adding a dedicated `useSessionStatus` lightweight ping query.
- Auditing or fixing `useApproval` / other hooks with destructive null-handling (follow-up issue).
- Investigating whether Convex should preserve last-known values across WS reconnect (potential upstream issue, out of v1 scope).

## Acceptance (mirrors issue #44)

- Hard-nav via `page.goto` after login no longer redirects to `/login`.
- Real stale-session detection: real → null transition still wipes `localStorage` AND redirects to `/login` (preserves original UX for the genuine case).
- Cold-mount-with-stale-localStorage: user sees `Loading…` for 5s then a clear "Stuck on loading? Lock device and sign in again." escape hatch (rather than wiping silently on a timer).
- All 6 previously-skipped specs revert to `test` and pass in CI.
- `e2e` GH Action runs all 8 specs green.

## Comparison vs the superseded Option A spec

| Aspect | Option A (PR #45, superseded) | Option B (this spec) |
|---|---|---|
| Mechanism | Debounced `setTimeout(clear, 1500ms)` in the effect | `useRef<boolean>` tracking "have we ever validated this session"; gates both effect AND render-time null branch |
| Trust criterion for null | Time elapsed (1500ms, arbitrary constant) | Evidence-based ("we've validated at least once") |
| Survives Convex reconnect > 1500ms | No | Yes — no time threshold in the hook |
| Hook LOC delta | ~10 added | ~10 added (similar size, very different shape) |
| Hook has `setTimeout`? | Yes | **No** |
| Test file uses fake timers? | Yes (5 timing tests + `vi.hoisted()` plumbing) | No in `useSession.test.tsx`; yes in `RootLayout.test.tsx` (smaller surface) |
| Stale-localStorage UX | Auto-cleared after 1500ms (silent) | User-initiated clear via "Stuck" affordance after 5s (explicit, ADR-003-aligned) |
| Root cause addressed | No (window-widening) | Yes (evidence-based interpretation of an ambiguous API) |
| ADR-003 alignment | Adds 3rd undocumented session-end path | Aligns: only authorised paths (Lock, server reaper) wipe `localStorage` |
| Follow-ups filed | None | Option D migration; null-handling audit across hooks |

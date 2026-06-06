> **REFUTED 2026-06-06** — see PR #<n> (v0.5.9 e2e stabilization). The four architectural options compared in this review (Option A debounce, Option B trust-null, etc.) addressed a misdiagnosed mechanism. PR #48 instrumentation (Playwright run `27021101339`) refuted the transient-null hypothesis empirically. The real bug was a11y/selector drift — see `docs/postmortems/2026-06-issue-44-misdiagnosis.md`. This review is kept as evidence in the postmortem; do not act on its recommendations.

---

# Architectural Review: Issue #44 useSession transient-null — 4 options

**Date:** 2026-06-05
**Mode:** Architectural comparison (NOT a plan/spec review). Replaces the implicit "Option A is the fix" framing in the currently-merged planning artefacts (`docs/superpowers/{specs,plans}/2026-06-05-…useSession-transient-null-fix.md`).
**Reviewers:** Staff Developer (implementation) + Principal Developer (architecture)

---

## TL;DR

**Winner: Option B (decouple wipe from query null) — this is the actual root-cause fix.** It removes the wrong coupling that produces the bug, not just its window. ~30 LOC delta, no backend change, no Convex API risk. Generalises to `useApproval` (which has the same latent bug).

**Runner-up: Option D (tagged-union from `getSession`).** Cleanest at the API layer; eliminates ambiguity at the source rather than client-side. Higher cost (backend change + new return-shape pattern this codebase doesn't have yet) but the right shape for the long term. Worth doing if/when `getSession` ever grows a third meaning beyond "active" / "absent".

**Don't ship A in isolation.** Ship A only as a 1-PR bridge while B is being executed in parallel, with an explicit follow-up issue tracked. Otherwise it's a permanent band-aid.

**Skip C.** Convex's `ConnectionState` exists and is usable (`ConnDot.tsx` already uses it), but it solves the wrong problem: a healthy WebSocket can still emit a null result for a brief moment between subscription-reset and first-real-value. C narrows the window the same way A does, with more moving parts.

---

## Summary of the four options

| | A — Debounce | B — Decouple | C — Connection filter | D — Tagged union |
|---|---|---|---|---|
| **What it changes** | Wait 1500ms before trusting `null` | Stop wiping `localStorage` on `null`; only wipe on explicit signals | Suppress `null` interpretation while WS reconnecting | Server returns `{ status: "active" \| "ended" \| "not_found" }` |
| **Touches** | 1 hook, ~10 LOC | 1 hook, ~20 LOC (delete > add) | 1 hook + `useConvex()` plumbing, ~30 LOC | 1 query + 1 hook + (later) other consumers |
| **Eliminates root cause?** | No — tolerates symptom | **Yes** — removes the wrong coupling | No — narrows the window | **Yes** — removes the ambiguity |
| **Backend change?** | No | No | No | Yes |
| **Convex API risk?** | None | None | Medium — `ConnectionState` is documented but `ConnDot.tsx` types it defensively as optional | None |
| **Generalises to `useApproval` (same bug latent there)?** | No | **Yes** | Partial (need to wire connection state into every hook) | Only if `getRequestStatus` migrates too |
| **Rollback** | `git revert` 1 commit | `git revert` 1 commit | `git revert` 1 commit | 2 reverts (server + client) — they're separate commits anyway |
| **Survives Convex reconnect taking >1500ms** | No | **Yes** | **Yes** (until `hasEverConnected` flips erroneously) | **Yes** |

---

## Code grounding (what I confirmed against the codebase)

### Convex `ConnectionState` API actually exists in 1.31.7

`node_modules/convex/dist/cjs-types/browser/sync/client.d.ts` exports:

```ts
export type ConnectionState = {
  hasInflightRequests: boolean;
  isWebSocketConnected: boolean;
  timeOfOldestInflightRequest: Date | null;
  hasEverConnected: boolean;
  connectionCount: number;
};
```

with methods `connectionState(): ConnectionState` and `subscribeToConnectionState(cb): () => void` available on the `ConvexReactClient`. They're already consumed in `src/components/layout/ConnDot.tsx:30-44` (which defensively types them as optional — the team treats this API as "exists today, not future-proof"). So **Option C is implementable, but the team has already signalled they don't fully trust this surface**.

### The same bug is latent in `useApproval`

`src/hooks/useApproval.ts:22`:

```ts
if (res === null) return "missing";
```

Same trust-null-immediately pattern. If `useQuery(getRequestStatus)` ever transiently returns `null` during a WS reconnect — and there's no reason to believe it won't, since the mechanism would be identical — `ApprovalPending` flips from `"pending"` to `"missing"`, which the route handles by navigating away. **This is a generalisable problem.** Option A and C would each have to be re-applied to every hook with this shape. Option B is the only one that turns into a portable rule: "querying for `null` means 'no data here right now', not 'the entity is dead'."

### `localStorage`-wipe semantics come from ADR-003

`docs/ADR/003-shared-device-ephemeral-session.md`:

> The **Lock** screen ends the session explicitly (writes `ended_at`, `end_reason: "manual_lock"`). Idle behaviour: **no auto-logout** — booth context, not banking.

The ADR explicitly authorises **two** ways for a session to end:
1. Staff taps **Lock** (`clearSession()` / `logout` mutation — both directly remove `localStorage`).
2. Server reaper nightly (writes `ended_at`).

The current code adds a *third*, undocumented mechanism: "client's `useQuery(getSession)` happened to return `null` once → wipe `localStorage`." That's a layer-violation: the client is acting as a reaper. **Option B realigns the implementation with the ADR.** A genuinely-stale `localStorage` entry sits there harmlessly until next login overwrites it — which is exactly what the ADR's "no auto-logout" stance implies.

### Tagged-union precedent in the codebase

No **public query** returns a tagged-union shape. The discriminant-on-`kind` pattern does exist for *internal mutation args* (`convex/auth/internal.ts:354-357` — `changePinActorValidator`). So Option D's shape is "kind-discriminated union, new at the public-query boundary." Migration scope: `getSession` is the only consumer of the ambiguous-null shape in `convex/auth/public.ts` (verified — `getActiveStaff` returns an array, `logout` returns `null`-as-success-marker which is unambiguous).

---

## Per-option detail

### Option A — Debounce in `useSession` (currently planned)

**Architecturally:** a workaround. Treats the symptom by widening the trust window from "instantly" to "1500ms." Adds no new abstraction, adds no new dependencies, adds no new tests beyond the timing tests already specified.

**Where it fails:** any future Convex reconnect that takes >1500ms (CI under contention, prod under bad cellular network) re-opens the bug. The mitigation is "raise the constant" — the same dynamic that produced the 1500ms `awaitSignedIn` fixture sleep we're now removing. We've seen this pattern lose: the test fixture's number drifted from "long enough" to "barely enough" to "not enough" once before.

**Pattern: not transferable.** `useApproval`'s identical bug shape requires a separate copy of the same debounce. Two copies → three. The team's "rule of three" memory (`v052-triple-simplify-lessons.md`) says this is the signal to extract a helper. But the helper would still be tolerating the wrong coupling.

**Reversibility:** trivial — `git revert` the hook commit. ✓

**Verdict:** ship-able only as a *named bridge* with B (or D) already in flight as a follow-up. Not safe to land alone.

### Option B — Decouple `localStorage` wipe from `useQuery` `null` (RECOMMENDED)

**The actual root-cause fix.** The bug isn't "useQuery sometimes returns null" — that's a normal possibility for any query. The bug is "useSession treats query null as authorisation to wipe persistent client state." Remove the wipe, and the rest of the chain (status:"none" → RootLayout redirect → /login) does the right thing without state loss.

**Concrete delta to `useSession.ts`:**

```ts
// DELETE these lines (current 47-55):
const isDead = stored != null && validation === null;
useEffect(() => {
  if (isDead) {
    localStorage.removeItem(SESSION_KEY);
    notify(null);
  }
}, [isDead]);

// Render-time logic UNCHANGED (still returns status:"none" on null) —
// so RootLayout still redirects to /login. The localStorage entry stays;
// next storeSession() in the fresh-login flow overwrites it.
```

That's a deletion. ~10 LOC removed, 0 added.

**Consumer trace (RootLayout):**

- `session.status === "loading"` → RouteFallback. ✓ unchanged.
- `session.status === "none"` (returned when `validation === null` OR `stored === null`) → `Navigate to="/login"`. ✓ unchanged.
- The user lands on `/login`. If their session was genuinely terminated, they re-login → `storeSession()` overwrites stale `localStorage`. If it was a transient null, the next render's `validation` is the real session, `status` becomes `"active"`, RootLayout no longer redirects. ✓
- **No regression** in either case. The deletion is safe because the render-time branches already handle both meanings of `null` correctly.

**What about the `awaitSignedIn` 1500ms warm-up in `e2e/fixtures.ts`?** Still removable — the hook now never wipes `localStorage` based on a transient `null`, so the e2e specs don't need to wait for it to "settle" past the danger window. Test infrastructure benefits the same.

**Generalises to `useApproval.ts:22`:** same change — `if (res === null) return "missing"` becomes a status return, not a side-effecting wipe. (Actually `useApproval` *only* returns a status; it doesn't have a side-effecting wipe. So `useApproval` is fine with the existing render-time return — the bug there is purely a flash from `"pending"` → `"missing"` → `"pending"` during reconnect, which Option B doesn't address but Option C/D would. Worth noting but separate.)

**Risks:**

- **Stale `localStorage` lifetime.** A genuinely-dead session leaves `sessionId` in `localStorage` indefinitely until next login. **Impact:** zero — render-time logic already routes to `/login` when `validation === null`, and the next login overwrites the entry. No security concern (token without a server row grants nothing). No UX concern (user sees `/login` either way).
- **Cross-tab sync.** The current `notify(null)` on wipe fires same-tab listeners so multiple `useSession` mounts re-render. With Option B's deletion, that notify-on-wipe goes away — but cross-tab sync is only needed when storage actually changes, and B removes the only place where it would change due to query null. `clearSession()` (manual lock) and `storeSession()` (login) still notify correctly. ✓

**Reversibility:** trivial. ✓

**Test plan:** simpler than A. No fake timers needed. Five tests:
1. Mount with stored, mock=null → `localStorage` still has the value, status is `"none"` (the redirect is RootLayout's job, not the hook's).
2. Mount with stored, mock=real session → status `"active"`, `localStorage` untouched.
3. `clearSession()` → `localStorage` cleared, status `"none"`. (Existing behaviour.)
4. `storeSession(newId)` → `localStorage` has newId, status transitions to `"loading"` then `"active"`. (Existing behaviour.)
5. Mount with stored, mock=null → mock flips to real → status `"active"`, `localStorage` unchanged throughout. (The bug repro that A's tests cover — under B it passes trivially because the hook never touches `localStorage` for query-null.)

Notably no `vi.useFakeTimers()` plumbing. Simpler test, simpler hook.

**Verdict:** This is the fix. **Strongest recommendation.**

### Option C — Filter by Convex `ConnectionState`

**The API exists** (verified above) — `useConvex().connectionState()` and `subscribeToConnectionState(cb)` are available in 1.31.7. The fields `isWebSocketConnected` and `hasEverConnected` are the ones you'd use. So C is *implementable* — but it's solving the wrong problem.

**Where it fails:** even with WS connected and `hasEverConnected: true`, there's a brief window between "subscription reset" and "first real value arrives" where `useQuery` can emit a stale or null result. The Convex client doesn't expose a per-query "result is fresh" signal, only a transport-level "WebSocket is up" signal. So C catches the case where the WS itself is mid-flap, but not the case where the WS is healthy and the query layer is still synchronising — which is at least one of the failure modes described in the issue.

**Also:** `ConnDot.tsx` types `connectionState?` and `onStateChange?` as **optional with `?.()`** — meaning the team already signalled some uncertainty about the API's stability. Building load-bearing auth correctness on a defensively-typed API is a downgrade vs the deletion in B.

**Generalises:** technically yes — wrap every Convex-driven hook with a connection-state guard. But that's a lot of repeated plumbing for what is, fundamentally, the same logical mistake (treating absence-of-data as proof-of-deletion).

**Reversibility:** trivial. ✓

**Verdict:** rejected. The implementation effort isn't worth a partial fix when B is shorter and total.

### Option D — Tagged-union from `getSession`

**Architecturally the cleanest.** Server query returns:

```ts
return v.union(
  v.object({
    kind: v.literal("active"),
    sessionId: v.id("staff_sessions"),
    staff: v.object({ _id: v.id("staff"), name: v.string(), role: v.union(v.literal("staff"), v.literal("manager")) }),
    deviceId: v.string(),
    startedAt: v.number(),
  }),
  v.object({ kind: v.literal("ended"), endedAt: v.number(), endReason: v.string() }),
  v.object({ kind: v.literal("not_found") }),
);
```

Client maps `kind` → status; `null` from `useQuery` keeps its real meaning ("no response yet"); `"ended"` and `"not_found"` get distinct UX (today, both route to `/login` — but `"ended"` could surface a "you were locked out at <time>" toast). Removes the ambiguity at the source.

**Cost:**

- Backend: ~15 LOC in `convex/auth/public.ts` to add `returns:` validator + branch the existing logic.
- Frontend: ~10 LOC in `useSession.ts` to switch on `kind`. Render-time logic gets cleaner, not noisier.
- Migration: every existing `staff_sessions` row is `kind: "active"` by construction (the only way `getSession` returned a non-null object before was an active session) — no data migration. No other consumers of `getSession` (verified — only `useSession`).
- New pattern: tagged-union public-query return — net-new for this codebase. Worth documenting as an ADR if adopted as a general pattern.

**Why it's the runner-up not the winner:** for ONE query, the new-pattern cost isn't yet justified. If `getSession` is the only query that needs this shape, Option B is the same correctness outcome at half the cost. D becomes the right call once a second public query needs the same discriminator (e.g., a future `getCart` that has `"draft" | "abandoned" | "checked_out"`).

**Reversibility:** two reverts (server + client) but they're independently revertable — server can ship first with a backwards-compatible `kind`-or-fall-through return, client follows.

**Verdict:** the right long-term shape if/when `getSession` ever needs to distinguish more than "active" vs "everything else." For this PR alone, B beats it on cost.

---

## What to actually do

### Recommendation: ship Option B as a re-plan of the same v0.5.7.1 phase

**Concretely:**

1. **Re-spec.** Replace the current `docs/superpowers/specs/2026-06-05-useSession-transient-null-fix-design.md` with an Option-B-shaped design. Same problem statement, different Decision 1 (delete the effect, don't debounce it), different Test plan (no fake timers). Roughly 60% of the file rewrites; the e2e un-skip + fixture cleanup + CHANGELOG sections stay.
2. **Re-plan.** Replace `docs/superpowers/plans/2026-06-05-issue-44-usesession-transient-null-fix.md`. Tasks shrink — no more 5 timing tests, no more `vi.hoisted()` mock plumbing. The plan becomes a 4-task PR: (Task 0 hypothesis-verify is still cheap, keep it as defence-in-depth; even if hypothesis is refuted, Option B still removes the wrong coupling and is still right), Task 1 = delete the effect + minimal test, Task 2 = fixture cleanup, Task 3 = un-skip 6 specs, Task 4 = CHANGELOG.
3. **Update PROGRESS.md.** Same v0.5.7.1 phase; rewrite the task list to match the simpler plan. Reuse `v0571-fe-hook-fix` and `v0571-xc-fixture-cleanup` and `v0571-xc-unskip-specs` and `v0571-xc-changelog` task IDs — they all still apply, just with different subtasks.
4. **Open follow-up issue for Option D.** Title: *"Migrate `getSession` to tagged-union return shape (post-v0.5.7.1 cleanup)"*. Reference this review. Park it for when there's a second motivating query.
5. **Open follow-up issue for `useApproval` audit.** Title: *"Audit `useApproval` (and any other `useQuery` hook with destructive null-handling) for the same shape as issue #44"*. Smaller scope — `useApproval` is read-only (no `localStorage` wipe), but the `null → "missing"` mapping could still flash UI unnecessarily during a reconnect window. Worth a look.

### Alternative: bridge with A while B is being built

Only if there's schedule pressure to un-skip the 6 e2e specs faster than B can land:

1. Land A as planned (under v0.5.7.1) but **rename it in the PR + CHANGELOG** from "fix" to "mitigation."
2. Open the Option B issue **before** A's PR is merged.
3. Schedule B for v0.5.7.2 or fold into v0.5.8.

This is strictly worse than just shipping B directly (B is the same diff size as A in actual LOC), but it's defensible if there's some constraint not visible in the artefacts.

---

## Hybrid the team might be tempted by — DON'T

**"Ship B AND keep A as belt-and-braces."** Tempting because both feel safe. Don't: redundant code paths drift over time, and the debounce will be the surviving signal when someone later "simplifies" the deletion-shaped Option B. Pick one.

**"Ship A now, B later."** Same as the bridge above, except history says "later" tends to be "never" once a mitigation is in production and the symptom is no longer painful. If you go this route, the Option B issue must be opened in the same PR as A (not after), and it must be assigned and milestoned, not just filed.

---

## Risk: are we sure the null is even from Convex?

The plan's Task 0 — instrument and verify — applies just as well to Option B. **Keep it.** Even though B removes the wrong coupling regardless of the actual transient state, the hypothesis-verify pass tells us whether there's a *second* bug lurking (e.g., a Convex reconnect mode that drops subscription state entirely). If Task 0 shows `validation` stays `undefined` rather than going `null` between hard-nav and the redirect, that's a different signal worth chasing — and it would mean `RootLayout`'s gate logic itself is the issue (not the hook). Either way, the instrumentation pass is cheap and informs the next move.

---

## What "root cause" means here

The user's challenge was right: the debounce is a mitigation, not a root-cause fix. The actual root cause is **a layer-violation**: the client hook was using a query result as authorisation to mutate persistent client state, when the ADR explicitly defines only two legitimate sources of session-end (user Lock + server reaper). Option B removes the violation. Option D removes the upstream ambiguity that made the violation tempting. A and C just narrow the window in which the violation is observable.

Names matter here. If we'd called the original effect *"localStorage reaper effect"* instead of *"isDead effect"*, the layer violation would have been obvious at the design stage. The lesson worth filing alongside this review: **when a client hook performs a destructive persistent-state operation, name the operation after its semantic role and check whether anything in the ADRs authorises a client-side actor in that role.**

---

*Generated by /staffreview — architectural-options mode*

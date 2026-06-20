# Staff Review — `fix/handover-no-session-deadlock`

**Branch:** `fix/handover-no-session-deadlock` (head `af65c03`) · **Base:** `main` (`5809dff`)
**Date:** 2026-06-20 · **Scope:** RootLayout no-session redirect exemption for handover-in
**Files:** `src/components/layout/RootLayout.tsx`, `src/components/layout/__tests__/RootLayout.test.tsx`, `docs/CHANGELOG.md`

---

## Summary

**Verdict: architecturally sound as a hotfix.** Exempting `/shift/handover` from the no-session redirect *when the booth is genuinely `handover_pending`* is the correct seam for a live prod incident — it mirrors the existing `/login` exemption, is minimal (one effective line plus a derived flag), and upholds ADR-003/ADR-050 (the outgoing session still ends at handover-out; no departed-staff session lingers on the shared device). The rejected alternative — keeping the outgoing staff logged in until the incoming logs in — was **correctly rejected**: it reopens the exact accountability hole ADR-003 closes.

The fix is right, but it leaves the handover routing logic **split across two files** (RootLayout exempts the route; `login.tsx` drives the hop *into* the route) and the new gate has a **real-but-narrow loading-window edge case** where `boothState === undefined` can still bounce a legitimate handover-in to `/login`. Neither blocks the hotfix; both are worth a fast-follow. No graft risk to Frollie Pro (pure FE routing).

---

## Critical Issues

None. The fix does not introduce a security, correctness, or data-integrity regression. The session still ends at `handover_out` (ADR-050 §"Event types": `handover_out` → session ended `force_logout`), and the exemption is gated on live booth state so it cannot become a session-less backdoor into the app for any other route or any non-`handover_pending` state.

---

## Improvements

### 1. Loading-window race: `boothState === undefined` can still bounce a legitimate handover-in to `/login` (Important)

The new guard:

```ts
const isHandoverIn =
  location.pathname === "/shift/handover" &&
  boothState?.state === "handover_pending";
```

is evaluated against a hook that returns `undefined` while loading (`useBoothState` returns `undefined` until `useDeviceId` resolves *and* the `boothState` query resolves). The loading guard at line 66 only blocks on `session.status === "loading"` — it does **not** block on `boothState === undefined`. So the ordering is:

1. Device resolves, session resolves to `none`, but `boothState` is still `undefined` (query in flight).
2. Line 74 evaluates: `!isLogin && !isHandoverIn && session.status === "none"` → `isHandoverIn` is `false` (because `boothState?.state` is `undefined`) → **`Navigate to="/login"`**.

This is the *same class* of bug the fix is solving, just shifted earlier in the load. In practice the prod symptom ("login refreshing crazily") was the steady-state bounce, which this fix does cure — but a cold load of `/shift/handover` (PWA relaunch, hard refresh on the handover screen) with no session can still flash/redirect to `/login` before `boothState` resolves. Once on `/login`, `login.tsx`'s effect *will* hop back to `/shift/handover` once boothState resolves there — so it self-heals — but it reintroduces a one-cycle bounce and depends on the `login.tsx` effect to recover, which is exactly the fragile cross-file coupling flagged in #2.

**Recommendation:** hold the fallback while booth state is still resolving *on the handover route*. Either widen the loading guard so a session-less `/shift/handover` waits for `boothState`:

```ts
// Don't decide the no-session redirect for /shift/handover until booth state resolves.
if (location.pathname === "/shift/handover" && session.status === "none" && boothState === undefined) {
  return <RouteFallback />;
}
```

or treat `undefined` as "not yet known, don't redirect" for this route specifically. This closes the cold-load window without weakening the stale/manual-visit redirect (which still fires once boothState resolves to a non-pending state). Low risk, ~3 lines, worth doing in the same PR if time permits; otherwise a fast-follow with an issue.

### 2. Routing logic split across RootLayout and login.tsx (Important — design coherence, not a bug)

The handover routing is now a two-party contract:

- **RootLayout** *exempts* session-less `/shift/handover` when `handover_pending`, AND (lines 109–111) *forces* an active session toward `/shift/handover` when `handover_pending`.
- **login.tsx** (lines 46–50) *also* forces `handover_pending` → `/shift/handover` via its own effect.

So `handover_pending → /shift/handover` is now enforced in **two** places (RootLayout's SOP gate for active sessions, login.tsx's effect for the no-session case), and the no-session *exemption* lives in a third spot (the new `isHandoverIn`). A reader has to hold all three to understand why a session-less device lands on the handover screen.

The cleaner end-state is to **centralize handover-in routing in RootLayout** and delete the `login.tsx` effect:

- RootLayout already runs on every route and already owns the booth-state SOP gate. It could redirect a session-less device to `/shift/handover` when `handover_pending` (instead of `/login`), making `login.tsx` purely a PIN screen with no booth-state branching for handover. That removes the cross-file deadlock surface entirely — there is no longer a "login.tsx hops one way, RootLayout hops the other" tension to get wrong.

**However** — weighed against hotfix-minimalism for a live incident, the current change is the right call *now*. Centralizing means touching `login.tsx`'s effect (which itself was recently churned — PR #104/#106 login-nav regressions are fresh in MEMORY), and a routing rewrite under incident pressure is how you trade one prod bounce for another. **Recommendation:** ship as-is; open a fast-follow issue to consolidate handover-in routing into RootLayout and drop the `login.tsx` effect, with the regression tests as the safety net. Note the duplication in the issue so it isn't lost.

### 3. The active-session SOP gate and the no-session exemption now both encode `handover_pending` (Improvement)

`boothState?.state === "handover_pending"` now appears at lines 62 and 109 of RootLayout with opposite intents (exempt vs. force). They're correct together, but a future edit to one is easy to make without the other. A single derived `const isHandoverPending = boothState?.state === "handover_pending"` reused in both predicates would make the relationship explicit and prevent drift. Trivial, optional.

---

## Refinements

### 4. Test coverage is good but misses the loading-window case (Minor)

The two new tests cover (a) session-less + `handover_pending` → renders handover, and (b) session-less + `open` → redirects to login. Both are exactly right. Missing: session-less + `boothState === undefined` (loading) on `/shift/handover` — the case in #1. Add a test asserting the desired behavior (RouteFallback, or no premature `/login` redirect) so the fast-follow has a red test to drive it. Aligns with the `RootLayout.test.tsx`-only-catches-it-in-tree lesson from the PR #104/#106 login-nav postmortem (jsdom unit tests missed the RootLayout unmount interaction — this is the right place to add the missing case).

### 5. Comment quality is excellent — keep it (Nitpick / positive)

The inline comment block (lines 52–59) and the test header comment fully explain the deadlock mechanism, the prod incident, and *why* the gate is on live booth state. This is the POC-tradeoff-comment-inline discipline done well; future reviewers won't need to reconstruct the incident. No change requested.

### 6. CHANGELOG ops note is the right level of detail (Nitpick / positive)

The CHANGELOG entry documents the manual prod remediation (`signoff_close` to reset the stuck device, with the no-double-count rationale tied to the `handover_out` summary already being captured). That's the correct operational paper trail for a state-machine incident and matches ADR-050's summary-capture model. Good.

---

## ADR / Plan Fidelity

- **ADR-050 (booth state machine):** Upheld. The fix respects the documented contract that handover-in is a *fresh login by the incoming staff* (`handover_in` event, "incoming staff already logged in" — the login happens inside the screen). The exemption simply makes that screen *reachable* in the session-less window that `handover_out` deliberately creates.
- **ADR-003 (ephemeral session):** Upheld and explicitly so — the outgoing session still ends at handover-out; the device is correctly session-less during `handover_pending`. The fix does not resurrect the rejected "keep outgoing logged in" model.
- **Rejected alternative verdict:** Correct rejection. Keeping the outgoing staff authenticated on a shared booth device to dodge the routing deadlock would trade a 5-line routing fix for a standing identity/audit hole — directly contradicting ADR-003's core decision and ADR-050 §"Event types". The chosen fix solves the routing problem at the routing layer, where it belongs.

## Frollie Pro graft risk

None. This is pure frontend route-gating in the POS shell; no schema, no API surface, no `convex/api/v1/` impact. The handover state machine itself (the graftable part) is untouched.

---

## Disposition

**Approve for merge as a hotfix.** Recommended follow-ups (open as issues, not merge-blockers):
1. Close the `boothState === undefined` loading-window bounce on session-less `/shift/handover` (#1) — add the guard + a regression test (#4). *Strongly recommended; small.*
2. Consolidate handover-in routing into RootLayout and drop the `login.tsx` effect (#2). *Design hygiene; do when not under incident pressure.*
3. Optional: factor `isHandoverPending` to share the predicate (#3).

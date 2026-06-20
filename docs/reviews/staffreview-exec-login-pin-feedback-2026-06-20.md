# Staff Review — `exec-login-pin-feedback` (v1.2 #7 + #11)

**Reviewer lens:** senior-engineer architectural review through ADR-034 deep-module / surface-API philosophy and component-composition discipline.
**Branch:** `exec-login-pin-feedback` · **Base:** `056943e` (main) · **Head:** `937019f`
**Scope:** frontend-only — no Convex module changes. Date: 2026-06-20.

---

## Summary

**Verdict: the smart-container / dumb-component split is clean and earns its prop surface — `PinEntry` is genuinely presentational, `login.tsx` owns the async `Phase` machine, and the pattern is a faithful, slightly more capable echo of `PinSheet`.** The denial-dedup extraction to `pinResetDenials.ts` is the right home; the `NumericKeypad disabled` prop is a correctly-scoped shared-component change. The one real architectural seam is in the success path: the ADR-050 booth-navigation fork now runs an `await recordResume(...)` *inside the same `try` that owns PIN-auth*, so a shift-state race surfaces as a "login error" after the session is already stored. That coupling is contained in the route (good) but its failure semantics are wrong (flagged Important). Everything else is refinement-grade. No critical blockers.

---

## Critical Issues

None.

The change is FE-only, reversible by PR revert (no deploy-skew, no schema, no mutation↔action rename), and the PIN/idempotency contracts (`pinReset` → fresh `idempotencyKey`, ADR-013) are preserved untouched. No backend-module boundary is violated; the FE reaches Convex only through the existing `api.*.public` / `api.*.actions` surfaces (`getActiveStaff`, `loginWithPin`, `recordResume`, `getRecentPinResetForStaff`) — all legitimate surface APIs per ADR-034.

---

## Improvements

### 1. (Important) Success path conflates PIN-auth failure with shift-state failure — `recordResume` throwing renders a "login error" on an authenticated session

`src/routes/login.tsx:133-173`. The success branch is:

```ts
const { sessionId } = await login({ ... });
storeSession(sessionId, stage.staff._id);   // session now persisted — user IS authed
...
} else if (boothState?.state === "locked" && stage.staff._id === boothState.staffId) {
  await recordResume({ idempotencyKey: `${idempotencyKey}:resume`, sessionId });  // can throw BOOTH_NOT_LOCKED
}
setPhase({ kind: "success" });
```

`recordResume` is a write-side-guarded mutation that throws `BOOTH_NOT_LOCKED` (`convex/shifts/public.ts:601`) if the booth left `locked` between the login screen rendering and the staffer completing the PIN — a real race on a shared device (another staffer resumes, a manager takes over). Because the `await recordResume` sits inside the same `try`, a throw jumps to the generic `catch`, which:

- maps the error to an inline red `FieldMessage` (showing the raw `BOOTH_NOT_LOCKED` string, since it matches neither `LOCKED_OUT:` nor `INVALID_PIN`),
- bumps `pinReset` (clearing the buffer),
- and leaves the staffer staring at a "login failed"-style message — **even though `storeSession` already ran and they are authenticated**.

This is a separation-of-concerns leak: the route's catch is an *auth*-error handler, but it is now also catching a *shift-lifecycle* error and presenting it in the auth channel. The maintenance hazard for the shift-SOP module (your Focus #4) is exactly this: a future change to `recordResume`'s guard semantics silently changes login-screen error behavior, with no test covering the path (the success test mocks `boothState` undefined, so `recordResume` is never exercised in the suite).

**Recommended fix (contained, no new abstraction):** wrap only the resume call so a resume failure still lands the user home — the session exists; navigation should proceed and the resume is best-effort / re-attemptable from the shift surface:

```ts
if (boothState?.state === "locked" && stage.staff._id === boothState.staffId) {
  try {
    await recordResume({ idempotencyKey: `${idempotencyKey}:resume`, sessionId });
  } catch {
    // Booth state raced (e.g. takeover) — auth still succeeded; let the shift
    // surface reconcile rather than presenting a shift error as a login error.
  }
}
setPhase({ kind: "success" });
```

Add a regression test driving `boothState: "locked"` + a rejecting `recordResume` and asserting the user still reaches success/navigate (or at minimum does not render an `INVALID_PIN`-style alert). This keeps the ADR-050 fork in the route (correct altitude) while severing the failure-mode coupling.

### 2. (Minor) Stale 4-digit buffer survives the device-not-ready early return

`login.tsx:127-130`. The `deviceNotReady` guard sets `phase: error` and returns **before** `setPinReset((n) => n + 1)`. So the buffer keeps the 4 digits the staffer just entered. Because the error is non-sticky, `PinEntry`'s `showMessage` derives `buffer.length === 0`-false → the message is hidden immediately (the dots are full), and the keypad is live but `length >= 4` blocks further digits until a backspace. Net effect: a momentary state where the message can't show and input feels dead. It's a narrow window (device-id resolving from IDB), but the other two error returns clear the buffer and this one doesn't — an inconsistency worth a one-liner (`setPinReset((n) => n + 1)` before the early return, or fold the guard into the catch-style mapping).

### 3. (Minor) `successTimer` overwrite is unguarded (defensive only)

`login.tsx:43-46,155`. The cleanup effect runs on unmount (`[]` deps), which is correct for the documented "fast unmount" case. But if `onPinSubmit` ever ran twice into the success branch, the second `window.setTimeout` would overwrite `successTimer.current` and orphan the first timer. Today this is unreachable — `PinEntry` disables the keypad on `phase === "success"` so no second submit can occur. It's safe, but a `if (successTimer.current) clearTimeout(...)` before assignment would make the invariant local rather than relying on a sibling component's disabled prop. Optional.

---

## Refinements

### 4. Component composition — clean, earns its surface, mirrors `PinSheet`

`PinEntry`'s new prop surface `{ onSubmit, reset, pending, phase, message, persist }` is well-judged:

- **`phase` as a flat 3-value string** (`idle|error|success`) rather than re-exposing the parent's 4-arm discriminated union is the right altitude — the leaf never sees `pending` *and* `phase` collapsed together, and `login.tsx` does the projection inline at the call site (`login.tsx:223-231`). The leaf stays presentational; no async logic leaked downward. This is textbook smart-container/dumb-component and matches the plan's stated architecture.
- **`persist` modeled as a leaf-derived clear rule** (`showMessage = !!message && (phase !== "error" || persist || buffer.length === 0)`, `PinEntry.tsx:57-58`) is the cleanest available choice: the buffer lives in the leaf, so the "hide on next keystroke" behavior is derivable locally with *no new parent callback*. Modeling `sticky` on the parent's `error` arm and flattening it to `persist` at the boundary is correct — `sticky` is auth-domain knowledge (only `LOCKED_OUT` is sticky), `persist` is a presentation concern. Good separation.
- **Consistency with `PinSheet`:** `PinSheet` already threads `pending` + `error` + the same `Loader2` spinner + the same buffer-clear-on-error effect. `PinEntry` is a strict superset (adds tinted dots, success tone, the `persist` rule). The two now share `NumericKeypad`'s `disabled` prop. The only divergence: `PinSheet` renders its own raw error `<p role="alert">` (`PinSheet.tsx:96-100`) while `PinEntry` uses the `FieldMessage` primitive. That's an acceptable asymmetry for this PR (PinSheet is explicitly out of scope per ADR-048 / the plan), but it leaves the codebase with two PIN error renderers — worth a backlog note so a later slice converges `PinSheet` onto `FieldMessage` too. Not this PR's job.

### 5. State machine — right altitude, not over-engineered

The `Phase` union (`idle | pending | error{message,sticky} | success`) is the minimum that captures the real states; nothing speculative. `sticky` is the only payload beyond `message` and it's load-bearing (drives the lockout-banner persistence). I'd not add more arms for v1. One observation: `phase` is reset to `idle` on every `stage` change (`login.tsx:87-89`), which correctly clears a stale message when switching staff — good defensive wiring that the plan called out and the executor kept.

### 6. `pinResetDenials.ts` — correct home, reusable, no login leakage

Extracting the dedup to `src/lib/pinResetDenials.ts` over a `storage-keys.ts` constant is the right call: it's a pure, testable, framework-free helper (`hasShownDenial` / `markDenialShown`) with a malformed-JSON guard, and it imports *nothing* from `login.tsx` — zero coupling back to the consumer. The `localStorage`-over-`useRef` fix is the correct mechanism for the remount-refire (the ref reinitializes per mount; the issue #11 root cause). Tests cover the four meaningful cases (unseen, persisted, idempotent, malformed). This is exactly the deep-module ethos applied to the FE: a small surface (`has`/`mark`) hiding the JSON-array-in-localStorage detail. Nothing to change.

One forward-looking note (not a defect): the array grows unbounded — there's no TTL sweep. The plan explicitly accepted this ("the 10-min server window bounds relevance"), and the volume is trivially small (one entry per genuine denial), so it's fine. If denial volume ever grows, a cap/sweep belongs *in this helper*, which is precisely why having it as a module pays off.

### 7. `NumericKeypad disabled` — correctly-scoped shared-component change

Adding `disabled` to the shared keypad (used by both `PinSheet` and `PinEntry`) is the right place for the lock, and the implementation is complete: native `disabled` on all three button kinds (inherits `Button`'s `disabled:pointer-events-none` + scale-suppression — reused, not re-added) **plus** the `document` keydown early-return (`NumericKeypad.tsx:42`). The keydown guard is the real new logic — a physically-held hardware key bypasses `pointer-events`, and that's correctly closed with `disabled` added to the effect deps. `PinSheet` doesn't pass `disabled` yet (it guards in its own handler), so no behavior change leaks into it — backward compatible. Clean.

### 8. i18n integration — consistent with ADR-049, minor namespacing duplication

Both new keys (`pinEntry.verifying`, `login.welcome`) are added to `en.ts` (source of truth) and `id.ts` (`Record<keyof typeof en, string>`), so the `tsc` exhaustiveness guard is satisfied; both have real ID translations (`Memverifikasi…`, `Selamat datang`), not English placeholders. Namespacing (`pinEntry.*`, `login.*`) follows the established dotted-prefix convention. Two small things:

- **`pinEntry.verifying` is byte-identical to the existing `pinSheet.verifying`** in both locales. Two keys for the same string across two PIN surfaces is defensible (per-surface namespacing lets them diverge later), and it matches ADR-049's per-surface key style — but it's a duplicate today. Acceptable; flagging only so a reviewer doesn't mistake it for an oversight. A shared `keypad.verifying` would have been DRYer, but cross-namespace sharing isn't the established pattern here, so I'd leave it.
- The lockout copy is interpolated as a single template (`login.errorLockedOut` with `{seconds}`), not concatenated — correct per the plan's "no concatenation" extraction rule. The success path keeps the literal channel out of the ESLint i18n fence because the message is routed through `t()`.

### 9. ESLint fence registration — correct and load-bearing

`login.tsx` is appended to the ADR-048 `no-restricted-syntax` migrated-file registry (`eslint.config.js:171`). This is correct: the route's sync `INVALID_PIN` / device-not-ready toasts became inline `FieldMessage`, so the file is now a converted file and must be fenced against literal-arg `toast.error` regression. The surviving denial `toast.error` is a `t(...)`-call first arg (a `CallExpression`, not a `Literal`/zero-expression `TemplateLiteral`), so it's legal under the fence — verified against the selector in ADR-048. Good adherence to the "register on convert" rollout rule.

### 10. Tests — adequate and honest

The TDD-per-task structure landed: `NumericKeypad` (disabled/keydown/pressed), `PinEntry` (spinner/error/persist/success), `pinResetDenials` (4 cases), `StaffListItem` (presence), and `login` (INVALID_PIN inline + no-toast, LOCKED_OUT persistent, success→navigate, denial-once-across-remount). The remount-dedup test is the evidence-first #11 regression the postmortem rule demanded. The args-based `useQuery` discrimination (replacing the brittle call-order slotting) is a genuine improvement to the harness robustness. **Gap:** no test exercises the `boothState: "locked"` + `recordResume` success branch (see Improvement #1) — the ADR-050 fork in the success path is untested here, which is precisely the branch with the failure-mode coupling.

---

## STAFFREVIEW FINDINGS

### Critical
- None.

### Important
- **Success path catches `recordResume` (shift-lifecycle) failures in the auth-error channel** (`login.tsx:148-151` inside the submit `try`). A `BOOTH_NOT_LOCKED` race after `storeSession` renders a raw inline "login error" on an already-authenticated session and bumps `pinReset`. Wrap the `recordResume` call in its own try/catch so resume failure still navigates home; add a test for `locked` + rejecting `recordResume`. This is the ADR-050/route coupling seam (Focus #4) — contained in the route, but with wrong failure semantics and zero test coverage.

### Minor
- **Stale 4-digit buffer survives the device-not-ready early return** (`login.tsx:127-130`) — `setPinReset` is skipped on that path, unlike the other error returns; momentary dead-input window. Add the buffer reset for consistency.
- **`pinEntry.verifying` duplicates `pinSheet.verifying`** byte-for-byte in both locales. Defensible per-surface namespacing, but a true duplicate today; flag, don't necessarily fix.

### Nitpick
- **`successTimer` overwrite is unguarded** (`login.tsx:155`) — safe today only because `PinEntry` disables input on `success`; a local `clearTimeout` before reassignment would make the no-double-fire invariant self-contained rather than dependent on a sibling component's prop.
- **`PinSheet` still renders a raw `<p role="alert">` while `PinEntry` uses `FieldMessage`** — two PIN error renderers now coexist. Out of scope for this PR (ADR-048 fences PinSheet off), but worth a backlog note to converge later.

## STAFFREVIEW COMPLETE

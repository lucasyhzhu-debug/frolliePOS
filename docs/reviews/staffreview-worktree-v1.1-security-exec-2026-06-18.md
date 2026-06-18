# Staff Review: v1.1 Security Hardening — Implementation (`worktree-v1.1-security-exec`)

**Date:** 2026-06-18
**Branch:** `worktree-v1.1-security-exec` · **Base:** `c60bf2b` · **Head:** `e6acfd8`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture, ADR-034 lens)
**Scope:** Plan-to-implementation fidelity for SEC-01..07 + module-depth / graft-integrity judgment.
**Verification:** `npm run typecheck` clean (`tsc -b && tsc -p convex`); `npx vitest run` on auth/staff/transactions/payments/seed/approvals → **315 passed / 52 files**.

---

## Summary

**Verdict on module depth: modules stayed deep and the new internal seams are earned — one file-placement slip (`_activateDeviceCommit_internal` is an `internalMutation` living in `staff/public.ts`, the only such case in the repo) is the lone convention break; everything else is clean.**

This is a high-fidelity, disciplined execution. All seven findings are closed, each with a red→green regression test, and the two Critical plan-staffreview gaps (C1 `intent` arg, C2 `_getCurrentInvoice_internal` system caller) plus both Improvements (I1 don't-wipe-pending, I2 receipt via projection-not-token) are honored in the built code. The one deliberate deviation from the plan — promoting `activateDevice` from a `mutation` to an `action` — is the **correct** call, well-reasoned in code comments, and cleanly executed: a throwing mutation rolls back its own writes, so a throttle counter incremented inside the rejecting transaction could never persist. The executor correctly recognized this is the same shape as the `loginWithPin → _recordFailedAttempt_internal` pattern (commit attempt in one tx, record-failure in a separate committed tx) and mirrored it.

The new internal variants are not shallow pass-throughs: `_getTxnById_internal` / `_getCurrentInvoice_internal` exist because the public seams genuinely changed contract (gated + projected), so system callers need an un-gated full-row read — that is the textbook ADR-034 "data is private; the public surface is a contract" split, not duplication. The public surface widened only where appropriate (`sessionId` added to `getById`/`getCurrentInvoice`; both were IDOR holes). Graft integrity is intact: no internal field shape leaked into any `api/v1/` surface, and the projections actually *narrow* what crosses the FE boundary.

No Critical issues. One Important (file placement), a few Minor/Nitpick.

---

## Critical Issues

None. The build is green, all SEC-NN have regression coverage, and no security regression or graft hazard was found.

---

## Improvements (Important)

### IM-1 — `_activateDeviceCommit_internal` is an `internalMutation` in `staff/public.ts` (only one in the repo)
`convex/staff/public.ts:188` declares `_activateDeviceCommit_internal = internalMutation({...})`. A grep across all `**/public.ts` confirms this is the **sole** `internalMutation`/`internalQuery`/`internalAction` defined in any `public.ts` file in `convex/`. The two sibling helpers added in the same task (`_recordActivationFailure_internal`, `_getActivationLockState_internal`) correctly live in `staff/internal.ts`; this one didn't move with them.

- **Not a security leak.** Convex does not expose `internal*` functions to clients regardless of which file they sit in, and the action references it as `internal.staff.public._activateDeviceCommit_internal`, so it works.
- **It is an ADR-034 convention break.** §"Layer 1" is explicit: "A module's `internal.ts` exports `internalQuery`/`internalMutation`." Mixing an internal mutation into `public.ts` is exactly the "any function might be called by anything" blur the ADR exists to prevent. It also forces `import { internalMutation }` into a file whose job is the public surface, and produces the slightly jarring `internal.staff.public.*` reference path (internal-namespaced through a `public` file).

**Recommendation:** move `_activateDeviceCommit_internal` to `convex/staff/internal.ts` (next to its two siblings); update the single reference in the `activateDevice` action to `internal.staff.internal._activateDeviceCommit_internal`. The `withIdempotency` wrap and the body are unaffected. Pure relocation; no behavior change. Low effort, restores the invariant that `public.ts` contains only the client-facing surface.

---

## Improvements (Recommended)

### IM-2 — `pos_device_activation_attempts` is missing from the ESLint `OWNERSHIP` map
The new table is defined in `convex/auth/schema.ts` but `eslint.config.js`'s `OWNERSHIP` map (lines 24–59) was not updated to add `pos_device_activation_attempts: "auth"`. Per the map's own comment ("Tables not present here are unpoliced"), the table is currently **invisible to the module-boundary lint** — `staff/` writing it is fine today (the write is sanctioned, and `staff` is allowlist-exempt anyway), but a future stray cross-module `ctx.db.*("pos_device_activation_attempts")` from an unrelated module would **not** be flagged. This is a quiet erosion of the ADR-034 hard CI gate, the same class of drift the v0.5.5/v1.0 lessons flagged for multi-writer tables.

**Recommendation:** add `pos_device_activation_attempts: "auth"` to `OWNERSHIP`. It's authored by `staff/` (allowlisted) but lives in the auth schema fragment, so `"auth"` is the correct owner — consistent with how `staff`, `registered_devices`, `pending_device_setups` are mapped to `"auth"` while `staff/` writes them under the allowlist exemption (lines 63–65). One line; closes the policing gap.

### IM-3 — Throttle double-counts a retried wrong guess by design; confirm that's acceptable for the global cap
Because `activateDevice` is now an action and the throttle increment runs in `_recordActivationFailure_internal` (un-cached, deliberately), a genuine network retry of the *same* wrong-code call increments both the per-device and the **global** counter twice. For the per-device counter this is the intended fail-safe (locks slightly sooner — same rationale as SEC-01). For the **global** rolling-window cap (50/15min) it means a flaky network during a legit activation burst could nudge the shared ceiling faster than the true failure count. The blast radius is bounded (a 60s window-block, no pending-setup wipe per I1) and the realistic legit failure rate is tiny, so this is almost certainly fine — but it's worth a one-line comment on the global path noting the global counter can over-count on retry, so a future tuner doesn't treat the count as exact. No code change required.

---

## Refinements (Minor / Nitpick)

### R-1 (Minor) — `getById` projection now returns `confirmed_via`, which the audit said to strip
The audit/spec language for SEC-05 said to drop `xendit_*`/`confirmed_*`. The shipped projection (`transactions/public.ts`) intentionally **keeps** `confirmed_via` and `receipt_number`. This is **correct, not a regression**: `charge-success.tsx:106-112,132` genuinely consumes both (`confirmed_via` → method label, `receipt_number` → display). `confirmed_via` is a benign enum (`"manual"|"webhook"|...`), not a capability like `receipt_token`. The projection rightly drops the actual capabilities (`receipt_token`, `xendit_invoice_id_current`) and keeps only consumed display fields — exactly the I2 intent. Flagging only because the field name pattern-matches the spec's "strip `confirmed_*`" phrasing; the implementer made the right judgment over the literal instruction. Worth a one-word note in the projection comment that `confirmed_via` is a label, not a capability.

### R-2 (Nitpick) — `idempotencyKey` retained-but-unused on `verifyPinOrThrow` (acknowledged debt)
Per the plan's deliberate decision (I3), `params.idempotencyKey` is still on the `verifyPinOrThrow` signature but no longer consumed by the failed-attempt path; the code comment says so and points to a follow-up. Correct scoping for a security phase (dropping it ripples through every PIN-gated admin caller). Confirm the follow-up issue is actually filed (the comment promises one) so the dead param doesn't ossify.

### R-3 (Nitpick) — RootLayout module-level `Set` for the rotation prompt: acceptable, with one caveat
The `rotationPrompted` module-level `Set<string>` (RootLayout.tsx) is keyed on `sessionId` and is the right call for soft, once-per-session enforcement without a hard-block re-trap loop. State-hygiene notes: (a) it grows unbounded across many logins in a single long-lived app instance — negligible for a single-device booth PWA, but technically a tiny leak; (b) it does not survive a reload, so a manager who reloads before rotating gets re-prompted once more — which is *desirable* for a security prompt, not a bug. The chosen approach (module Set + server-side flag clear on `changePin`) is pragmatic and correct for the threat model. No change needed; noting for the record since the objective called it out.

### R-4 (Nitpick) — `must_change_pin` only hardens future deploys, as documented
Correctly disclosed in the plan limitation (I2), CHANGELOG, and CLAUDE.md: the idempotent `bootstrap` guard means the *live* S-0001 is hardened only by the operational PIN rotation in the handoff pre-flight, not by this merge. The code is right; the residual is operational and is flagged in three places. Ensure the prod pre-flight (set `BOOTSTRAP_MANAGER_PIN` on dev+prod; rotate live S-0001 + set its `must_change_pin`) is executed before any future `bootstrap`.

---

## Graft Integrity (ADR-034 Layer 2/3)

Clean. No change touches `convex/api/v1/`. The projections added at the FE boundary (`getById`, `getCurrentInvoice`) *reduce* the field surface crossing into the frontend and do not introduce any new internal-shape coupling. The new `pos_device_activation_attempts` and `staff.must_change_pin` are POS-internal tables/fields, never part of the external contract — consistent with the ADR's "data is private" layer. The `sessionId` widening on the two public queries is internal-FE-only (POS UI ↔ POS backend), not an external-consumer concern. Nothing here locks in an assumption that hurts the v1.1+ cross-deployment integration.

---

## Plan Fidelity Matrix

| Item | Plan said | Built | Verdict |
|---|---|---|---|
| SEC-01 | drop `withIdempotency`, key on `staff_id`, `countTowardLockout` | done; 5 telegram sites + booth funnel swept; "Fix 10" test migrated | ✅ |
| SEC-02 | `Number.isInteger(qty) && qty>0` after EMPTY_CART | done at the boundary; test uses required `intent` arg (C1) | ✅ |
| SEC-03 | env PIN + `must_change_pin` + FE prompt + flag clear in commit funnel | done; flag cleared in `_changePinCommit_internal` (single funnel, rule #18) | ✅ |
| SEC-04 | throttle table + per-device + global cap + 15min TTL; **mutation, "increment then throw"** | **deviated → action**; per-device + global; TTL 15min; pending NOT wiped (I1) | ✅ deviation correct |
| SEC-05/06 | session-gate + project + internal full-row variants for system callers | done; both internal variants added; all 4 system callers repointed | ✅ |
| SEC-07 | off-booth approve audits without touching booth lockout | done via `countTowardLockout:false` at all 5 telegram sites | ✅ |
| C1 (plan SR) | add `intent` to Task-1 test | honored | ✅ |
| C2 (plan SR) | add `_getCurrentInvoice_internal`, repoint `payments/actions.ts:97` | honored | ✅ |
| I1 (plan SR) | global breach blocks window, don't wipe pending | honored + asserted in test | ✅ |
| I2 (plan SR) | receipt via projection, not `receipt_token` off `getById` | honored; `receipt_number` kept, token dropped | ✅ |

**The activateDevice mutation→action deviation:** the right call, cleanly executed. The plan's "increment then throw" inside a mutation is self-defeating (the throw rolls back the increment). The executor caught this, switched to the established `loginWithPin` action pattern, preserved the public API path (`api.staff.public.activateDevice`) so the FE/test change was a minimal `useMutation→useAction` / `t.mutation→t.action` swap, and gated the throttle so format/label/already-registered errors don't count (only genuine `INVALID_CODE` code-guesses do). Well-judged.

---

## Over- / Under-Engineering

Balanced. The throttle table reuses the auth-lockout shape (`getActivationAttempt` mirrors `cleanupAndGetAttempt`, including the dedupe-on-collect defense) rather than inventing a new abstraction — appropriate reuse, not copy-paste bloat (the keys and constants genuinely differ). The global sentinel-row design is the minimum needed to defeat device_id rotation. No premature generality (no shared "rate-limiter" module spun up for two call sites). Nothing under-built: every finding has real coverage including the cross-channel SEC-07 no-booth-lock regression and the device_id-rotation global-cap test.

---

## Approval

**Approve** with one Important nit to address before/at merge:
1. **IM-1** — relocate `_activateDeviceCommit_internal` from `staff/public.ts` to `staff/internal.ts` (convention; pure move).

**Recommended (can fold into IM-1 commit):**
2. **IM-2** — add `pos_device_activation_attempts: "auth"` to the ESLint `OWNERSHIP` map.
3. **R-2** — confirm the `idempotencyKey`-removal follow-up issue is filed.

Everything else is informational. Build is green; the security posture is materially improved with no graft or module-depth regression.

---

*Generated by /staffreview (implementation review)*

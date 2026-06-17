# Staff Review: v1.1 Security Hardening — Design Spec

**Date:** 2026-06-17
**Plan:** `docs/superpowers/specs/2026-06-17-v1.1-security-hardening-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ This is a *design spec*, not a full plan — Testing/Success/Rollback sections are deferred to the forthcoming PLAN (per spec→plan pipeline). Per-group test sketches are present inline. Not penalised.

---

## 1. Summary

**Overall Assessment:** Revise (address C1–C2 inline, then proceed to planning)

The spec is well-grounded — fix groups map cleanly to verified findings, follow in-repo patterns (`QTY_INVALID` guard, `getTransactionDetail` gating, `pos_auth_attempts` shape), and the SEC-01⇄SEC-07 coupling rationale is correct and load-bearing. Two gaps would bite during implementation if not surfaced now: an **existing test that asserts the exact behavior SEC-01 removes** (silent CI break), and an under-enumerated **all-callers sweep** for the `_recordFailedAttempt_internal` signature change. Both are cheap to fix in the spec and must be explicit tasks in the plan.

**Evidence-Before-Mitigation Gate (§4.9):** ✅ PASS. These are security *fixes* with verified mechanisms, not flake/race mitigations. Each finding cites `file:line` and survived adversarial verification in `docs/reviews/security-audit-2026-06-17.md` (the artefact). No Task-0 instrumentation gate required.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | Existing test asserts the behavior SEC-01 removes | Testing | Group A |
| C2 | `_recordFailedAttempt_internal` signature change not swept across all 6 call-sites | Implementation | Group A |

### C1: SEC-01 fix breaks an existing test that codifies the vulnerable behavior
`convex/auth/__tests__/auth.test.ts:261` — `describe("Fix 10: _recordFailedAttempt_internal is idempotent")` calls the mutation twice with the same derived key and asserts `fail_count === 1`. That is **the exact dedup behavior SEC-01 eliminates.** The spec's Group A says "remove the wrap" but never mentions this test, so an implementer would hit a red suite mid-task and risk "fixing" it back toward the vulnerable behavior.

**Recommendation:** the plan must include an explicit task to **rewrite** this test to assert the new contract — two calls (same or different key) → `fail_count === 2`; three calls → `locked_until` set / `newly_locked: true`. Re-frame it from "Fix 10 idempotent" to a regression test for the SEC-01 brute-force fix. Also grep `convex/auth/__tests__/lockoutScheduler.test.ts` and `auth.test.ts` for any other assertion depending on the derived-key arg.

### C2: Signature change to `_recordFailedAttempt_internal` must sweep all writers
Dropping `idempotencyKey` from the mutation args + adding `countTowardLockout` touches **6 runtime call-sites**, not just `verifyPinOrThrow`:
- `convex/auth/verifyPin.ts:48` (booth funnel — `countTowardLockout: true`, stop passing `${key}:failed`)
- `convex/approvals/actions.ts:180` (approveStaffPinReset), `:429` (approveManualPayment), `:577` (approveRefund), `:706` (denyRequest), `:992` (approveSpoilage) — all currently pass `idempotencyKey: \`${args.idempotencyKey}:failed\`` + `source: "telegram_approval"`; all must switch to `countTowardLockout: false` and drop the derived key.

This is the recurring "single-writer refactor must sweep ALL writers" lesson (see `v0.5.7` and `v1.0` lessons memories). **Recommendation:** the spec's Group A and the plan must enumerate all six sites + the C1 test as the definition-of-done for the signature change. Confirmed via grep — these are the complete set.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | SEC-04 global ceiling under-specified; per-device throttle alone is bypassable | H | M |
| I2 | SEC-03 `must_change_pin` does NOT retroactively protect live prod | M | L |
| I3 | `verifyPinOrThrow` `idempotencyKey` param becomes droppable — answer open-Q#5 | L | L |
| I4 | Confirm `getCurrentInvoice`/`getById` system callers before adding `sessionId` | M | L |

### I1: SEC-04 — the global ceiling is the load-bearing part; concretize it
The attacker chooses `deviceId` (it's an unvalidated arg), so a **per-device** throttle is trivially bypassed by spraying fresh `deviceId`s. The global rolling-window ceiling + pending-setup invalidation is therefore the real defense, yet the spec describes it as "plan to define threshold + window." That can't stay vague. **Recommendation:** the plan must pin concrete numbers — e.g. global cap of N failed activations per rolling W minutes (sized so a legit booth never trips it but 450k brute-force guesses do), and on breach, invalidate all live `pending_device_setups` + audit. Note the shorter 15-min TTL multiplies the attacker's required request-rate, so the two mitigations compound.

### I2: SEC-03 — state plainly that the code fix does not protect the existing live account
`bootstrap` is idempotent-guarded ("aborts if staff exist") and prod is already bootstrapped (`prod-cutover-2026-06-03` memory). So the env-PIN + `must_change_pin` changes only protect **future fresh deploys and tests** — the live S-0001 account is unaffected until the **operational** rotation runs. The spec mentions the op but should explicitly say the code change is *not* a retroactive fix, so no one assumes prod is hardened by merging this. **Recommendation:** one sentence in Group C; keep the rotation in the execution handoff's pre-flight.

### I3: Answer open-question #5 now
Confirmed: `loginWithPin`'s success idempotency is `_loginCommit_internal` (separately `withIdempotency`-wrapped, called from the action body — not via `verifyPinOrThrow`). `verifyPinOrThrow` used `idempotencyKey` *only* to derive the `:failed` key. Once that's gone, `verifyPinOrThrow`/`verifyManagerPinOrThrow` no longer need the param — it can be dropped from both signatures and their callers. **Recommendation:** fold this into Group A as a deliberate cleanup (or keep the param one release for blast-radius control — implementer's call, but state the decision).

### I4: Verify read-seam system callers before adding a required `sessionId`
`getById` has system callers (`payments/actions.ts`, `transactions/actions.ts`) per the audit; the plan's internal-variant migration covers them. Confirm `getCurrentInvoice` has **no** server-side caller that would break when `sessionId` becomes required (grep `getCurrentInvoice`), and that the only FE consumer is `useXenditPayment`. **Recommendation:** plan verify-first item.

## 4. Refinements (Optional)
- Group D2: reuse the auth lockout constants (`MAX_FAILS`, `LOCKOUT_MS`) for the activation throttle rather than minting new magic numbers, if they're exportable.
- Consider a single shared `assertPositiveIntQty` helper if Group B's guard and the spoilage/refund guards drift — but rule-of-three not yet met (3rd use), so inline is fine for now.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `QTY_INVALID` guard | `_recordSpoilage_internal` + refund path | Group B copies the exact pattern |
| resolve→scope→project | `transactions/public.ts:498 getTransactionDetail` | Group D1 template (incl. `receipt_token` strip note at :528) |
| lockout shape | `pos_auth_attempts` + `_getLockState_internal` | Group D2 mirrors for activation |
| `_resolveSessionRole_internal` | `auth/internal.ts` | Group D1 session resolution |

### Potential duplication risks
- None introduced. The new `pos_device_activation_attempts` intentionally parallels `pos_auth_attempts` (different key domain — device vs staff — so not consolidatable).

## 6. Phase / Wave Accuracy
Groups A–D are independent except A (SEC-01+07 atomic) and D1 (SEC-05+06 atomic). Suggested order: B, C (independent, fast) → A (auth, with test migration) → D1 → D2. No ordering hazard; all land in one PR.

## 7. Specialist Agent Recommendations
| Work | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Groups A/B/C/D backend | `convex-expert` | Convex mutation/query/schema + idempotency semantics |
| Group D1 FE threading | `frontend-integrator` | `useXenditPayment(sessionId)` wiring |
| Post-impl | `/triple-review` + `/simplify xhigh` | repo close-out (in handoff) |

## 8. Git Workflow Assessment
Planning artifacts land via squash-PR off synced `main` (pipeline). Implementation will be a separate post-/clear session per the handoff. Schema additions are **safe** (`must_change_pin` is `v.optional`; `pos_device_activation_attempts` is a new table) — no migration ordering hazard, Convex deploys schema+functions atomically. CHANGELOG + SCHEMA.md updates required in the impl PR.

## 10. Testing Plan Assessment
**Verdict:** Adequate for a spec (per-group red/green tests sketched), with one gap → **C1** (existing test must be migrated, not just added-to). The plan must make each group's "reproduce-then-fix" test explicit, plus the C1 rewrite and a regression test that the Telegram approve path does NOT lock the booth (SEC-07).

## 11. Edge Cases to Address
- [ ] SEC-01: a legit user's network-retry of a failed login now counts twice (fail-safe over-count) — acceptable, but note in the test so it's not "fixed" back.
- [ ] SEC-04: legit manager re-issuing a code mid-session must not be locked out by their own typos — size the per-device cap accordingly.
- [ ] D1: a manager reading another day's txn must still succeed (manager any-day) — assert both roles.
- [ ] SEC-03: `changePin` must clear `must_change_pin`; ensure the FE prompt can't be skipped but also can't brick if `changePin` fails.

## 12. Approval Conditions
**To approve, address inline in the spec:**
1. C1 — name the `auth.test.ts:261` migration as required work in Group A.
2. C2 — enumerate all 6 call-sites + the test as the signature-change sweep.

**Recommended before/within the plan:**
1. I1 — concrete global-ceiling numbers.
2. I2 — state the no-retroactive-prod-protection limitation.
3. I3 — decide the `idempotencyKey` param drop.
4. I4 — verify `getCurrentInvoice` system callers.

---

*Generated by /staffreview*

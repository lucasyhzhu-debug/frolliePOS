# Staff Review: v0.5.0 Foundation Design

**Date:** 2026-05-30
**Plan:** `docs/superpowers/specs/2026-05-30-v0.5.0-foundation-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Note: this is a brainstorm SPEC, not a PLAN.md. Plan-phase artifacts (commit messages, per-task subtask breakdowns, per-task dependency graphs at sub-commit granularity) are intentionally deferred. Structurally complete for a spec.

---

## 0. Plan Structure Additions

The spec covers Goal, File Changes (per-component throughout §3–§7), Implementation Waves (§9), Testing (per-workstream subsections + §11), Success Criteria (§11). Rollback is implicit (atomic commits + `/gsd-undo`-friendly, prod cutover deferred to v1.0) — not called out as its own section but addressed in §10 Risks. **No structural additions needed.**

---

## 1. Summary

**Overall Assessment:** **Revise** (3 Critical issues are addressable in-spec without restructuring; once fixed, the spec is approve-ready)

The decomposition is solid. The 5-workstream split matches the staffreview-v0.5-split recommendation, the dependency graph is sound, and the security hardening (per-token PIN cap + ESLint rule + authCheck migration) is well-motivated. Three gaps need closing before plan-phase: (1) cart-abandon dialog only handles header-back, not browser/Android gesture-back; (2) `/sale/charge` abandon path has undefined semantics for the live invoice; (3) the new `REQUEST_REVOKED` error code lacks a concrete `mapError` branch in the existing approve UI.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | AbandonCartDialog doesn't catch browser-back / Android gesture-back | Logic | spec §3 |
| 2 | `/sale/charge` abandon-path semantics undefined for live invoice | Logic / state-machine | spec §3 |
| 3 | `REQUEST_REVOKED` lacks concrete frontend `mapError` wiring | Implementation gap | spec §5 |

### Issue 1: AbandonCartDialog catches header-back but not browser/Android gesture-back

The spec wires the dialog via the header's `onBack` (intercepts `useNavigate`) and mentions `beforeunload` for pre-payment. But:

- `beforeunload` fires on **page leave** (close tab, refresh, navigate to external URL) — NOT on intra-SPA route changes.
- Android's hardware/gesture back button and the browser's back button fire `popstate`, which `useNavigate` does NOT intercept.
- React Router v7 (the project's router per CLAUDE.md) provides `useBlocker` (formerly `unstable_useBlocker`) for exactly this case. Confirmed by grep: no `useBlocker` / `popstate` usage anywhere in `src/`.

Without `useBlocker`, an Android staffer hitting back-gesture mid-cart bypasses the dialog entirely — same defect this slice exists to fix.

**Recommendation:** Add to `AbandonCartDialog` design (spec §3):
- `/sale` and `/sale/charge` register a `useBlocker` that intercepts ANY navigation (header back, browser back, Android gesture, `useNavigate` from any source) while the cart has lines OR the txn is in `awaiting_payment`.
- When the blocker fires, open the dialog; the dialog's resolution either calls `blocker.proceed()` (after save/discard) or `blocker.reset()` (cancel).
- `beforeunload` is the SECONDARY guard for hard page-leave (tab close), kept for that case only.
- Add a test in `sale/index.test.tsx` that simulates a popstate while the cart is non-empty and asserts the dialog opens.

### Issue 2: `/sale/charge` abandon-path semantics undefined

Spec §3 says the dialog fires on `/sale/charge` with copy *"Cancel this payment?"* but doesn't define what each button does once we're past cart-commit:

- The txn already has `status: "awaiting_payment"`.
- A `pos_xendit_invoices` row exists with a live QR code or VA number.
- A pending `manual_payment_override` approval may exist (the `v050-be-cancel-cancels-approval` side-effect targets this case).

What does "Save as draft" mean here? The txn isn't a draft anymore. What does "Discard" mean? Just clearing `useCart` is wrong — it leaves a zombie awaiting_payment txn and an unsuperseded invoice.

**Recommendation:** Replace the three-button dialog on `/sale/charge` with a **two-button "Cancel this payment?"** dialog (`Cancel payment` / `Keep waiting`). On `Cancel payment`:
1. Call a new mutation `transactions.public.cancelAwaitingPayment({ sessionId, txnId, idempotencyKey })` (born under strict ESLint rule). Mutation transitions txn to `cancelled`, marks the active invoice as superseded locally (no Xendit cancel call — per ADR-036), and fires the `v050-be-cancel-cancels-approval` side-effect.
2. Clear `useCart`.
3. Navigate to `/`.

The "Save as draft" affordance is **only on `/sale`** (cart-edit step), where commitCart-as-draft is the right action. Update §3 routing table accordingly and add the new mutation to the task list.

Alternative if scope-cutting needed: ship the `/sale/charge` dialog as a one-button explicit "Cancel payment" (no draft option), and explicitly state the design choice in spec.

### Issue 3: `REQUEST_REVOKED` lacks concrete frontend wiring

Spec §5 introduces `REQUEST_REVOKED` as a new error code and says the `/approve` UI shows the revoke message. The existing `mapError` at `src/routes/approve/index.tsx:31` has branches for `REQUEST_RESOLVED` (line 38) and `INVALID_PIN` (line 40) — nothing for `REQUEST_REVOKED`. Without explicit wiring, the throw surfaces a generic error and the UX win is lost on the cap-trip request itself.

**Recommendation:** Add to `v050-be-token-pin-cap` task scope (or split out a `v050-fe-revoke-copy` sub-task):
- Add a `REQUEST_REVOKED` branch to `mapError` returning the revoke copy from spec §5 ("This approval was revoked after too many wrong PIN attempts. Ask the staffer to retry.").
- The UI also needs to differentiate the **subsequent-visit** revoke display (driven by `effectiveStatus === "denied"` + `deny_reason === "too_many_pin_attempts"`) from the **same-visit** revoke display (driven by the thrown `REQUEST_REVOKED`). Both should render identical copy. Spec should call out both code paths.
- Add a test: `routes/approve/index.test.tsx` extension asserting both paths render the revoke copy.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Phased severity (warn → error) needs a CI gate, not just a final commit | H | L |
| 2 | Add concurrent-approve-vs-failure test to `tokenPinCap.test.ts` | M | L |
| 3 | CLAUDE.md business rule #21 should describe the dual-call pattern, not just enforce it | H | L |
| 4 | Document per-token cap stickiness across legitimate fumbles | M | L |
| 5 | `v050-be-mgr-picker-override` needs explicit booth-side UI test in scope | M | L |

### Improvement 1: Phased severity flip needs a CI gate

Spec §10 risks: Wave-1 ships ESLint as `warn`, Wave-2's final commit flips to `error`. Fragile — if any commit between Wave 1 and the flip commit adds a new public mutation that doesn't comply, the `warn`-mode rule won't block CI. The bug ships and the gap is invisible until next time someone reads the lint output.

**Recommendation:** Add a sub-task to `v050-be-authcheck-migrate`: a one-line CI assertion (in the lint job) that grep-checks `eslint.config.js` for `"error"` severity on `idempotency-required` before the PR can merge. Two-line script; bullet-proof.

### Improvement 2: Concurrent-approve-vs-failure test

Spec §5 tests cover "concurrent failures from two managers racing." Missing: the race between Manager A approving successfully (via `_markResolved_internal`) and Manager B hitting the 5th wrong PIN (via `_recordTokenPinFailure_internal` which patches `status: "denied"`). Convex serializes mutations, so one wins. Need to assert:
- If A wins: B's increment hits `status !== "pending"` guard → no-op; B's caller throws REQUEST_RESOLVED.
- If B wins: A's `_markResolved_internal` hits `REQUEST_RESOLVED` throw (already in place per `internal.ts:171`).

Lock both error codes; ensure UI mapError handles each correctly.

### Improvement 3: Document the dual-call pattern in business rule #21

Spec §6 documents the dual-call convention (authCheck + inline requireSession in handler) inside `withIdempotency`'s JSDoc and in spec §6 body, but business rule #21 in CLAUDE.md (per spec §8) is just "public mutations need idempotencyKey + withIdempotency + authCheck". Future developers will see the duplication, think it's an oversight, and "fix" it.

**Recommendation:** Extend rule #21 to two sentences: the assertion + the load-bearing convention (the `authCheck` slot runs before cache lookup; the handler re-calls `require*Session` for the typed session object; the duplication is intentional and cheap).

### Improvement 4: Per-token cap stickiness — legitimate fumbles count

Spec §5 doesn't note that the 5-attempt cap is sticky across all attempts — if an attacker burns 4 wrong attempts and walks away, a legitimate manager later trying once and fumbling once auto-revokes the request. This is correct behaviour but operators need to know.

**Recommendation:** Add a sentence to spec §5 + UAT (§11) + CHANGELOG: "5 failed PINs auto-revokes the approval regardless of source — legitimate fumbles also count toward the cap. Operators retrying a revoked approval mint a fresh token via the normal flow."

### Improvement 5: Booth manager-picker UI test in `v050-be-mgr-picker-override`

Spec §7.2 covers the backend change (`managerStaffCode` arg + booth-picker UI) but lists no UI test. Frontend coverage needed:
- Picker shows all active managers
- Focus moves to PIN input after manager selection
- Picker is cancellable
- PIN entry on selected manager calls `manuallyConfirmPayment` with that manager's code, not the logged-in session's code

Add to task scope; otherwise the UI ships untested.

---

## 4. Refinements (Optional)

- **Centralise localStorage keys.** `STORAGE_KEY` (in `useSession.ts`) and `LAST_STAFF_KEY` (new) could share a `src/lib/storage-keys.ts` module. Trivial — at implementer's discretion.
- **`forgetLastStaff` helper is defined but never called.** Either wire it (e.g., for a future `mgr/staff` deactivate flow) or document it as forward-looking API in the hook's JSDoc.
- **Co-locate last-staff write in `storeSession`.** Instead of two separate calls in `login.tsx` (`storeSession(sessionId)` + `rememberLastStaff(staffId)`), extend the signature: `storeSession(sessionId, staffId)`. Simpler API; harder to forget the second call when next adding a login path.
- **chatRegistry split test migration.** `v050-xc-chatregistry-split` should explicitly list moving the existing keystone test file (`chatRegistry.test.ts`) to match the new layout — easy to forget in a mechanical refactor.
- **Wave 4 task `v050-be-deny-autoflip` is FE-led** but lives in the BE namespace. Either rename to `v050-fe-deny-autoflip` for consistency with other FE tasks, or document in spec why it kept the BE prefix (the contract change touches the overlay's callback shape, which is consumed by `/sale/charge` BE-adjacent code).

---

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| `useSession` localStorage pattern + `notify()` same-tab sync | `src/hooks/useSession.ts:8-14, 25-66` | `useLastStaff` mirrors verbatim — spec already does this |
| `storeSession` / `clearSession` side-write helpers | `src/hooks/useSession.ts:68-76` | `rememberLastStaff` / `forgetLastStaff` mirror — refinement: consolidate into `storeSession(sessionId, staffId)` |
| Existing `logout` mutation | `convex/auth/public.ts:39` | Lock route consumes it as-is; no new lock mutation needed |
| Existing `commitCart` mutation supports draft status | `convex/transactions/public.ts:90` + v0.3 PROGRESS notes | AbandonCartDialog's "Save as draft" calls existing mutation; verify args validator accepts `{ status: "draft" }` in plan-phase |
| `withIdempotency` already has `authCheck` slot | `convex/idempotency/internal.ts:52-86` | Wire is mechanical — slot exists, just unused by most callers today |
| Existing `mapError` at `/approve` | `src/routes/approve/index.tsx:31-40` | Extend with `REQUEST_REVOKED` branch (see Critical #3); don't write a parallel error mapper |
| `_listPendingForStaff_internal` / `_listPendingByKind_internal` inline expiry filter | `convex/approvals/internal.ts:208-216, 308-318` | Spec correctly leaves inline — these are dedup guards, not display readers; add one-line reference comment to `effectiveStatus` |
| `KIND_AUDIT` registry | `convex/approvals/kinds.ts` | `v050-be-kind-audit-verbs` extends in place — don't roll a parallel map |

### Potential duplication risks

- **AbandonCartDialog's "Save as draft" calls commitCart** — verify `commitCart`'s args validator already accepts `{ status: "draft" }` at plan-phase before the dialog wiring lands (per v0.3 PROGRESS commitCart was the single funnel for cart commit including drafts, so this is almost certainly fine).
- **The dual-call authCheck pattern adds a literal duplicate line per mutation.** Risk: a "code-cleanup" pass strips the duplicate inline call, breaking the handler. Mitigated by Improvement #3 (explain in rule #21 + JSDoc).
- **`v050-be-cancel-pending-approval` and `v050-be-cancel-cancels-approval` both write deny rows via the system-deny pattern.** Spec §5 inlined the system-deny into `_recordTokenPinFailure_internal` rather than extracting a `_markDeniedBySystem_internal`. Both new tasks should use the same inline pattern OR all three should extract the helper. **Recommend extracting** `_markDeniedBySystem_internal` after all — three callers now, not one. Update spec §5 to extract.

---

## 6. Phase / Wave Accuracy

| Wave | Assessment | Notes |
|------|------------|-------|
| Wave 1 — scaffolding | Good | All four tasks independent; can land in any order |
| Wave 2 — rule loop closure | Good | `v050-be-authcheck-migrate` depends on Wave 1 ESLint rule existing; reader migration depends on Wave 1 helper |
| Wave 3 — backend bug-class fixes | Good | All depend on Wave 1+2 foundations; mostly independent of each other (token-pin-cap and cancel-pending-approval are the exceptions) |
| Wave 4 — frontend | Good | Spoke-migration is the tall pole (touches ~10 routes); could parallelize per-route within the task |
| Wave 5 — docs | Good | Single docs task at the end is acceptable for a single-PR slice |

**Ordering issues:** `v050-be-cancel-cancels-approval` (Wave 3) depends on the system-deny pattern established in `v050-be-token-pin-cap` (also Wave 3). Within-wave ordering needs to be explicit: token-pin-cap first, then cancel-cancels-approval consumes the helper. Surface in plan-phase task subtask lists.

**Missing phases:** None.

---

## 7. Specialist Agent Recommendations

| Wave | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Wave 1 | `convex-expert` (schema, helper, ESLint rule) + `general-purpose` (chatRegistry split — refactor work) | Schema-touching and pure-helper work is `convex-expert`'s lane; the chatRegistry split is mechanical and fits `general-purpose` |
| Wave 2 | `convex-expert` (authCheck migration is across ~10 mutations) + `convex-expert` (auth-cache-order-test + reader-migration) | Single agent owns the ratchet end-to-end to keep the dual-call pattern consistent |
| Wave 3 | `convex-expert` for backend tasks | All Wave 3 tasks are mutation/action work |
| Wave 4 | `frontend-integrator` (hooks + spoke-migration wiring) + `ui-component-builder` (AppHeader, AbandonCartDialog, lock-route layout) | Split FE work: hook + wiring vs. component design |
| Wave 5 | `general-purpose` for docs | Cross-cutting doc updates |
| Final review | `code-reviewer` before PR | Standard pre-merge gate |

`feature-dev:code-architect` is NOT needed — the spec already provides the architecture; per-task scope is small enough.

---

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ `feat/v0.5.0-foundation` |
| Branch naming follows convention | ✅ matches v0.2 → v0.4 history |
| Merge strategy documented | ✅ squash-merge per spec §9 |

### Commit checkpoints

Per spec, atomic commits in wave order, one per Task ID. Within-wave ordering is alphabetic by task ID (deterministic). For the long-running `v050-be-authcheck-migrate` task, recommend explicit per-mutation commits (one per mutation refactored) so the umbrella task delivers ~10 atomic commits, not one mega-commit — matches v0.4's per-task-ID cadence.

### Pre-push verification

- [x] `npm run typecheck` — in spec §9
- [x] `npm run build` — in spec §9
- [x] `npx vitest` — in spec §9
- [x] `npm run lint` — in spec §9 (new rule is the load-bearing case)

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ atomic commits + `/gsd-undo`-friendly per spec §10 |
| Deployment order | ✅ correct — Wave 1 schema-touching ships first, readers/migrations follow |
| Data backup needed | ❌ No — only schema change is additive (`failed_pin_attempts` field + `denied_by_manager_id` validator widen) |
| Migration safety | ✅ all additive |
| Prod cutover | ✅ deferred to v1.0 per project policy; all v0.5 work targets `helpful-grasshopper-46` (dev) |

---

## 9. Documentation Checkpoints

Spec §8 enumerates all doc updates. One addition recommended:

| Phase | Docs to update |
|-------|----------------|
| Wave 5 (final commit) | `docs/SCHEMA.md`, `docs/CLAUDE.md` (file locations + business rule #21 with the dual-call explanation per Improvement #3), `docs/CHANGELOG.md`, `docs/API_REFERENCE.md` |
| Wave 5 (also) | `docs/PATTERNS/` consider adding a short pattern doc for the dual-call authCheck convention — would help future module work |

### CHANGELOG draft

```markdown
## v0.5.0 — App shell + session ergonomics + v0.4 stabilizers

### App shell
- Sticky header chrome on every spoke route with back-to-home affordance
- Cart-abandon confirm dialog on `/sale` (Save as draft / Discard / Cancel)
- Cancel-payment confirm dialog on `/sale/charge` (cancels live invoice via new `cancelAwaitingPayment` mutation)
- Lock route + lock-resume UX: PIN entry pre-stages to the previous staffer; silent fallback to staff list if deactivated

### Security hardening
- Per-token PIN attempt cap (5 attempts) on `/approve/:token` actions
- ESLint rule enforces `idempotencyKey` + `withIdempotency` + `authCheck` on every public mutation
- All existing public mutations refactored to canonical authCheck pattern; auth now runs BEFORE the idempotency cache lookup

### Stabilizers
- `ApprovalPending` overlay auto-flips on denied status
- Cancel-sale cancels any pending Telegram approval for the txn
- Booth manager-PIN override accepts any active manager's code (not just the logged-in session)
- Awaiting-payment countdown on `/sale/charge` driven by invoice expiry
- New `cancelPendingRequest` manager mutation for cleaning up stuck approvals
- `getRecentPinResetForStaff` no longer re-fires success toast on fresh sessions
- Founders summary cron eliminates role-rebind race window
- `KIND_AUDIT` distinct per-kind verbs (existing rows unchanged per ADR-007)
- `telegramChats` archived-filter rewritten to JS post-filter (closes prod gotcha)

### Internals
- `effectiveStatus(row)` helper canonicalises the four-state lifecycle derivation
- `chatRegistry.ts` split into `chatRegistry/public.ts` + `internal.ts` per ADR-034
- Audit verb cutover: pre-v0.5.0 audit rows use the old generic verbs; v0.5.0+ rows use per-kind verbs
```

---

## 10. Testing Plan Assessment

**Verdict:** **Adequate, with gaps to close** (Critical #1 + Improvements #2 and #5)

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Pure unit | `effectiveStatus` × all status/time combos | vitest | ✅ planned (§7.1) |
| Backend mutation | tokenPinCap (4-pass-1-cap, audit, REQUEST_REVOKED) | convex-test | ✅ planned (§5) |
| Backend mutation | auth-cache-order regression | convex-test | ✅ planned (§6) |
| Backend mutation | each v0.4 stabilizer fix | convex-test | ✅ planned per task (§7.2) |
| Frontend hook | `useLastStaff` round-trip | vitest + fake-indexeddb | ✅ planned (§4) |
| Frontend route | `login.test.tsx` three pre-stage cases | vitest + jsdom | ✅ planned (§4) |
| Frontend route | `lock.test.tsx` logout + nav | vitest + jsdom | ✅ planned (§4) |
| Frontend component | `AppHeader`, `SpokeLayout`, `AbandonCartDialog` | vitest + jsdom | ✅ planned (§3) |
| ESLint rule | fixture-based positive/negative | vitest | ✅ planned (§6) |
| Manual smoke | PWA install + header sticky on Android Chrome | manual | ✅ planned (§3) |

### Missing test coverage (must add)

| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | popstate / browser-back on AbandonCartDialog | Critical #1 — without this, Android back-gesture bypasses the dialog | `sale/index.test.tsx`: simulate `popstate` event on a non-empty cart; assert dialog opens |
| 2 | `/sale/charge` abandon path correctly cancels invoice + clears cart + fires approval cancel | Critical #2 — current spec leaves this undefined | `sale/charge.test.tsx`: test the new `cancelAwaitingPayment` mutation end-to-end |
| 3 | `REQUEST_REVOKED` surfaces correct UI copy at `/approve` | Critical #3 — without the `mapError` branch + test, the cap-trip request shows a generic error | `routes/approve/index.test.tsx` extension; test both same-visit (thrown error) and next-visit (effectiveStatus + deny_reason) paths |
| 4 | Concurrent approve-vs-failure race | Improvement #2 — ensures correct error each caller sees | `tokenPinCap.test.ts`: schedule both mutations against the same request, assert one wins cleanly |
| 5 | Booth manager-picker UI behaviours | Improvement #5 — picker shows all managers, PIN input gets focus, etc. | `sale/charge.test.tsx` extension covering the picker subview |
| 6 | Founders cron upfront-chatId-resolve actually skips the second lookup | Founders race fix needs proof | `foundersSummary.test.ts` extension; mock `getChatIdByRole` and assert call count = 1 |
| 7 | AbandonCartDialog skipped on empty cart | Stated in spec §3 but not in test list | `sale/index.test.tsx`: empty-cart back press navigates without dialog |

### Test execution checkpoints

1. After each Wave 1 task: typecheck + relevant unit tests
2. After Wave 2: full vitest + lint (validates the ratchet)
3. After Wave 3 + 4: full vitest + manual PWA smoke
4. Before merge: typecheck + build + vitest + lint, all green

### Regression risk

- **Reader migration to `effectiveStatus` changes `getRequestStatus` observable behaviour for expired-pending rows.** Spec acknowledges and addresses (one-line test update). Verify the existing `ApprovalPending.test.tsx` and any related integration tests get updated in the same commit.
- **authCheck migration touches every public mutation** — full vitest must stay green per migration. Run after each commit, not just at end of wave.
- **chatRegistry split moves files** — all imports of `convex/telegram/chatRegistry` must update; test that the auto-generated `api.*` paths still resolve (Convex codegen catches this).
- **AbandonCartDialog touches the most common user flow.** Manual PWA smoke MUST exercise: empty cart back, full cart back (save), full cart back (discard), full cart back (cancel), Android gesture-back, browser refresh.

---

## 11. Edge Cases to Address

Spec covers most; explicit checklist for plan-phase:

- [x] **Lock-then-power-cycle** → resume still pre-selects last staff (spec §4)
- [x] **Deactivated last-staff** → silent fallback to list (spec §4)
- [x] **Locked-out last-staff** → standard lockout flow on PIN entry (spec §4)
- [x] **Token expiry mid-PIN-entry** → handled by `effectiveStatus` reads (spec §5/§7.1)
- [x] **Concurrent failures on same token** → counter monotonic (spec §5)
- [ ] **Android gesture-back on `/sale`** (Critical #1)
- [ ] **`/sale/charge` abandon semantics** (Critical #2)
- [ ] **`REQUEST_REVOKED` same-visit vs next-visit display** (Critical #3)
- [ ] **Concurrent approve-vs-cap-trip race** (Improvement #2)
- [ ] **Legitimate fumble pushes attacker-primed token over the cap** (Improvement #4 — document, not block)
- [ ] **Multi-tab login** writes to `frollie-last-staff` — last-write-wins acceptable; document in `useLastStaff` JSDoc
- [ ] **Nav shell on `/r/:n` public receipt route (v0.5.1)** — must NOT render staff nav (cited by parent staffreview as v0.5.0 edge case worth flagging now so v0.5.1 plan inherits)

---

## 12. Approval Conditions

**To approve, address:**
1. Critical #1 — wire `useBlocker` for popstate / Android back-gesture; update spec §3 + test plan
2. Critical #2 — define `/sale/charge` abandon semantics; add `cancelAwaitingPayment` mutation to task list; update spec §3
3. Critical #3 — add explicit `mapError` REQUEST_REVOKED branch to `v050-be-token-pin-cap` task scope + test

**Recommended before plan-phase:**
1. Improvement #1 — CI gate on ESLint severity = error
2. Improvement #2 — concurrent approve-vs-failure test
3. Improvement #3 — extend CLAUDE.md rule #21 with dual-call explanation
4. Improvement #4 — document per-token cap stickiness in CHANGELOG + UAT
5. Improvement #5 — booth manager-picker UI test in `v050-be-mgr-picker-override` scope
6. Extract `_markDeniedBySystem_internal` helper (three callers now: token cap, cancel-pending-approval, cancel-cancels-approval) per §5 Duplication Risks

**Refinements:** at implementer discretion during plan-phase.

---

*Generated by /staffreview*

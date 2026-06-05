# Staff Review: v0.5.8 — Orphaned-function wiring (SPEC)

**Date:** 2026-06-05
**Plan:** `docs/superpowers/specs/2026-06-05-v0.5.8-orphan-wiring-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Design spec, not a full impl plan — File-Changes paths, wave ordering, and commit checkpoints intentionally deferred to `writing-plans` (next gate). Not penalized.

---

## 1. Summary

**Overall Assessment:** Revise (one Critical in Part C)

Parts A and B are sound and accurately grounded — the cited facts check out against real code. **Part C has a Critical semantic mismatch:** `approvals.public.cancelPendingRequest` is `requireManagerSession`-gated and throws `MANAGER_ONLY` for non-managers, but the two hosts that render `ApprovalPending` (`sale/charge.tsx`, `refund/detail.tsx`) show it almost exclusively to **non-manager** sessions (a manager present would use the inline-PIN path instead). The cancel button as specced would throw for its primary users. The spec already flagged this as an open question; this review **resolves it to a firm constraint** and a scoping decision the user must make.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `cancelPendingRequest` is manager-only; hosts render `ApprovalPending` for non-managers | Logic / Auth | Part C |

### Issue 1: Part C cancel button throws `MANAGER_ONLY` for its intended users

**Verified:** `requireManagerSession` (`convex/auth/sessions.ts:24-31`) → `if (role !== "manager") throw new Error("MANAGER_ONLY")`. `cancelPendingRequest` (`convex/approvals/public.ts:509`) calls it in **both** the handler (`:527`) and `authCheck` (`:539`). Its docstring (`:497`): *"Cancel a pending approval request from the on-booth manager panel."* — it was built for a **manager** to clear a request, not for the staff requester to abort their own wait.

**Why it bites:** The off-booth Telegram approval flow is taken precisely when **no manager is at the booth** — otherwise the host offers an inline manager-PIN path (`charge.tsx` "Manager override" `:638`; `refund/detail.tsx` "Refund with manager PIN" `:367`). So the session rendering `<ApprovalPending>` is, in the common case, a **non-manager staff**. A cancel button calling `cancelPendingRequest` from that session throws `MANAGER_ONLY`.

**Resolution (decision required — see §12):**
- **C1 (in-scope, recommended):** Gate the affordance to manager sessions — render "Batalkan permintaan" only when `session.staff.role === "manager"`. Correct, safe, zero backend. Covers the real case where a *manager* is logged in on the booth device and wants to clear a stuck/duplicate request. Non-manager requesters continue to rely on the existing exits: 60-min token TTL expiry, manager denial, or **sale abandonment** (charge already cascade-denies the pending manual-payment request via `_cancelPendingManualPaymentForTxn_internal` — `transactions/public.ts:420-421`).
- **C2 (deferred, out of v0.5.8 scope):** Build a staff-requester self-cancel — a new mutation letting the session that *created* a pending request invalidate it (`requireSession`, assert `requested_by === session.staffId`). This is the affordance the handoff imagined, but it is **net-new backend + an approval-semantics decision**, not "wiring." Defer to its own phase.

**Recommendation:** Adopt **C1** unless the user wants the C2 feature. Update Part C in the spec to state the manager-gate as a decided constraint (remove the "open question" framing), and document the non-manager exit paths.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Reconsider whether Part C is worth wiring at **charge** vs refund-only | M | L |
| 2 | Part A: surface `mgr_approver_id` (approver name) on rows that have it | L | L |

### Improvement 1: Part C at charge may be near-redundant
At `sale/charge.tsx`, abandoning the sale already cascade-denies the pending manual-payment approval (`_cancelPendingManualPaymentForTxn_internal`). A manager-only cancel button there adds marginal value over the existing "Cancel sale" CTA + abandon-dialog. Part C's clearest value is on **refund/detail.tsx**, where a stuck pending request otherwise blocks re-requests (`REFUND_REQUEST_PENDING_DIFFERENT`, `refund/detail.tsx:160`) until expiry. Consider wiring Part C on refund first; charge is optional. (Not blocking — wiring both with C1's manager gate is harmless.)

### Improvement 2: Audit viewer approver column
`audit_log` rows for approval-sourced actions carry `mgr_approver_id`. The spec defers it. Cheap to also label it via the same name map for a richer trail. Optional.

## 4. Refinements (Optional)

- Part A action filter: a `Select` over the distinct verbs present in the loaded page is friendlier than free text (verbs are opaque like `transaction.resumed`). Either is fine.
- Part A glyph: pick any unused glyph; `mgr/home.tsx` glyphs in use are `◉ ▣ ◔ % ⨯ ≡ ✈ ↻ Δ`.
- Part B banner copy: match the recount-nudge visual exactly (amber `Link`, `rounded-md bg-amber-50 p-3`).

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `_listStaffNames_internal` | `convex/auth/internal.ts:469` | Part A actor labels — **already used identically** by `transactions/internal.ts:593`. Returns `{_id, name}` over ALL staff (incl. inactive → historical actors keep names). |
| `useRecountNudge` | `src/hooks/useRecountNudge.ts` | Part B hook shape (loading-returns-falsy guard, reactive query). |
| `mgr/refunds-pending.tsx` | `src/routes/mgr/` | Part A spoke shape (outer role-guard → inner `sessionId` component, `SpokeLayout`, `Card` rows, `FunctionReturnType` row typing). |
| Recount nudge `Link` block | `home.tsx:86-93` | Part B banner — clone the amber `Link`. |
| `ApprovalPending` `onDenied`/`onExpired` Retry buttons | `ApprovalPending.tsx:75-94` | Part C — add `onCancel` symmetrically. |

### Potential duplication risks
- None. Part A correctly extends the existing query rather than adding a parallel one (`_list_internal` stays label-free).

## 6. Phase / Wave Accuracy

Spec doesn't define waves (deferred to plan). Recommended order for the plan:
1. **Part A backend** (extend `audit.public.list` + test) — SEQUENTIAL first (FE depends on return shape).
2. Part A FE, Part B (hook+banner), Part C (component+hosts) — PARALLEL after A-backend lands (independent files).
3. Docs (CLAUDE.md routes/file-locations, CHANGELOG) — last.

## 7. Specialist Agent Recommendations

| Work | Agent | Rationale |
|------|-------|-----------|
| Part A backend query + test | `convex-expert` | query/internal-read + convex-test |
| Part A/B/C frontend | `frontend-integrator` | hook + route wiring + Convex bindings |
| Audit viewer / banner UI polish | `ui-component-builder` | Card list, amber banner, shadcn |

(All exist in this project's roster. Execution may also just use TDD subagents per `subagent-driven-development`.)

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch | ✅ worktree branch `worktree-v0.5.8-orphan-wiring` off `origin/main` |
| Atomic commits | ⚠️ specify in plan (one per part + docs) |
| Pre-push typecheck/build | ✅ in spec "Done when" |
| Squash-PR convention | ✅ pipeline handles |
| Rollback | ✅ FE wiring + one additive query field — trivially revertible; no schema/migration |

## 9. Documentation Checkpoints

| Item | Update |
|------|--------|
| CLAUDE.md | routes table (+`/mgr/audit`), `src/routes` + `src/hooks` file-locations |
| docs/CHANGELOG.md | v0.5.8 entry |
| docs/PROGRESS.md | v0.5.8 phase + tasks via `/progress-update`, regen `progress.html` |
| docs/API_REFERENCE.md | note `audit.public.list` now returns `actor_name` |

### CHANGELOG draft
~~~markdown
## v0.5.8 — Orphaned-function wiring
- Manager audit-log viewer at /mgr/audit (append-only trail; actor names server-derived).
- Home recovery banner for in-flight awaiting-payment txns (resume the charge screen).
- Cancel a pending approval from ApprovalPending (manager-session gated).
~~~

## 10. Testing Plan Assessment

**Verdict:** Adequate (for a spec — plan must enumerate concrete cases).

| Layer | What | Type | Status |
|-------|------|------|--------|
| Backend | `audit.public.list` attaches `actor_name` (staff actor + `"system"`→`"System"`) | convex-test | planned |
| FE | audit page: manager renders rows; non-manager `<Navigate>`; filter passes `action`; Load-more bumps `limit` | vitest + MemoryRouter | planned |
| FE | `useAwaitingPaymentRecovery`: count/latest from mock; loading→falsy | vitest | planned |
| FE | banner shows when non-empty + navigates to latest; hidden when empty | vitest | planned |
| FE | `ApprovalPending`: cancel button only in `pending` + only when `onCancel` set; calls mutation once w/ UUID key; **not shown for non-manager** (per C1) | vitest | planned |

### Missing coverage to add
| # | Test | Why |
|---|------|-----|
| 1 | Part C: cancel button hidden when `session.staff.role !== "manager"` | Core of the Critical fix — prevents shipping a throwing button. |
| 2 | Part A: unknown `actor_id` (deactivated staff absent from map edge) falls back gracefully | `_listStaffNames_internal` includes inactive, but guard the `.get` miss anyway. |

## 11. Edge Cases to Address

- [ ] Part B: `latest` selection must be max-`created_at` (index returns ascending) — don't assume `list[0]`.
- [ ] Part B: charge resumes a BCA_VA awaiting invoice on the default QRIS tab → existing tab-swap re-mints QRIS (ADR-014, acceptable; note, don't fix).
- [ ] Part C: idempotency key is one-shot `crypto.randomUUID()` (NOT `useIdempotency` — this is a user-action, not a replayed login/payment).
- [ ] Part C: on cancel success, reset host `approvalRequestId` to `null`; refund host also `clearIntent("refund-telegram:"+txnId)` so a retry mints fresh.
- [ ] Part A: empty-state ("No audit entries") + `limit` cap at 500 (server clamps; FE shouldn't offer beyond).

## 12. Approval Conditions

**To approve, address:**
1. **Critical #1 — resolve Part C scope:** adopt **C1** (manager-gated cancel button, in-scope) or commit to **C2** (staff self-cancel, new backend, separate phase). Update the spec's Part C from "open question" to the decided constraint + non-manager exit paths.

**Recommended before implementation:**
1. Decide Part C host coverage (refund-only vs refund+charge) — Improvement #1.

---

*Generated by /staffreview*

# Staff review — `worktree-v0.5.8-orphan-wiring`

**Date:** 2026-06-05
**Reviewer:** senior-engineer / architectural (ADR-034 lens)
**Base:** `main` · Range reviewed: `git diff main..HEAD` (9 commits)
**Scope:** Wire three tested-but-orphaned public Convex functions to the UI — `/mgr/audit` viewer (+ `actor_name` server enrichment), `useAwaitingPaymentRecovery` home banner, optional manager-gated `onCancel` on `ApprovalPending` wired into refund detail.

---

## Summary

**Verdict on module depth: UNCHANGED — and that is the correct outcome.** The one backend change (`audit.public.list` attaching `actor_name`) keeps the audit module exactly as deep as it was: the public query absorbed *more* work (the staff-name join) behind the *same* narrow argument surface, while the raw `_list_internal` / `auditListHandler` variant stayed label-free for server/test callers. No public interface widened beyond what the feature genuinely required, the cross-module read is a sanctioned `_internal` call that mirrors the v0.5.3a transactions precedent line-for-line, and nothing in the change touches the `convex/api/v1/` external surface or locks a shape that hurts the v1.1 Frollie Pro graft. This is a textbook "deep module gets deeper internally, surface stays flat" change.

Plan fidelity is high: all 7 tasks are built, tests follow the planned dispatch-by-`getFunctionName` harness, and the two implementation deviations (explicit return annotation, `cancellingRef` guard) are both correct and well-justified. The only material findings are a **stale branch base** that would silently revert PR #45's planning docs on merge (process, not code), and a Doc-leak observation on the audit row spread that is acceptable-but-worth-noting.

No Critical code issues. One Important (stale base / accidental doc deletion). The rest are Improvements and Refinements.

---

## Critical Issues

None.

The change is additive-only on the backend (one new field on one manager-gated query), FE-only elsewhere, no schema/migration/index, and trivially revertible per commit. The deployment note (backend additive → old-FE-against-new-backend safe; new-FE needs the field) is accurate.

---

## Improvements

### I1 — Branch is behind `main`; merging as-is reverts PR #45's planning docs (Important)

`git diff main..HEAD` shows four **deletions** under `docs/superpowers/` and `docs/reviews/`:

```
docs/reviews/staffreview-usesession-transient-null-fix-plan-2026-06-05.md
docs/reviews/staffreview-usesession-transient-null-fix-spec-2026-06-05.md
docs/superpowers/plans/2026-06-05-issue-44-usesession-transient-null-fix.md
docs/superpowers/specs/2026-06-05-useSession-transient-null-fix-design.md
```

plus a 67-line removal from `docs/PROGRESS.md` and a 205-line removal from `docs/progress.html` — all of which are the **v0.5.7.1 useSession transient-null-fix** artifacts, completely unrelated to orphan-wiring.

Root cause: this worktree branched before `main` advanced to `ccb2d65` (PR #45, "plan: issue #44 useSession transient-null fix"). Verified: `git merge-base --is-ancestor ccb2d65 HEAD` → **not an ancestor**. So these are not intentional deletions by this work — they are a stale-base artifact. If this branch is squash-merged via a flow that takes the branch tree wholesale (or fast-forwarded), it will **silently revert PR #45**, deleting another phase's spec/plan/PROGRESS entries.

**Fix:** rebase or merge `main` into this branch before landing, then re-confirm `git diff main..HEAD` shows only the v0.5.8 files. (This is exactly the `merge-base --is-ancestor` failure-attribution pattern from the v0.5.7 lessons memo — worth applying here.) A normal GitHub squash-merge against an up-to-date base will surface the conflict; the danger is only if the base is not refreshed first.

### I2 — Public audit list spreads the full raw Doc, including `before_state` / `after_state` / `metadata` (Improvement)

`audit.public.list` returns `{ ...r, actor_name }` over the raw `Doc<"audit_log">`. That means the public manager query now ships `before_state`, `after_state`, `metadata`, `device_id`, and `mgr_approver_id` (a raw `Id<"staff">`) to the client, even though the viewer (`audit.tsx`) only renders `action`, `created_at`, `actor_name`, `entity_type`, `entity_id`, `source`, and `reason`.

This is **manager-gated**, so it is not a privilege-escalation leak, and ADR-034's "data is private internally, stable shape only externally" rule applies to the `/api/v1/` surface — not to internal `public.ts` consumed by the POS FE — so this does **not** violate ADR-034. But it is the same Doc-leak hazard your v0.5.1b lessons flag: a full-Doc spread on a public query means any future-added sensitive column (or a verbose `before_state` blob) is auto-exposed and travels over the wire on every page load. The transactions v0.5.3a precedent you matched deliberately projects to a `DayTxn` shape rather than spreading the raw Doc — the audit change spreads instead.

**Recommendation (not blocking for v1):** project to the fields the viewer actually needs (`Pick`-style) plus `actor_name`, or at minimum drop `before_state`/`after_state`/`metadata` from the public projection until a viewer surfaces them. This also shrinks the wire payload for the 100–500-row pages. Keep it a conscious decision: if the intent is "managers can inspect everything," document that on the query.

### I3 — Action filter is exact-match only; no affordance tells the manager that (Improvement)

`auditListHandler` uses `by_action_date` with `q.eq("action", args.action)` — an **exact** match. The viewer's placeholder ("Filter by action (e.g. `refund.committed`)") implies you type a full verb, which is fine, but a partial like `refund` returns zero rows with a bare "No audit entries." A manager who types `refund` and sees nothing will reasonably conclude there are no refunds. For v1 with a known, smallish verb vocabulary this is acceptable, but a `Select` over the distinct verbs present in the loaded rows (the spec offered this as an option) would remove the foot-gun. At minimum, the empty state could distinguish "no entries" from "no entries matching `<filter>`."

---

## Refinements

### R1 — `rows.length >= limit` "Load more" heuristic can show the button on an exact-boundary page (Nitpick)

`{rows.length >= limit && limit < MAX && ...}` shows "Load more" whenever the page is full. If the table holds exactly `limit` rows, the button appears, a click bumps `limit`, the query returns the same N rows, and the button then disappears — one wasted round-trip. Harmless (reactive, cheap, self-correcting) and the standard "is there maybe more?" pattern, but worth a one-line comment so a future reader doesn't mistake it for a bug.

### R2 — Deviation (a): explicit return annotation on `audit.public.list` — correct, well-documented (Acknowledged)

The added `): Promise<AuditRowWithActorName[]>` on the handler, with the comment explaining it breaks the `ApiFromModules` inference cycle that would otherwise widen `api` to `any` at every consumer, is exactly the right call. This is the documented v0.5.3a "annotate-when-calling-internal" pattern (any `public` function whose handler references `internal.*` must annotate its return). It also gives the FE a precise `FunctionReturnType<typeof api.audit.public.list>[number]`, which `audit.tsx` consumes. Good. No action.

### R3 — Deviation (b): `cancellingRef` double-dispatch guard in `refund/detail.tsx` — earned, beyond plan (Acknowledged)

The `cancellingRef` guard (added in commit `f251345` as "review I1") prevents a double-click from firing two `cancelPendingRequest` calls before the first resolves. The mutation is `withIdempotency`-wrapped with a fresh `crypto.randomUUID()` key per call — so two clicks would mint **two different keys** and both would hit the DB (the second a no-op against an already-denied request, but still a wasted round-trip and a potential second audit row). The ref guard is the correct fix at the right layer (the idempotency key is per-call, so it cannot dedupe two distinct user clicks). The `try/finally` resets it on both success and error. This is a legitimate hardening, not gold-plating. No action.

### R4 — `onCancel` prop on `ApprovalPending` — earned, stays a clean optional (Acknowledged)

The new `onCancel?: () => void` is the minimal possible surface widening: the component stays role-agnostic (the host decides whether to pass it), the button only renders in the `pending` branch (terminal states make no sense to cancel), and it is symmetric with the existing `onDenied`/`onExpired` Retry buttons. The manager-gate lives in the host (`session.staff.role === "manager" ? handleCancelRequest : undefined`), so a non-manager session literally cannot receive the prop and the throwing `MANAGER_ONLY` path is unreachable from the UI. This is the right division — the component is a dumb renderer, the policy lives in the host. The prop is earned, not speculative feature surface. Note for the future: `charge.tsx`'s `ApprovalPending` correctly does **not** pass `onCancel` (spec rationale: sale-abandon already cascade-denies), so the new optional prop is simply absent there — exactly as designed.

### R5 — `requireManagerSession` return-type drift is pre-existing, not introduced here (Nitpick)

`cancelPendingRequest` reads `session.staffId` from `requireManagerSession`, whose annotated return is `{ staffId, deviceId }` (no `role`), while the underlying `requireSession` returns `role` too. Not touched by this branch; flagging only so a future reader doesn't attribute it to v0.5.8. No action.

### R6 — Hook `latest` via `reduce` is correct; consider a tie-break comment (Nitpick)

`useAwaitingPaymentRecovery` picks `latest` via `reduce((a, b) => b.created_at > a.created_at ? b : a)` — correct given the query returns ascending index order (so `[0]` would be the *oldest*, which is why the plan explicitly chose `reduce`). On a `created_at` tie the strict `>` keeps the earlier-iterated row; for a single-device booth this is a non-issue. Fine as-is; a one-word "(ties keep first)" comment would preempt a future "why not `>=`?" question. The `{ count: 0, latest: null }` while-loading return correctly prevents banner flash.

### R7 — `mgr/audit` `MAX = 500` magic number duplicates the server clamp (Nitpick)

`audit.tsx` hardcodes `MAX = 500` with a comment noting "server clamps limit to 500 (`auditListHandler`)." Two sources of truth for the cap. Low-risk (the comment ties them), but if the server clamp ever changes, the FE "Load more" ceiling silently diverges. Not worth a shared constant for v1; noted for completeness.

---

## Graft integrity (ADR-034 Layer 2 check)

Nothing in this branch touches `convex/api/v1/`, introduces a cross-deployment shape, or commits a new stable string identifier. `actor_name` is a **display-only, mutable** label derived server-side — consistent with ADR-034's `staffName` guidance ("mutable display-only, never a join key"); the join key remains `actor_id`. The audit log is explicitly listed in ADR-034 as POS-internal and "never exposed externally," so enriching its *internal* public query has zero bearing on the external contract. **Graft integrity: intact.**

## Plan fidelity

All 7 tasks built and committed on the planned boundaries (A-backend, A-frontend, B, C-component, C-host, docs, plus the verification/annotation fixes). Tests match the planned harness (`vi.mock("convex/react")` dispatch by `getFunctionName`; convex-test backend for the BE actor_name test). The two deviations are both improvements over the plan and are documented in-commit. Docs (CLAUDE.md file-locations, CHANGELOG, API_REFERENCE) updated as planned.

## Over/under-engineering for v1

Right-sized. The text-input action filter (vs a `Select`), the local-state "Load more" (vs cursor pagination), and the absence of a charge-screen cancel are all correct v1 scope calls with documented rationale. The `cancellingRef` guard and the return annotation are the only additions beyond the plan, and both are justified hardening, not gold-plating.

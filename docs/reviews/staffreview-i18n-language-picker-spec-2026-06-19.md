# Staff Review: EN/ID Language Picker (#1 i18n) — SPEC

**Date:** 2026-06-19
**Plan:** `docs/superpowers/specs/2026-06-19-i18n-language-picker-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** Design spec (implementation phases/waves/rollback land in the writing-plans step — not penalized here).

## 1. Summary

**Overall Assessment:** Revise (then approve). Architecture is sound and well-scoped. Three Critical
corrections are all **factual path/projection errors** that would mislead the implementer; fixing them is
cheap. One Improvement (optimistic-toggle race) is a real correctness risk worth pinning before the plan.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Wrong staff-table path | Schema | spec §B |
| 2 | Session projection is an allowlist, not a strip | Logic | spec §B |
| 3 | `setOwnLocale` self-only + real authCheck underspecified | Security | spec §B |

### Issue 1: Staff table is in `convex/auth/schema.ts`, not `convex/staff/schema.ts`
The spec says "add `locale` … to the `staff` table (`convex/staff/schema.ts`)". That file **does not
exist** — `convex/staff/` has no `schema.ts`. The `staff` table is defined at
**`convex/auth/schema.ts:5`** (`staff: defineTable({...})`); the `auth/` module owns Staff per CLAUDE.md.

**Recommendation:** point the schema change at `convex/auth/schema.ts`.

### Issue 2: `locale` must be EXPLICITLY added to the session projection — it's an allowlist
The spec says "ensure `locale` is not stripped the way `pin_hash` is." That framing is wrong and would
lead the implementer to think no projection edit is needed. `getSession` (`convex/auth/public.ts:33-38`)
returns an **explicit allowlist** of staff fields: `{ _id, name, role, must_change_pin }`. A new field is
invisible to the client unless added. Two edits are required, not zero:
1. `convex/auth/public.ts` `getSession` → add `locale: staff.locale ?? "en"` to the returned `staff` object.
2. `src/hooks/useSession.ts:21-26` → add `locale: "en" | "id"` to the `status:"active"` staff type.

(Confirms English pre-login: `getActiveStaff` at `auth/public.ts:12-21`, the pre-auth login query,
returns only `{_id,name,role}` — no locale exists before a session, exactly as the hybrid model wants.)

**Recommendation:** rewrite §B to say "add `locale` to the `getSession` projection AND the `useSession`
active-staff type" (explicit add, not "don't strip").

### Issue 3: `setOwnLocale` must derive staff from the session (no `staffId` arg) + a real authCheck
The spec says "patches the caller's own staff row" but doesn't pin the security shape. The `logout`
precedent (`auth/public.ts:63-70`) uses a deliberately **lax** `authCheck: async () => {}` — that is wrong
for a write that must be authenticated. `setOwnLocale` must: (a) use a **real** staff-session authCheck
(the dual-call pattern, rule #20); (b) take **no** `staffId` arg — derive `staff_id` from the validated
session so a staffer can only set their **own** locale (an explicit `staffId` arg would let anyone rewrite
another staffer's preference). Args = `{ locale, sessionId, idempotencyKey }` only.

**Recommendation:** spell out args `{ locale, sessionId, idempotencyKey }`, real authCheck, self-derived
`staff_id`. Audit `staff.locale_set`, `source: "booth_inline"` (matches `logout`).

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Apply-on-login must not clobber the optimistic toggle | H | L |
| 2 | Mutation module ownership (`staff/` vs `auth/`) | M | L |
| 3 | Pin ADR number = ADR-049 | L | L |

### Improvement 1: apply-locale-on-login race vs optimistic toggle
If the apply effect continuously syncs `setLocale(session.staff.locale)` on every render, this sequence
flickers: user taps → optimistic `setLocale("id")` → next render still sees the **old**
`session.staff.locale="en"` (the `getSession` query hasn't refetched yet) → effect resets to `"en"` →
mutation lands → query refetches `"id"` → flips back. Net: a visible flicker.

**Recommendation:** make the effect a **login-transition seed**, not a continuous sync — apply
`staff.locale` only when session status transitions `none/loading → active` (track previous status), and
let the toggle be the **single writer** of runtime locale thereafter. Add a test for "toggle then session
refetch does not flicker."

### Improvement 2: where `setOwnLocale` lives
`staff/public.ts` owns staff-row writes (precedent: session-only `updateStaffName`); `auth/public.ts`
owns self-service identity (precedent: `changePin`, `getSession`). Either is defensible. **Recommend
`staff/public.ts`** (it's a staff-row field write) and note the apply-side read stays in `auth.getSession`.

### Improvement 3: ADR number is ADR-049
Highest existing ADR = 048 (`docs/ADR/`). The spec hedged "e.g. ADR-049" — make it definite **ADR-049**.

## 4. Refinements (Optional)
- The "V8-safe" note on `src/lib/i18n/t.ts` is misapplied — V8-safety is a `convex/lib/` rule (no
  `"use node"`); a `src/` frontend module has no such constraint. Drop it to avoid confusion.
- Workflow guardrail: some `aria-label`s are dynamic (interpolated). The extraction stage should key the
  static template and pass dynamic bits as `{params}`, not key the rendered string.

## 5. Duplication Analysis
- **Reuse:** `withIdempotency` (`convex/idempotency/internal`), `logAudit` (`convex/audit/internal`),
  the `no-restricted-syntax` fence shape (`eslint.config.js:163+`, the #12/ADR-048 toast registry),
  `gridItemVariants` (`src/lib/motion.ts`). No duplication risk — net-new i18n layer.
- **Do NOT** re-implement currency/date — `src/lib/format.ts` stays untouched (locked).

## 6/7. Phases / Agents
Phases come in the writing-plans step. Extraction fan-out → Workflow (Lucas opted in); infra (core +
schema + toggle) is the bounded first wave, extraction is the XL second wave.

## 8. Git Workflow
Spec-plan-pipeline convention: worktree off synced `main`, squash-PR. ✅ in progress.

## 9. Documentation
ADR-049 (new), `docs/SCHEMA.md` (staff.locale), `docs/CHANGELOG.md`, CLAUDE.md (auth/ + staff/ module
notes, new business rule for per-staff locale). Plan should list these.

## 10. Testing Plan Assessment
**Verdict:** Adequate. Add: "optimistic toggle does not flicker on refetch" (Improvement 1) and
"`setOwnLocale` rejects setting another staffer's locale" (Issue 3, self-only).

## 11. Edge Cases
- [ ] Staffer with `locale` absent ⇒ English (optional field default).
- [ ] Toggle tapped offline ⇒ optimistic flip holds; mutation queues/fails → revert + toast.
- [ ] Two staff overlapping on the shared device — locale follows whoever is logged in (per-staff, by design).
- [ ] `as`-cast hole in `id.ts` ⇒ keyset-parity runtime test catches it.

## 12. Approval Conditions
**To approve, address:** Issues 1, 2, 3 (path + projection + self-only authCheck).
**Recommended before implementation:** Improvements 1–3.

---
*Generated by /staffreview*

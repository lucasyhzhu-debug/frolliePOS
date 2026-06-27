# Staff Review: Off-booth manager override (`shift_override`) — SPEC

**Date:** 2026-06-27
**Plan:** `docs/superpowers/specs/2026-06-27-off-booth-manager-override-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** Design spec (pre-plan) — reviewed for architecture/logic/security/testing fit, grounded in real code.

---

## 1. Summary

**Overall Assessment:** Revise (then proceed to plan)

The design is architecturally sound — adding a `shift_override` approval kind is the correct,
precedented mechanism. But three assumptions are **wrong against the real code** and would have
produced a broken implementation. All three are cheap to fix in the spec now. After the fixes the
design reuses the existing off-booth approval envelope almost verbatim.

The single highest-value catch: **the blocked staffer has no session**, so the request side cannot
be session-authenticated the way the spec drafted it.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | Off-booth approve auth mechanism named wrong | Security/Logic | Touchpoint (d), (c) |
| C2 | Request side assumes a session that cannot exist | Logic | Flows, Touchpoint (d) |
| C3 | Token-auth-before-cache ordering not specified | Security | Touchpoint (d) |

### C1 — Off-booth approval does NOT use `verifyPinOrThrow`
Every off-booth approve action (`approveManualPayment`, `approveRefund`, `approveSpoilage`,
`approveStaffPinReset` in `convex/approvals/actions.ts`) is a `"use node"` action that:
1. resolves the approving manager by **staff code** via `internal.auth.internal._getByCode_internal`
   (asserts `active && role === "manager"`, else `NOT_MANAGER`);
2. verifies the PIN with `argon2Verify({ password, hash: manager.pin_hash })` directly — **not**
   `verifyPinOrThrow`;
3. on miss: `_recordFailedAttempt_internal({ staffId, deviceId: "approve-route", countTowardLockout:false, source:"telegram_approval" })` **and** `_recordTokenPinFailure_internal({ requestId })`
   (returns `{ capped }` → `REQUEST_REVOKED` at the cap).

So `approveShiftOverride` takes `{ token, managerStaffCode, managerPin, resultingState, idempotencyKey }`
and the `/approve` UI collects **staff code + PIN** (every existing kind component has a `staffCode`
`useState`). The spec's "verify the manager's booth PIN (`verifyPinOrThrow`)" is wrong on both the
helper and the fact that a code is required.

**Recommendation:** Rewrite touchpoint (d) approve to mirror `approveSpoilage` exactly (token-auth →
cache → narrow context → `_getByCode_internal` → `argon2Verify` → commit → `_markResolved_internal`).

### C2 — The request side is session-LESS (device-keyed)
The whole failure mode is "the next staffer **cannot log in**." So there is no `staff_sessions` row
to authenticate `requestShiftOverride` with — the spec's `requestShiftOverride(sessionId, …)` (modeled
on `requestManualPaymentApproval`) cannot work. Confirmed by the **existing** inline override in
`src/routes/login.tsx`: it is triggered from the blocked login screen and calls
`shifts.actions.managerOverride({ deviceId, managerStaffId: pickedManager._id, managerPin, … })` —
**no session**, a device id + a manager picker.

**Recommendation:** `requestShiftOverride({ deviceId, idempotencyKey })` — resolve the outlet from the
device (`internal.auth.internal._getDeviceOutletId_internal`), read the active hold
(`_getActiveShift_internal`), and build the context. Session-less, exactly like `notifyStaffLockout`.
If there is no active hold, return early WITHOUT sending a card (nothing to override).

### C3 — Token auth must precede the idempotency cache
`approveRefund` / `approveSpoilage` do the token lookup + constant-time `timingSafeEqual` compare +
state guards **before** the action-level `_lookup_internal` cache pre-check (rule #21 / I5: a leaked
idempotencyKey without a valid token must not replay a cached commit). The spec doesn't state the
ordering. For a destructive override, follow the refund/spoilage ordering, not the older
manual-payment one (which checks cache first).

**Recommendation:** Specify token-auth-before-cache in touchpoint (d).

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | Dedup via existing `_listPendingByKind_internal`, not a new cancel fn | M | L |
| I2 | Reuse `_buildSignoffSummary_internal` for the context sales snapshot | M | L |
| I3 | `/approve` is one `index.tsx` w/ per-kind components (no `pin.tsx`) | M | L |
| I4 | Extend the EXISTING `login.tsx` PinSheet override, don't build new | H | M |

### I1 — Reuse the dedup precedent
`requestManualPaymentApproval` dedups with `_listPendingByKind_internal({ kind, entityId, outletId })`
→ returns the existing request if found. Use the same with `entity_type:"pos_shifts"`,
`entity_id: shift_id`. Drop the proposed new `_cancelPendingShiftOverrideForOutlet_internal` — no new
internal needed.

### I2 — Reuse the signoff summary aggregator
The commit already calls `internal.shifts.internal._buildSignoffSummary_internal({ shiftStartMs,
endMs, outletId })` for `{ durationMs, totalSalesIdr, txnCount, manualBca* }`. Call the same at
request time to populate `sales_so_far_idr` / `txn_count` in the context — no new aggregation query.

### I3 — `/approve` UI shape
`src/routes/approve/index.tsx` holds a component per kind (`staff_pin_reset`, `manual_payment_override`,
`refund`), each with its own `staffCode`/PIN entry and error mapping. Touchpoint (c) is: add a
`ShiftOverride` component there (context card + **Close booth / Release** choice + code+PIN), and add
its error strings to the `t("approve.err*")` map. There is no `approve/pin.tsx` to touch.

### I4 — Extend the existing booth override, don't add a parallel one
`login.tsx` already owns the override: a `PinSheet` with a manager picker + its own idempotency key
(`shift:override:login:<device>`), shown when `boothState` is held-by-other (`login.shiftHeldBy`).
The two-path UX should: (a) keep that inline `PinSheet` (the inline path, now with a Close/Release
toggle + a `resultingState` arg on `managerOverride`); (b) add a **"Request via Telegram"** button
beside it (precedent: the charge screen's `charge.managerOverrideTip` "…or use 'Request manager
approval' below") that calls `requestShiftOverride({ deviceId, overrideKey })`. Don't introduce a new
override surface.

---

## 4. Refinements (Optional)

- R1 — Booth "override requested" indicator: after the Telegram request, the reactive `boothState`
  flips when the manager resolves it (shift ended / outlet closed), returning the login screen to a
  normal state. An explicit "override requested, waiting for a manager" banner (a small pending-by-
  device read) is nicer but optional — the reactive flip already unblocks the staffer.
- R2 — The commit could take `outletId` directly (the request row has it) instead of re-resolving
  from `deviceId`; keeping `deviceId` is a smaller change. Either is fine.

---

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `approveSpoilage` envelope | `convex/approvals/actions.ts` | Copy verbatim for `approveShiftOverride` |
| `requestManualPaymentApproval` dedup+notify | same file | Model `requestShiftOverride` (but session-less) |
| `_listPendingByKind_internal` | `convex/approvals/internal.ts` | Dedup per shift |
| `_buildSignoffSummary_internal` | `convex/shifts/internal.ts` | Context sales snapshot |
| `_managerOverrideCommit_internal` | `convex/shifts/shiftsInternal.ts` | Shared commit (+`closeOutlet`,`source`) |
| `login.tsx` PinSheet override | `src/routes/login.tsx` | Extend for two-path + Close/Release |
| per-kind component | `src/routes/approve/index.tsx` | Add `ShiftOverride` variant |

### Duplication risks
- Don't re-implement a token/PIN/cap envelope — it's identical across 4 actions already. Copy `approveSpoilage`.

## 6. Phase / Wave Accuracy
Spec has no waves yet (that's the plan's job). The plan must serialize the shared files:
`approvals/kinds.ts`, `convex/_generated/api.d.ts` (codegen), `src/routes/approve/index.tsx`, and
`telegram/send.ts` are each touched by multiple tasks.

## 7. Specialist Agent Recommendations
| Area | Agent | Rationale |
|------|-------|-----------|
| Backend (kind, actions, commit) | `convex-expert` | Convex action/mutation + idempotency envelope |
| `/approve` + `login.tsx` FE | `frontend-integrator` / `/frontend-design` | two-path sheet, kind component |

## 8. Git Workflow Assessment
Docs-only at this stage. Implementation commits should be: kind+schema → commit; commit; backend
actions+commit → commit; telegram template → commit; approve UI → commit; login two-path → commit;
tests throughout. Squash-merge per repo convention. Build/typecheck before push.

## 9. Documentation Checkpoints
At execution: `SCHEMA.md` (new audit verbs + context), `API_REFERENCE.md` (`requestShiftOverride`,
`approveShiftOverride`, changed `managerOverride` sig), `CHANGELOG.md` (v1.3.1), `CLAUDE.md` rule #19
(new kind in the APPROVAL_KINDS list), remove the slice from `ROADMAP.md`.

## 10. Testing Plan Assessment
**Verdict:** Adequate after adding the C2/C1 paths.
Add: session-less request resolves outlet from device + no-active-hold ⇒ no card; `approveShiftOverride`
wrong code/PIN → per-token cap (not `pos_auth_attempts`); `/approve` `ShiftOverride` renders both
outcome buttons; commit both branches (close vs release); dedup returns existing per shift.

## 11. Edge Cases to Address
- [ ] No active hold at request time (stale tap) → no card, friendly booth message.
- [ ] Hold already ended between request and approve → commit is an idempotent no-op; outlet-close
      still applies if `resultingState:"close"`. Decide: close-only on a no-hold approve is acceptable
      (it just ensures closed). Document it.
- [ ] Two staffers both tap "Request" → `_listPendingByKind_internal` dedup returns the same request.
- [ ] Manager picks "Release, keep open" but the booth was already closed → outlet stays as-is; hold ended.

## 12. Approval Conditions
**To approve, address:** C1, C2, C3 (rewrite touchpoints (c)/(d) + flows in the spec).
**Recommended:** I1–I4 (all reduce code).

*Generated by /staffreview*

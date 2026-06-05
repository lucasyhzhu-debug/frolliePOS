# Staffreview — v0.5.7 Telegram `/activatepos` device activation

**Date:** 2026-06-05
**Reviewer:** senior-engineer architectural pass (ADR-034 deep-module / surface-API lens)
**Range:** `7eb3545..b4db00b` (branch `worktree-v0.5.7-activatepos`)
**Changed:** `convex/auth/schema.ts`, `convex/staff/internal.ts`, `convex/staff/public.ts`, `convex/telegram/activatePos.ts`, `convex/http.ts`, `convex/seed/__tests__/reset.test.ts` + tests + docs.

---

## Summary

**Verdict: this change makes the affected module DEEPER, not shallower.** It replaces a single inlined code-issuance body in `staff/public.generateDeviceSetupCode` with a single-writer helper (`issueDeviceSetupCode`) that hides the collision loop, secure-RNG, insert, and audit shape behind one narrow signature, then exposes exactly two thin entry points (booth mutation + a 4-arg Telegram internalMutation wrapper). The new Telegram surface (`buildActivatePosCommand` / `handleActivatePos`) is the only widening, and it is internal-action + factory only — no new client-facing public mutation. Cross-module calls use the codebase's already-sanctioned `internal.<module>.internal.*` pattern. Plan-to-implementation fidelity is essentially 1:1; the only unplanned change (the `reset.test.ts` type-narrow) was forced by the schema edit and is correct.

This is a clean, well-scoped change. There are **no Critical issues**. Findings below are one Important doc-hygiene item, a couple of small Improvements, and refinements.

---

## Critical Issues

None.

The two things most likely to be Critical were both checked and are sound:

1. **Auth-vs-staff ownership of the device-setup writer.** The write logic lives in `staff/internal.ts` while the table (`pending_device_setups`, `registered_devices`) is defined in `auth/schema.ts`. This *looks* like a module-ownership smell under ADR-034 ("each module owns its tables"). It is not introduced by this PR: the booth writer (`generateDeviceSetupCode`) already lived in `staff/public.ts` and already wrote `pending_device_setups` before v0.5.7. The PR moved the shared body to `staff/internal.ts` — i.e. it kept the writer in the same module it already lived in, and `staff/internal.ts` already imported `requireManagerSession` from `auth/sessions` (pre-existing auth↔staff coupling). The PR did not deepen the tension; it left it exactly where it was. See Improvements for the recommendation.

2. **Cross-module reach into another module's `internal.ts`.** `telegram/activatePos.ts` calls both `internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal` and `internal.telegram.chatRegistry.internal.getChatIdByRole`. This is the sanctioned cross-module pattern in this codebase, confirmed by precedent: `telegram/foundersSummary.ts` calls `internal.transactions.internal._dailySalesSummary_internal`, and `telegram/chatRegistry/public.ts` calls `internal.auth.internal._requireManagerSession_internal`. ADR-034 §"Cross-module patterns" #2 explicitly endorses calling the owning module's `internal.ts` via the generated `internal` API; the lint gate only blocks raw cross-module `ctx.db.*`. No facade is required or expected here.

---

## Improvements

### Imp-1 (Important) — Duplicate audit-verb entries in `docs/SCHEMA.md`

The audit-verb list in `docs/SCHEMA.md` now lists `device.activated` and `device.setup_code_issued` **twice**:

- Lines 622 / 624 — the pre-existing bare entries (`device.activated`, `device.deactivated`, `device.setup_code_issued`).
- Lines 734 / 735 — the new richly-annotated v0.5.7 entries.

The new entries carry the useful detail (source/actor/metadata per issuance path), but the originals were left in place rather than amended, so the verb list now has duplicates. This is doc hygiene, not correctness — `audit_log.action` is a free `v.string()` with no code enum (CLAUDE.md), so nothing breaks. **Fix:** either delete the bare lines 622/624 and keep the annotated v0.5.7 block as the canonical entry, or fold the annotations into the originals in place and drop the duplicate block. Pick one location per verb.

### Imp-2 (Minor) — Resolve the auth/staff ownership tension, or document it as accepted

`pending_device_setups` and `registered_devices` are defined in `auth/schema.ts`, but every writer (`issueDeviceSetupCode`, `activateDevice`, `deactivateDevice`) lives in `staff/`. Under a strict ADR-034 reading ("each module owns its tables; if two modules need the same data, one owns it and the other reads through the owner's API") this is a split-ownership concept: the schema says auth owns it, the code says staff owns it. It predates this PR and the PR was right not to expand scope to fix it. Recommendation, deferrable: either (a) move the device-setup table fragments from `auth/schema.ts` into a `staff/schema.ts` device section so ownership is consistent, or (b) add a one-line note in `docs/SCHEMA.md` / CLAUDE.md that device tables are auth-schema-defined but staff-module-written by deliberate convention (devices straddle the auth/staff seam). Today it's an undocumented straddle that the next agent will re-flag. Not blocking.

### Imp-3 (Minor) — `from_id` modulo-bias comment is fine; consider one assertion

`generateSecureSetupCode()` uses `crypto.getRandomValues` over a `Uint32Array(1)` and maps with `% 900_000`. The "modulo bias negligible at this range" comment is accurate (2^32 / 900_000 leaves bias on the order of 10^-4, immaterial for a 1h-TTL single-use code, especially with the 5-retry collision loop on top). No change needed; flagging only that there is no direct unit test of the format/range of `generateSecureSetupCode` in isolation — the `/^\d{6}$/` assertion in the helper test covers it transitively, which is adequate for v1.

---

## Refinements

### Ref-1 — `issued_by_telegram` object is earned, not speculative

The focus asked whether `issued_by_telegram: { from_id?, chat_title }` is over-engineered. It is justified: the spec's "honest audit trail" goal (record *which Telegram user/chat* triggered issuance) cannot be met by the `"system"` sentinel alone — the sentinel deliberately drops the human. The object carries the attribution the sentinel loses. `from_id` being optional is correct and load-bearing: `MessageContext.fromId` is `number | undefined` (Telegram omits `from` for anonymous supergroup admins / channel posts), and a required `v.number()` would dead-end the happy path for exactly the "send as admin" case a managers chat is likely to use. The chat-role gate, not `from_id`, is the security boundary; `from_id` is attribution-only. Well-reasoned.

### Ref-2 — The error-fallback reply (try/catch → "try again") is warranted for v1

The catch-and-reply on issuance/send failure ("Couldn't generate a setup code — please try again") is a small amount of code for a real UX win: a manager off-booth who gets silence cannot tell whether the bot is down, the chat is unbound, or they typo'd. The inner best-effort try/catch around the fallback send is appropriately defensive (don't throw out of an internalAction over a Telegram network blip). This is proportionate, not gold-plating.

### Ref-3 — `source` discipline on activation is exactly right

`activateDevice` keeps `source: "booth_inline"` even for Telegram-issued codes, with the channel carried in `metadata.activated_via`. The inline comment correctly reasons that *activation* is always a physical booth act (code typed into the new device); only *issuance* came from Telegram. This avoids overloading `telegram_approval` (CLAUDE.md rule #10 reserves that source for the approval/token ACT flow). Issuance, by contrast, *does* use `source: "telegram_approval"` — defensible since the issuance genuinely originated in the managers chat. The asymmetry is intentional and documented. Good.

### Ref-4 — Plan fidelity is near-perfect; the unplanned `reset.test.ts` fix is correct and necessary

Implementation matches the plan task-by-task (schema → single-writer helper → `activateDevice` tolerance → command factory → http wiring → docs). The one unplanned change — `convex/seed/__tests__/reset.test.ts` narrowing `activated_by` before `ctx.db.get()` — was *forced* by Task 1: making `registered_devices.activated_by` optional turns `devices[0].activated_by` into `Id<"staff"> | undefined`, which `ctx.db.get()` rejects. The fix (`expect(activatedBy).toBeDefined()` + `activatedBy!`) is the minimal correct narrowing and keeps the test's intent (booth seed always sets the issuer). The plan even predicted Task-1 typecheck fallout on consumers; the seed test was simply one it didn't enumerate. Correct.

### Ref-5 — Graft integrity: optional fields do not complicate the v1.1+ Frollie Pro graft

Making `issued_by` / `activated_by` optional and adding `issued_via` is purely additive and back-compat (existing rows stay valid; no migration). Per ADR-034 Layer 3, these are POS-internal tables (`registered_devices`, `pending_device_setups` are explicitly named as "never exposed externally" in ADR-034 §"Affects other ADRs"). They are not part of the `convex/api/v1/` surface and carry no stable-string-id commitment, so the shape change locks in nothing for the graft. The `"system"` actor sentinel was already accepted by `logAudit` (`Id<"staff"> | "system"`), so no new audit column was minted — also graft-neutral.

### Ref-6 — Single-writer helper is genuinely deep, not a pass-through

`issueDeviceSetupCode` hides four concerns behind one signature: secure RNG, the 5-iteration collision-retry loop with the active-and-unexpired filter, the `pending_device_setups` insert, and the branch-on-channel audit emission. The booth mutation went from ~30 lines of inlined logic to a 4-line delegation; the Telegram wrapper is a 3-line `internalMutation`. Both callers are strictly thinner than the hidden body — the defining property of a deep module under ADR-034. The plain-async-fn (not `internalMutation`) choice for the shared body is correct and explicitly follows the `logAudit` precedent so the booth mutation can call it inside its own transaction. This directly satisfies the v0.5.5 canonical-insert anti-drift lesson.

---

## Verification notes

- Cross-module pattern confirmed against precedent (`foundersSummary.ts`, `chatRegistry/public.ts`) — sanctioned, no facade needed.
- Narrow-catch in `handleActivatePos` mirrors `foundersSummary.ts` exactly (same `"No Telegram chat assigned to role"` message match, rethrow-on-unexpected). Consistent.
- Test coverage matches the spec's 7 scenarios (managers-chat happy path, non-managers no-op, unbound-role no-op, end-to-end activation, audit source/actor, `fromId` undefined, matcher `@Bot`/trailing-args). Solid.
- One doc duplicate (Imp-1) is the only artifact-level issue found.

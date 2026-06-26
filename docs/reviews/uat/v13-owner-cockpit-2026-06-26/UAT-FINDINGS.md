# Persona-UAT — v1.3.0 Owner Cockpit (Spec 3)

**Run date:** 2026-06-26
**Branch:** v13-owner-cockpit · **PR:** #146
**Run-id:** v13-owner-cockpit-2026-06-26
**Status:** ✅ **EXECUTED (live)** — single navigation pass + dual persona evaluation complete.
**Fidelity caveat:** cockpit entered via a **Path B fixture session** (minted directly via
`auth/ownerInternal:_cockpitLoginCommit_internal`, no real Telegram OTP). The OTP delivery and the
**B7 cockpit↔booth session-rejection** invariant were therefore not exercised live — they remain
covered by the 38 cockpit convex-tests (booth-session rejection, `NOT_BOOTH_SESSION`).

**Env:** worktree dev `http://localhost:5174` · deployment `helpful-grasshopper-46` · owner "Lucas"
(promoted via `setStaffRole`) · default outlet + catalog + 4 staff seeded.

## Severity tally (16 findings, deduped)
- **BLOCKER: 0**
- **BUG: 0** — the 1 disputed "timezone step renders blank" was verified statically as an
  `AnimatePresence mode="wait"` capture artifact: `StepTimezone` renders the `<Input>`
  unconditionally (`src/routes/cockpit/outlets/new/index.tsx:502`), and Review shows
  `Timezone = Asia/Jakarta`. **Not a real defect.**
- **UX-HIGH: 8**
- **UX-NIT: 7**

**Verdict:** No merge-blocking defects. The functional core (idempotent BLANK + CLONE create,
switcher scoping 1→3 outlets, inline `FieldMessage` dup-code validation, amber `.theme-owner`
plane, integer-rupiah zero-case) all passed with **0 console errors / 0 network failures**.
UX-HIGH/UX-NIT routed to ROADMAP per the merge-gate convention.

## Confirmed positives (no finding)
- **D12 PASS:** duplicate-code error is an inline red `FieldMessage` under the Code field (not a
  toast); Next gate holds on mobile + desktop — conforms to ADR-048.
- **A1 zero-case PASS:** money renders `Rp 0`, `Rp` prefix, no cents — rule #14 / ADR-015.
- **D11 PASS:** canvas confirmed `rgb(35,25,5)` (#231905) amber plane + gold accents via semantic
  tokens; holds mobile + desktop — ADR-047/052.
- **Stock-not-cloned surfaced** in clone UI ("Catalog and settings will be copied. Stock is not
  cloned."); backend invariant covered by the `stock-NOT-cloned` convex-test.
- **Idempotent create + switcher scoping** behaved per spec across BLANK + CLONE and 1→3 outlets.

---

## UX-HIGH (8) — routed to ROADMAP "Owner cockpit polish"

1. **Booth chrome leaks into the cockpit plane.** `/cockpit/outlets*` sub-routes render the booth
   `SpokeLayout` header (thermal-printer icon + "Lucas ● live" chip) though the cockpit has no
   print surface. The dashboard uses a clean OWNER · COCKPIT header. B7/rule-#26 plane-separation
   concern. *Fix:* give cockpit sub-routes a cockpit shell (strip printer + connection chip).

2. **Clone copies the source's receipt business name with no override.** KG clone of PKW shows
   Receipt name = "Frollie — Pakuwon"; clone skips the Bank & receipt step → wrong outlet name on
   customer receipts. *Fix:* keep a minimal editable receipt-identity step in clone, or derive
   from the new outlet name and show editable on Review.

3. **Clone can create an outlet with NO staff, no warning.** Clone Review shows Staff = — and
   proceeds; no `staff_outlet_access` grant → booth unopenable. *Fix:* warn at Review, carry the
   source's staff, or add a staff step to clone.

4. **Disabled "Next" still looks tappable on mobile.** With a dup code, Next is correctly disabled
   but keeps a solid gold fill on mobile (low-contrast label) → invites dead taps. Gate logic is
   correct. *Fix:* apply disabled token treatment + label contrast on mobile.

5. **Timezone is free-text, no validation.** Arbitrary strings accepted; timezone drives the WIB
   day-window for `dashboardSummary`/`perOutletSummary` + the 22:00 cron → silent money/reporting
   fault on a typo. *Fix:* validated IANA-zone select (or validate vs `Intl.supportedValuesOf`),
   inline `FieldMessage` on unknown, default Asia/Jakarta.

6. **Cockpit is English-only with jargon ("COCKPIT", "GROSS") and no EN/ID toggle** (the booth has
   one, ADR-049). *Fix:* translate the cockpit / respect the EN/ID toggle, or at minimum replace
   insider words. (Confirm whether cockpit i18n is in-scope for v1.3.)

7. **Consolidated headline summed client-side over a staggered fan-out** → transient under-count
   risk with no loading marker (inferred; not observable with all-zero seed). *Fix:* render the
   headline only when all per-outlet summaries resolve (skeleton until then), or sum server-side.

8. **B7 cockpit↔booth session rejection NOT exercised live** (Path B fixture). *Fix:* smoke-test
   (a) `kind:"cockpit"` calling a booth mutation → `NOT_BOOTH_SESSION`; (b) booth session loading
   `/cockpit/*` → rejection. Covered by convex-tests but not live-verified.

## UX-NIT (7) — routed to ROADMAP

1. Owner (Lucas, role Owner) appears in the per-outlet staff-access roster — filter role `owner`
   out of the assignable booth-access list (B7 hygiene).
2. Loading state is bare unstyled "Loading…" text, not a designed skeleton (D11/C10).
3. Brand casing inconsistency — lowercase "frollie" wordmark vs "Frollie —" outlet names.
4. Clone source selection relies on a subtle border tint (no checkmark like the Staff step).
5. Telegram step copy too technical ("add the Frollie bot", run "/register") — plain language.
6. Dashboard shows GROSS/Refunds but no plain net "takings today" figure.
7. Desktop wizard has no max-width — fields span the full 1280px viewport (`max-w-xl`, centred).

---

## Coverage gaps (declared, not defects — covered by automated tests / pending human gates)
1. **B7 session bleed:** real OTP + cockpit↔booth resolver rejection — covered by 38 convex-tests.
2. **A1 non-zero money:** id-ID thousands grouping + client-side sum of non-zero totals — covered
   by `format.ts` + ADR-015 tests; not exercised live (all-zero seed).
3. **Stock-not-cloned:** covered by the `stock-NOT-cloned` convex-test (backend assertion).
4. **C10 offline:** cockpit `createOutlet` blocks offline (ADR-025) — untested live.
5. **Error/empty states:** wizard create-failure, dashboard empty-outlets, outlet-list empty.

## Remaining human gates (owner-owned, per handoff)
- **Live owner smoke:** real OTP login, clone the default outlet, verify copied catalog + empty stock.
- **Visual/UX sign-off** of switcher / dashboard / wizard.

## Evidence pack
`docs/reviews/uat/v13-owner-cockpit-2026-06-26/` → `context.md`, `flow-log.md`,
`console-errors.log` (empty), `network-failures.log` (empty), `screens/01…22.png`.

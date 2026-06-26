# Flow Log — v13 Owner Cockpit (single navigation pass)

Mobile viewport (Pixel 7, 412×915) unless a step says desktop. Captured by the orchestrator;
judged by the two persona evaluators. Console/network detail in `console-errors.log` /
`network-failures.log` (both empty for this run).

---

## Step 1 — Dashboard landing — `/cockpit`
- **Action:** Set fixture cockpit session in localStorage, navigate to `/cockpit`.
- **Expected:** Amber owner dashboard; consolidated headline summed across outlets (client-side); per-outlet summary cards; outlet switcher defaulting to "All outlets".
- **Observed:** Renders `OWNER · COCKPIT` eyebrow, "Today", owner name "Lucas", a "Sign out" ghost button. Consolidated card: **GROSS Rp 0** (gold), **Transactions 0**, **Refunds Rp 0**. OUTLETS section: one card "Frollie — Pakuwon" / `PKW` / Gross Rp 0 / Transactions 0. Header shows "All outlets" switcher + lowercase "frollie" wordmark. Body background `rgb(35,25,5)` (#231905) — amber plane confirmed; `theme-owner` class present on `<html>`.
- **Screenshot:** screens/01-dashboard-landing.png
- **Console:** none
- **Network:** none
- **Load:** snappy (~0.8s to consolidated card)
- **State:** ok

## Step 2 — Outlet switcher: open — `/cockpit`
- **Action:** Click the "All outlets" header switcher.
- **Expected:** Dropdown listing "All outlets" (checked) + each outlet.
- **Observed:** Dropdown opens with "All outlets" selected (check mark) and the PKW outlet row (name + code).
- **Screenshot:** screens/02-switcher-open.png
- **Console:** none
- **Network:** none
- **Load:** instant
- **State:** ok

## Step 3 — Outlet switcher: scope to one outlet — `/cockpit`
- **Action:** Select the PKW outlet from the dropdown.
- **Expected:** Per-outlet section narrows to the chosen outlet; consolidated headline stays business-wide.
- **Observed:** Header trigger now reads "Frollie — Pakuwon" (outlined/active style). Per-outlet section shows exactly the 1 Pakuwon card (`scoped cards = 1`). Consolidated headline unchanged at Rp 0 (business-wide). Scoping behaves per spec. NOTE: with only one outlet present at this point, the visual narrowing effect is subtle; the multi-outlet scoping is more clearly demonstrable post-creation (see Step 19/20).
- **Screenshot:** screens/03-switcher-scoped-pkw.png
- **Console:** none
- **Network:** none
- **Load:** instant
- **State:** ok

## Step 4 — Outlet switcher: scope back to All — `/cockpit`
- **Action:** Re-open switcher, select "All outlets".
- **Expected:** Returns to business-wide per-outlet view.
- **Observed:** Header reverts to "All outlets"; per-outlet section shows all outlets again.
- **Screenshot:** screens/04-switcher-back-all.png
- **Console:** none
- **Network:** none
- **Load:** instant
- **State:** ok

## Step 5 — Outlet list — `/cockpit/outlets`
- **Action:** Navigate to `/cockpit/outlets`.
- **Expected:** Rows for existing outlets + "New outlet" CTA.
- **Observed (CORRECTED post-capture):** The screenshot `05-outlet-list.png` actually captured the **cockpit LOADING state** — a bare centred "Loading…" string on the amber canvas with the header switcher visible, no spinner/skeleton (the 1.2s settle was caught mid-load). The populated list IS real and renders shortly after — see `screens/15-list-after-blank-create.png` and `screens/18-list-after-clone-create.png`, which show the same `/cockpit/outlets` route fully populated (PKW/GI/KG, all **Active**, with code + address rows, gold "New outlet" CTA). A re-captured settled list (`05b-outlet-list-settled.png`) was attempted but the dev env went down before it ran. NOTE 1: the bare "Loading…" is an **undesigned loading state** (no spinner/skeleton; English only). NOTE 2: the SpokeLayout header on the populated list (Steps 15/18) carries a **printer icon + "Lucas ● live" connection chip** — booth chrome in the owner plane.
- **Screenshot:** screens/05-outlet-list.png (loading state); populated list at screens/15-list-after-blank-create.png + screens/18-list-after-clone-create.png
- **Console:** none
- **Network:** none
- **Load:** "Loading…" still showing at ~1.2s; resolves shortly after
- **State:** ok (functional; loading-state polish flagged)

## Step 6 — New-outlet wizard: Step 1/8 Setup mode (BLANK) — `/cockpit/outlets/new`
- **Action:** Navigate to wizard; confirm "Blank outlet" mode (default).
- **Expected:** Two mode cards (Blank / Clone); Blank selectable; progress bar at step 1 of 8.
- **Observed:** Header "New outlet", progress "1 / 8 Setup mode". Cards: **"Blank outlet — Start from scratch with a clean slate."** and **"Clone an outlet — Copy catalog and settings from an existing outlet."** Blank is selectable/highlighted. Next button enabled.
- **Screenshot:** screens/06-wizard-step0-mode.png
- **Console:** none
- **Network:** none
- **Load:** snappy
- **State:** ok

## Step 7 — Wizard Step 2/8 Name & code: DUPLICATE code → inline error
- **Action:** Enter name "Frollie — Grand Indonesia", code "PKW" (duplicate of the seeded default outlet's code).
- **Expected:** Inline `FieldMessage` error (NOT a toast); Next disabled.
- **Observed:** Inline red FieldMessage with icon: **"That code is already taken."** rendered directly under the Code field (confirmed inline component, not a Sonner toast). `Next` button **isDisabled() = true** — gate held. Code field auto-uppercases; hint text "Short uppercase identifier. Used in reports and Telegram." NOTE: despite being disabled, the Next button still renders in solid gold (visually identical to an enabled primary button) — the disabled affordance is not visually distinct.
- **Screenshot:** screens/07-wizard-step1-dup-code.png
- **Console:** none
- **Network:** none
- **Load:** instant (client-side uniqueness check)
- **State:** ok (validation works; affordance note for personas)

## Step 8 — Wizard Step 2/8: fix to unique code
- **Action:** Change code to "GI".
- **Expected:** Error clears; Next enabled.
- **Observed:** FieldMessage cleared; `Next` `isDisabled() = false`. Proceeded.
- **Screenshot:** screens/08-wizard-step1-fixed-code.png
- **Console:** none
- **Network:** none
- **Load:** instant
- **State:** ok

## Step 9 — Wizard Step 3/8 Address
- **Action:** Enter "Grand Indonesia Mall, West Mall L3, Jakarta Pusat".
- **Expected:** Optional address field with hint.
- **Observed:** Single address input + hint text; accepts value; Next proceeds.
- **Screenshot:** screens/09-wizard-step2-address.png
- **Console:** none
- **Network:** none
- **Load:** instant
- **State:** ok

## Step 10 — Wizard Step 4/8 Timezone
- **Action:** Advance to timezone step; screenshot.
- **Expected:** Timezone field defaulting to Asia/Jakarta.
- **Observed (CORRECTED post-capture):** The screenshot `10-wizard-step3-timezone.png` shows the "4 / 8 Timezone" header but a **blank body** — no visible field. This is **almost certainly the same `AnimatePresence mode="wait"` mid-transition capture artifact that hit Step 14** (review captured blank, then re-captured fine after a full settle): Steps 10 and 14 are the only steps screenshotted with no post-transition interaction (a too-short 300ms wait), while every step with an intervening `fill()` settled fine. The `StepTimezone` component renders the field unconditionally (a free-text Input defaulting to "Asia/Jakarta"), and the Review steps (14, 17) both show **Timezone = Asia/Jakarta**, confirming the field holds a value. A live re-verification was attempted but the dev env went down before it ran — so the artifact is flagged "re-verify" rather than confirmed-rendering. NOTE: timezone is a **free-text input** (no validated IANA picker) — a typo would be accepted client-side.
- **Screenshot:** screens/10-wizard-step3-timezone.png (blank — likely capture-timing artifact, see above)
- **Console:** none
- **Network:** none
- **Load:** spring step transition (~mid-animation at capture)
- **State:** ok (field exists per code + Review value; blank capture is a timing artifact pending re-verify)

## Step 11 — Wizard Step 5/8 Bank / Receipt settings
- **Action:** Toggle "Manual BCA" on; fill receipt business name + bank name/account name/account number.
- **Expected:** Receipt fields; manual-BCA section reveals bank fields when toggled.
- **Observed:** Receipt business name / address / contact inputs. Manual-BCA switch reveals Bank name, Account name, Account number (numeric inputmode) fields. All accept input.
- **Screenshot:** screens/11-wizard-step4-settings.png
- **Console:** none
- **Network:** none
- **Load:** instant
- **State:** ok

## Step 12 — Wizard Step 6/8 Staff access
- **Action:** Select first staff (Bayu).
- **Expected:** Selectable staff list; assign one of Bayu/Citra/Dewi/Eka.
- **Observed:** "Select staff who can access this outlet." Rows: Bayu S-0001 (Staff), Citra S-0002 (Staff), Dewi S-0003 (Staff), Eka S-0004 (Staff), **Lucas S-0005 (Owner)**. Bayu toggled on (gold check). NOTE: the owner (Lucas, role Owner) appears in the per-outlet staff-access assignable list — worth a domain judgement on whether owners belong in an outlet's staff-access roster.
- **Screenshot:** screens/12-wizard-step5-staff.png
- **Console:** none
- **Network:** none
- **Load:** snappy (staff query)
- **State:** ok

## Step 13 — Wizard Step 7/8 Telegram
- **Action:** Toggle "provision managers chat" on.
- **Expected:** Telegram toggle + explanatory hint.
- **Observed:** Single toggle row; enabling reveals a muted hint card explaining provisioning.
- **Screenshot:** screens/13-wizard-step6-telegram.png
- **Console:** none
- **Network:** none
- **Load:** instant
- **State:** ok

## Step 14 — Wizard Step 8/8 Review (BLANK)
- **Action:** Advance to Review. (Re-captured with a full transition settle; the first capture caught the `AnimatePresence mode="wait"` mid-transition and was blank — a screenshot-timing artifact, not a render bug. This image is the same blank-mode wizard re-walked with code `RVW`, staff Bayu.)
- **Expected:** Summary of all entered values before Create.
- **Observed:** "8 / 8 Review" with rows: Mode = Blank outlet · Name · Code · Address · Timezone Asia/Jakarta · Receipt name · Staff = Bayu · Telegram = Skip for now. "Create outlet" primary button.
- **Screenshot:** screens/14-wizard-step7-review.png
- **Console:** none
- **Network:** none
- **Load:** review content settles ~1s after step transition (spring animation)
- **State:** ok

## Step 15 — Create BLANK outlet → list
- **Action:** Click "Create outlet" (Step-14 first walk, GI).
- **Expected:** Idempotent create; navigates to outlet list; new outlet present.
- **Observed:** Action succeeded, navigated to `/cockpit/outlets`. "Frollie — Grand Indonesia" (`GI`) now in list with address + Active badge.
- **Screenshot:** screens/15-list-after-blank-create.png
- **Console:** none
- **Network:** none
- **Load:** ~2s (action round-trip)
- **State:** ok

## Step 16 — New-outlet wizard: CLONE mode + source select
- **Action:** New wizard; select "Clone an outlet"; pick "Frollie — Pakuwon" (PKW) as source.
- **Expected:** Clone mode reveals source-outlet picker; explicit note that catalog/settings copy but stock does not.
- **Observed:** Clone card highlighted. "Source outlet" list shows both existing outlets (PKW + GI). Explicit note rendered: **"Catalog and settings will be copied. Stock is not cloned."** — the stock-not-cloned invariant is surfaced in the UI as copy text. PKW selected.
- **Screenshot:** screens/16-wizard-clone-mode.png
- **Console:** none
- **Network:** none
- **Load:** snappy
- **State:** ok

## Step 17 — Wizard Review (CLONE)
- **Action:** Name "Frollie — Kelapa Gading (clone)", code "KG", advance through to Review.
- **Expected:** Review reflects clone mode + source.
- **Observed:** "8 / 8 Review": Mode = Clone an outlet · Clone source = Frollie — Pakuwon (PKW) · Name = Frollie — Kelapa Gading (clone) · Code = KG · Timezone = Asia/Jakarta · **Receipt name = Frollie — Pakuwon** (best-effort prefill from the clone source) · Staff = — · Telegram = Skip for now.
- **Screenshot:** screens/17-wizard-clone-review.png
- **Console:** none
- **Network:** none
- **Load:** snappy
- **State:** ok

## Step 18 — Create CLONE outlet → list
- **Action:** Click "Create outlet".
- **Expected:** New cloned outlet appears in list.
- **Observed:** Navigated to list; three outlets now: Frollie — Pakuwon (PKW, Active), Frollie — Grand Indonesia (GI, Active, with address), Frollie — Kelapa Gading (clone) (KG, Active). NOTE: KG (clone) shows no address row — address is not part of the clone copy and none was entered. **Stock-not-cloned is NOT verifiable from cockpit UI** (the cockpit has no stock view); it is asserted only by the Step-16 note text + the backend clone contract (ADR/Spec) — flagged as not-UI-verifiable.
- **Screenshot:** screens/18-list-after-clone-create.png
- **Console:** none
- **Network:** none
- **Load:** ~2s
- **State:** ok

## Step 19 — Switcher with three outlets — `/cockpit`
- **Action:** Return to dashboard; open switcher.
- **Expected:** Switcher lists "All outlets" + the three outlets.
- **Observed:** Dropdown shows 4 menu items (All outlets + PKW + GI + KG), each with name + code.
- **Screenshot:** screens/19-switcher-three-outlets.png
- **Console:** none
- **Network:** none
- **Load:** instant
- **State:** ok

## Step 20 — Dashboard with three outlets — `/cockpit`
- **Action:** Close switcher; view dashboard.
- **Expected:** Consolidated headline summed over all 3; three per-outlet cards.
- **Observed:** Consolidated GROSS Rp 0 / 0 / Rp 0 (all outlets zero sales). Three per-outlet cards rendered (`dashboard cards = 3`). Client-side fan-out + sum behaves per spec (sum of zeros = zero; non-zero summation not exercisable with this seed).
- **Screenshot:** screens/20-dashboard-three-outlets.png
- **Console:** none
- **Network:** none
- **Load:** snappy
- **State:** ok

## Step 21 — Desktop spot-check: dashboard — `/cockpit` (1280×900)
- **Action:** Load dashboard at desktop width.
- **Expected:** Responsive layout, amber theme holds.
- **Observed:** Consolidated card full-width; per-outlet cards in a 3-column grid. Amber theme + tokens hold on desktop. Layout clean, no overflow.
- **Screenshot:** screens/21-desktop-dashboard.png
- **Console:** none
- **Network:** none
- **Load:** snappy
- **State:** ok

## Step 22 — Desktop spot-check: wizard duplicate-code — `/cockpit/outlets/new` (1280×900)
- **Action:** Blank mode → Step 2 → enter duplicate code "PKW".
- **Expected:** Same inline FieldMessage error at desktop width.
- **Observed:** Inline "That code is already taken." renders; Next gated. Form is full-width on desktop (no max-width container) — fields stretch across the viewport. NOTE: at 1280 the single-column wizard fields span the full width with no max-width constraint; readable but wide.
- **Screenshot:** screens/22-desktop-wizard-dup.png
- **Console:** none
- **Network:** none
- **Load:** snappy
- **State:** ok

---

## Orchestrator raw observations (handed to personas as-is; not pre-judged)
1. **Disabled "Next" looks enabled.** On the dup-code step the gated Next button keeps the solid-gold primary fill — no visual disabled treatment. (Steps 7, 22)
2. **Printer icon in cockpit chrome.** The SpokeLayout header on `/cockpit/outlets` and the wizard shows a thermal-printer icon, though the owner cockpit does not drive the printer. (Steps 5, 6–17)
3. **Owner listed in staff-access.** Lucas (role Owner) appears in the per-outlet staff-access assignable list. (Step 12)
4. **Free-text timezone.** No validated timezone picker; arbitrary strings accepted client-side. (Step 10)
5. **Clone prefills receipt name from source** ("Frollie — Pakuwon" on the KG clone review). Best-effort UI prefill; backend clone is authoritative. (Step 17)
6. **Stock-not-cloned only asserted via copy text**, not verifiable in cockpit UI. (Steps 16, 18)
7. **Brand casing inconsistency:** lowercase "frollie" wordmark vs "Frollie —" outlet names. (all steps)
8. **All-zero data:** seed has no sales, so money formatting beyond "Rp 0" and large-number/overflow behaviour was not exercised. (Steps 1, 20)
9. **No error / sustained-loading / empty-list states reached** (data resolved fast; list always ≥1 outlet; no create failures). (Step 6 coverage note)
10. **0 console errors, 0 network failures** across the entire pass, mobile + desktop.

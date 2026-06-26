# UAT-FINDINGS.md — two-level booth state (ADR-053)

**Run:** `two-level-booth-state-2026-06-26` · mobile viewport Pixel 7 · http://localhost:5173 · Convex dev `helpful-grasshopper-46`
**Evidence:** `flow-log.md` (Steps 1–19 core, reproduced 3×; Steps 29–39 supplemental tail), `screens/` (31 shots), `console-errors.log`, `network-failures.log`. Persona inputs: `findings-pos-user.md`, `findings-pos-expert.md`.

## Executive summary

**Readiness verdict: NOT SHIP-READY — one BLOCKER + two C10 (offline) BUGs must close before merge.**

The headline win of this rework is real and confirmed: **lock → re-login same staff → resume straight to the sale grid, with zero `BOOTH_NOT_OPEN`** (Step 12, reproduced across 3 full runs). The recurring "BOOTH_NOT_OPEN on a locked booth" incident did not reproduce on the lock/resume path, and the two stored levels behave correctly across SOP-open → sale → lock → resume → handover-out → handover-in → block → end-of-day-close → re-open-to-SOP. Stock math is correct across shifts (SOP count 100 − 2 sold = 98 at handover). Money is integer-rupiah `id-ID` throughout; the webhook-confirmed receipt shows an honest "Payment confirmed". Bilingual EN↔ID works with real Indonesian shift/lock copy and no raw i18n keys.

**However**, the manager-override path **re-introduces the exact failure class the ADR exists to kill**: after a successful override clears the block, the overriding manager's immediate re-login stalls on a dead PIN keypad (no dots, no error, no advance) — a new stranding, reproduced 3×. And the **offline payment surface fails the C10 contract** in two ways: the connection chip keeps showing green "live" while disconnected, and Charge stays enabled then silently no-ops — the canonical silent-offline failure. End-of-day correctly closes the booth (Step 39 confirms Level-1 clear → next login routes to SOP), though the sign-off summary screen did not visibly render before logout.

### Counts by severity (deduped)
| Severity | Count |
|---|---|
| BLOCKER | 1 |
| BUG | 3 |
| UX-HIGH | 4 |
| UX-NIT | 7 |
| **Total** | **15** |

Attribution: `BOTH` = raised independently by both personas · `POS` = booth-operator only · `POS-EXPERT` = domain-expert only.

---

## BLOCKER

### [BLOCKER] [BOTH] Manager override clears the block, but the overriding manager is then stranded on a dead PIN keypad
- **Where:** Step 19 / `/login` after override — [screens/21-lucas-proceeds-after-override.png](screens/21-lucas-proceeds-after-override.png) (setup: screens/20-after-override.png, screens/19-override-pin-sheet.png)
- **What:** Override succeeded (Step 18: holder force-ended, block cleared, roster returned — confirmed 3×). On immediate re-login the manager's PIN keypad shows four empty dots with no spinner, no error, no advance; the staffer never reaches `/shift/begin`. flow-log marks Step 19 `broken`; reproduced 3 consecutive runs. Suspected stale reactive `loginContext` stale-holder re-check racing the just-force-ended holder row.
- **Why it matters:** Direct **C9 / rule #23 / ADR-053** failure — "a returning staffer can resume without getting stranded." The whole rework exists to eliminate the `BOOTH_NOT_OPEN`-on-locked-booth stranding; it fixed lock→resume but re-introduced stranding on override→login, and the manager performing an override is exactly who is holding up a live queue. To a non-technical operator it is a dead booth with no feedback.
- **Suggested fix:** On override success, route the manager straight through (mint session / navigate to `/shift/begin`) instead of dropping to a cold keypad; OR have the login keypad re-read `loginContext` on submit and surface an inline `FieldMessage` instead of silently swallowing the entry. Add an e2e guard for override → same-manager-login.

---

## BUG

### [BUG] [BOTH] Offline: Charge stays enabled and silently no-ops — payment not blocked with clear UI
- **Where:** Step 35 / `/sale` → `/sale/charge` — [screens/38-offline-charge-blocked.png](screens/38-offline-charge-blocked.png)
- **What:** While offline, cart (subtotal Rp 45.000) and Charge stay fully enabled; tapping Charge does not navigate, show an offline banner, or disable the QRIS tab — it silently returns to `/sale`. Catalog/cart correctly remain usable offline.
- **Why it matters:** **C10 / rule #16 / ADR-025** is explicit — "payments/auth/refunds block offline with clear UI, never a silent failure." A Charge that looks live then does nothing invites a double-tap or handing goods over on an unconfirmed sale. (No fabricated paid state appeared, so A3 is not breached — but the block itself is missing.)
- **Suggested fix:** Offline, disable Charge + the QRIS/Bank-transfer tabs and render an inline offline notice; keep catalog/cart/Save-draft enabled. Gate the charge mutation behind an online check that surfaces a banner, not a no-op.

### [BUG] [BOTH] Offline: connection chip still shows green "live" while disconnected
- **Where:** Steps 34–35 / `/sale`, `/sale/charge` — [screens/38-offline-charge-blocked.png](screens/38-offline-charge-blocked.png), screens/37-offline-sale-grid.png
- **What:** Network forced offline (console: `WebSocket … ERR_INTERNET_DISCONNECTED` ×2), yet the header chip keeps rendering a green dot + "live" on both the grid and the charge attempt. (POS-user raised this as UX-HIGH; POS-expert as BUG — consolidated at the higher severity.)
- **Why it matters:** **C10 / ADR-025** requires offline state visible. A green "live" badge over a dead socket is an actively false status — the one component whose job is to not lie. The operator trusts a connection that cannot carry a payment.
- **Suggested fix:** Drive the chip from `navigator.onLine` + Convex connection state; flip to amber/grey "offline" when the socket is down. (Also reconsider "live" → "Online"/"Offline" — see jargon nit.)

### [BUG] [BOTH] Paid receipt Method "QRIS / BCA VA" — instrument and confirmation source not honestly distinguishable
- **Where:** Step 9 / `/sale/charge/:txnId/success` — [screens/09-paid-receipt.png](screens/09-paid-receipt.png)
- **What:** A QRIS sale confirmed by webhook, yet the receipt Method row reads the static literal "QRIS / BCA VA"; it never states the settled instrument nor whether confirmation came from webhook / manager-PIN override / staff self-confirm.
- **Why it matters:** **A3 / rule #5 / ADR-036** requires honest, distinguishable payment confirmation. The combined label tells the operator and any later reconciler nothing about how the money arrived or by what authority it was marked paid. (Tangential to the booth-state feature but captured in this pass; both personas flagged it.)
- **Suggested fix:** Render the actual instrument (`qris`/`bca_va` via `instrumentFromInvoice`) plus a confirmation-source badge; reserve the "/" label for the pre-payment method picker only.

---

## UX-HIGH

### [UX-HIGH] [BOTH] End-of-day sign-off summary (hours + stock diff) did not render before logout
- **Where:** Step 37 / `/shift/end` summary — [screens/40-eod-summary.png](screens/40-eod-summary.png)
- **What:** After the close steps, the expected sign-off summary (hours worked + stock diff, no financials, "Done" button) did not appear — the capture shows the login keypad instead. (POS-user UX-NIT / POS-expert UX-HIGH — consolidated higher.) Level-1 close itself succeeded (Step 39: next login → SOP).
- **Why it matters:** **C9** requires the end-of-day sign-off to be unambiguous; the staffer should see/acknowledge the shift stock delta before the session clears. May be capture timing, but reproducible in the pack — verify.
- **Suggested fix:** Ensure `endOfDay` lands on the sign-off summary with an explicit "Done" that performs the logout (hours + stock diff, no revenue), rather than logging out implicitly.

### [UX-HIGH] [POS] Lock dialog wording reads like ending a shift / handover, for a plain lock
- **Where:** Step 10 / Lock — [screens/10-lock-screen.png](screens/10-lock-screen.png)
- **What:** Header "Lock + hand off", title "End Lucas's shift?", body "The next person taps their name and PIN to sign in." But a plain lock leaves the booth open and the same person returns.
- **Why it matters:** Lock / Handover / End-of-day are three distinct outcomes; this screen blurs them with irreversible-sounding copy, making a quick "put the phone down" feel like closing the booth.
- **Suggested fix:** For a plain lock: "Lock screen? Unlock with your PIN." Reserve "End shift" wording for real handover / end-of-day.

### [UX-HIGH] [POS] Three "Dubai" tiles with no pack size — wrong-product risk
- **Where:** Steps 6–7 / sale grid — [screens/06-sale-grid.png](screens/06-sale-grid.png)
- **What:** Three tiles labelled "Dubai" (Rp 45.000 / 125.000 / 320.000), distinguished only by tiny codes D1 / D3 / D8; pack size (1pc/3pcs/8pcs) is never written out.
- **Why it matters:** Forces the operator to disambiguate by price or a memorised code under queue pressure — easy to tap the wrong pack and charge wrong.
- **Suggested fix:** Put the pack size in the tile name ("Dubai 1pc/3pcs/8pcs").

### [UX-HIGH] [POS] No running cart total / Charge visible while building the cart
- **Where:** Step 7 / cart with 2 items — [screens/07-cart-2x.png](screens/07-cart-2x.png)
- **What:** After adding items the only cue is a small "2" tile badge; no running subtotal or Charge in view on the grid. (A bottom cart bar with subtotal + Charge does exist once the cart section is reached — see screens/38 — but not while adding items.)
- **Why it matters:** The operator wants the total climbing to read to the customer and catch mistakes; a tiny badge does not show the money.
- **Suggested fix:** Persistent bottom cart bar with running total + "Charge Rp …" from the first item, visible without scrolling.

---

## UX-NIT

### [UX-NIT] [BOTH] Post-logout login surface in ID didn't render the translated roster (loading/English fallback)
- **Where:** Step 32 / `/login` in ID — [screens/36-login-id.png](screens/36-login-id.png)
- **What:** After switching to ID and locking, the login roster did not clearly render in Indonesian within the capture (English "Who's working?" / a bare "Memuat…" loading state). The locale *did* persist (loading text was Indonesian — D12 holds); no raw i18n keys.
- **Why it matters:** **D12 / C10** — every surface should have a designed loading→ready transition; a login lingering on "Memuat…" reads as a stall and feels like the language setting did not stick. Likely capture-timing (heavy ~30s logins on dev), but verify the post-logout roster resolves promptly.
- **Suggested fix:** Confirm the roster query resolves promptly post-logout; remember last-used locale on the login screen; add a timeout/retry to the loading state.

### [UX-NIT] [POS-EXPERT] No explicit booth-state ("Open" · holder) badge — state inferred from routing only
- **Where:** Step 5 / `/` home — [screens/05-home-after-open.png](screens/05-home-after-open.png)
- **What:** No `Open`/`closed`/`handover_pending` chip in the header; the two-level state is communicated purely by which route the user lands on.
- **Why it matters:** **C9** asks booth state be "obvious on screen." Routing-only works on the happy path but gives no at-a-glance confirmation in the lock/handover/override edge cases this release targets.
- **Suggested fix:** Add a small state chip to the booth header (Open · holder name).

### [UX-NIT] [POS] Jargon: "override", "SKUs", "live", "Manager unlock"
- **Where:** Steps 5 / 10 / 17 — screens/05, screens/10, [screens/17-login-block-holder.png](screens/17-login-block-holder.png)
- **What:** Software/inventory terms surface in operator-facing copy.
- **Why it matters:** The target operator works from WhatsApp/Tokopedia, not dashboards; these read as developer language.
- **Suggested fix:** "Ask a manager to unlock", "5 product types", "Online/Offline".

### [UX-NIT] [POS] Block screen leads with the tapped name ("Lucas") while the message names the holder ("Bayu")
- **Where:** Step 17 / login block — [screens/17-login-block-holder.png](screens/17-login-block-holder.png)
- **What:** Big "Lucas" heading (tapped staffer) with "Bayu is still on shift…" below — two names on one small screen.
- **Why it matters:** The load-bearing fact (Bayu holds the booth) should be the prominent one.
- **Suggested fix:** Lead with the holder; de-emphasise the tapped name.

### [UX-NIT] [POS] Override sheet shows empty PIN dots before a manager is picked
- **Where:** Step 18 / "Pick a manager" — [screens/18-override-pick-manager.png](screens/18-override-pick-manager.png)
- **What:** Four empty PIN circles render on the manager-picker step, before any PIN entry is relevant.
- **Why it matters:** Suggests a missed step / something to type.
- **Suggested fix:** Show the PIN dots only on the PIN-entry step.

### [UX-NIT] [POS] Sale grid flashes a dim, half-loaded state
- **Where:** Step 6 / sale grid — [screens/06-sale-grid.png](screens/06-sale-grid.png)
- **What:** Tiles render very dark/faint before filling in (fully rendered by screens/07).
- **Why it matters:** Momentarily looks broken/empty on a screen opened hundreds of times a day.
- **Suggested fix:** Skeleton placeholder or fade tiles in together.

### [UX-NIT] [POS-EXPERT] Dialog primitives missing `aria-describedby` (accessibility)
- **Where:** Throughout — `console-errors.log` ("Missing `Description`/`aria-describedby` for {DialogContent}" ×2); PIN/lock sheets screens/19, screens/35
- **What:** Radix `DialogContent` (PIN/lock dialogs) render without a description association, emitting a11y warnings.
- **Why it matters:** Loosely **D11** (well-formed surfaces). Low impact on a single-operator booth, trivially silenced.
- **Suggested fix:** Provide a `DialogDescription` / `aria-describedby` on each PIN/lock dialog.

---

## Scope coverage & caveats
- **Covered & passing:** SOP start-of-day open (Steps 1–5), QRIS sale + webhook-confirmed receipt (6–9), lock without closing booth (10–11), **resume after lock with no BOOTH_NOT_OPEN** (12), handover-out → handover-in → startShift (13–16), block naming the holder + override clearing the block (17–18), bilingual EN↔ID (29–32), offline catalog/cart usable (34), end-of-day close → next login routes to SOP (36–39).
- **Not exercised (neither pass nor fail):** refunds / snapshot-line history (A2), Telegram off-booth approval & owner-cockpit plane (B6/B7) — out of this run's scope.
- **Navigation honesty:** the core feature (Steps 1–19) was driven once and reproduced 3×; because the Step-19 override-stall truncated the tail, bilingual/offline/end-of-day were captured in two short fresh-seed continuations (Steps 29–39). No flow was judged twice. The `reset` seed does not set `must_change_pin`, so no forced PIN rotation appeared (expected, not a defect).

---

## Controller disposition (2026-06-26)

- **[BLOCKER] override → re-login dead keypad — FIXED + re-verified live (commit `cb85c3a`).** Root cause: Radix Dialog (PinSheet) left `body{pointer-events:none}` stuck when it closed amid the override's reactive stage-change burst, deadening the keypad behind it. Fix restores body pointer-events on PinSheet close (helps all ~12 PinSheet surfaces) + adds DialogDescription a11y. Focused live re-test confirmed: `body` pointer-events read `auto` after override, dots fill, Lucas reaches `/shift/begin`, 0 console errors.
- **[UX-NIT] block screen heading showed the tapped staffer's name while the message named the holder — FIXED (neutral "Shift in progress" title, en+id).**
- **[BUG] offline payment not blocked / [BUG] connection chip shows "live" offline (C10):** PRE-EXISTING — the two-level branch does not touch the payment/offline-gating or `ConnDot` surfaces (confirmed: not in the b96535b..HEAD diff). DEFERRED to backlog (separate C10 offline-hardening work).
- **[BUG] receipt Method "QRIS / BCA VA":** PRE-EXISTING — receipt template / `confirmed_via→label` (known deferred rule-of-three, not in this diff). DEFERRED to backlog.
- **[UX-HIGH] end-of-day sign-off summary "didn't render":** NOT A BUG — `shift/end.tsx` renders the summary (hours+stock+Done) and gates the logout behind the Done tap (`mode==="close" && signOffDurationMs!==null`); the capture was timing. No change.
- **[UX-HIGH] booth-state not obvious on screen (C9) / [UX-HIGH] language-toggle "Memuat…" lingering / remaining [UX-NIT] jargon ("override"/"SKUs"/"live"/"Manager unlock") + override-sheet empty-dots-before-manager-pick:** DEFERRED to backlog — product-copy decisions (owner's call) + shared-component/design polish beyond the two-level scope.

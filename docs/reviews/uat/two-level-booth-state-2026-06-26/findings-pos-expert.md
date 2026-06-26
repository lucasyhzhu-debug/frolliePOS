# findings-pos-expert.md — senior POS / retail-systems practitioner

> Evaluated from the pre-captured evidence pack only (no browser). Produced by the `uat-pos-expert`
> persona evaluator (isolated session); persisted by the orchestrator. Rubric: CLAUDE.md business
> rules + cited ADRs, organised as the 4 themes / 12 invariants.

**Coverage note:** the run exercised Theme A (A1/A3), Theme B (B5/B8 via override), Theme C (C9/C10 heavily), Theme D (D11/D12). **A2 (refund-as-entity / snapshot lines) and B6/B7 (Telegram off-booth, cockpit plane) were not exercised** — no refund, history-detail, or cockpit surface was captured — so they are neither passed nor failed here.

**Positives (not findings):** money is integer rupiah, `id-ID`-grouped everywhere (`Rp 90.000`, `Rp 45.000`) — A1 holds (Steps 7–9). Webhook-confirmed receipt shows an honest "Payment confirmed" (Step 9). Two-level resume worked: lock → re-login same staff → sale grid, zero `BOOTH_NOT_OPEN` (C9, Step 12). Block names the holder and offers a one-off PIN override, not a sticky manager mode (B5/ADR-005, Steps 17–18). Locale flips EN↔ID including shift copy, no raw i18n keys (D12, Steps 30–31).

**Counts — BLOCKER: 1, BUG: 3, UX-HIGH: 1, UX-NIT: 3.**

### [BLOCKER] Manager-override clears the block but the overriding manager is then stranded on a dead PIN keypad
- **Where:** Step 19 / `/login` after override (screens/21-lucas-proceeds-after-override.png; setup at screens/20-after-override.png, screens/19-override-pin-sheet.png)
- **What:** After the manager-PIN override force-ended the stranded holder (Step 18 — roster returned, block cleared, confirmed 3×), the overriding manager's immediate re-login left the PIN keypad showing four empty dots with no error, no "Verifying…" spinner, no advance. The staffer never reached `/shift/begin`. flow-log marks Step 19 broken; reproduced 3 consecutive runs. Suspected stale reactive `loginContext` re-check racing the just-force-ended holder row.
- **Why it matters (POS-expert lens):** Direct **C9** failure (rule #23 / ADR-053): "a returning staffer can resume … without getting stranded." The entire two-level rework exists to eliminate stranding (the recurring `BOOTH_NOT_OPEN`-on-locked-booth P0). It fixed lock→resume but introduced new stranding on the override→login path — the very bug class the ADR targets. The manager who just performed an override is the person most likely holding up a live queue.
- **Suggested fix:** On override success, route the manager straight through (mint session / navigate to `/shift/begin`) instead of dropping to a cold keypad; or have the login keypad re-read `loginContext` on submit and surface an inline `FieldMessage` ("Booth changed — tap your name again") instead of silently swallowing the entry. Add an e2e guard for override→same-manager-login.

### [BUG] Offline: connection chip still shows green "live" while the device is disconnected
- **Where:** Steps 34–35 / `/sale`, `/sale/charge` (screens/37-offline-sale-grid.png, screens/38-offline-charge-blocked.png)
- **What:** Network forced offline (console: `WebSocket … ERR_INTERNET_DISCONNECTED` ×2). The header chip kept rendering a green dot + "live" on both the sale grid and the charge attempt. flow-log: "'offline' indicator visible: false."
- **Why it matters (POS-expert lens):** **C10** (rule #16 / ADR-025) requires offline state visible — "never a silent failure." A green "live" badge over a dead WebSocket is an actively false status; the operator trusts a connection that can't carry a payment. The connection indicator is the one component whose job is to not lie here.
- **Suggested fix:** Drive the chip from `navigator.onLine` + Convex connection state; flip to amber/grey "offline" when the socket is down.

### [BUG] Offline: Charge stays enabled and silently no-ops — payment not blocked with clear UI
- **Where:** Step 35 / `/sale` → `/sale/charge` (screens/38-offline-charge-blocked.png)
- **What:** While offline, cart (subtotal Rp 45.000) and Charge stayed fully enabled. Tapping Charge did not navigate, show an offline banner, or disable the QRIS tab — it silently returned to `/sale`. flow-log: "Offline-block UI visible: false. QRIS tab disabled: false."
- **Why it matters (POS-expert lens):** **C10** is explicit: "payments/auth/refunds block offline with clear UI, never a silent failure" (rule #16 / ADR-025). A payment action that looks live then quietly does nothing is the canonical silent-offline failure — at the counter it reads as "I pressed pay and nothing happened," inviting a double-tap or handing goods over on an unconfirmed sale. (Credit: no fabricated paid state appeared, so A3 isn't breached on this path — but the block itself is missing.)
- **Suggested fix:** When offline, disable Charge and the QRIS/Bank-transfer tabs and render an inline offline notice; keep catalog/cart/Save-draft enabled per ADR-025. Gate the charge mutation behind an online check that surfaces a banner, not a no-op.

### [BUG] Paid receipt shows Method "QRIS / BCA VA" — instrument and confirmation source not honestly distinguishable
- **Where:** Step 9 / `/sale/charge/:txnId/success` (screens/09-paid-receipt.png)
- **What:** A QRIS sale confirmed by webhook, yet the receipt's Method row reads the static literal "QRIS / BCA VA" — it never states which instrument actually settled, nor whether confirmation came from the webhook, a manager-PIN override, or staff self-confirm.
- **Why it matters (POS-expert lens):** **A3** (rule #5 / ADR-036) requires payment confirmation to be honest and the path "webhook-confirmed QRIS vs manager-PIN manual override vs manual-BCA staff self-confirm" distinguishable on screen. A combined "QRIS / BCA VA" label tells the operator and any later reconciler nothing about how the money arrived or by what authority it was marked paid.
- **Suggested fix:** Render the actual instrument resolved for the txn (`qris`/`bca_va` via `instrumentFromInvoice`) plus a confirmation-source badge ("Confirmed automatically" / "Manager override" / "Staff-confirmed transfer"). Reserve the "/" label for the pre-payment method picker only.

### [UX-HIGH] End-of-day sign-off summary (hours + stock diff) did not render before logout
- **Where:** Step 37 / `/shift/end (summary)` (screens/40-eod-summary.png)
- **What:** After walking the close steps, the expected sign-off summary (hours worked + stock diff, no financials, "Done" button) did not appear — the capture shows the Lucas login keypad instead. flow-log: "Hours label visible: false. 'Done' button: false." (Level-1 close itself succeeded — Step 39 routes the next login back to `/shift/start` SOP.)
- **Why it matters (POS-expert lens):** **C9** requires the "end-of-day sign-off … unambiguous." The close is an accountability moment; the staffer should see and acknowledge their shift's stock delta before the session clears. (May be capture timing, but it is reproducible in the pack and warrants verification.)
- **Suggested fix:** Ensure `endOfDay` lands on the sign-off summary with an explicit "Done" that performs the logout, rather than logging out implicitly; confirm it shows hours + stock diff and no revenue.

### [UX-NIT] No explicit booth-state ("Open") indicator — state inferred from routing only
- **Where:** Step 5 / `/` home (screens/05-home-after-open.png); header throughout
- **What:** Once open, the only header cues are a lock icon, "Frollie · Lucas", a build/SKU line, and the connection chip. There is no explicit `Open`/`closed`/`handover_pending` badge; the two-level state is communicated purely by which route the user lands on.
- **Why it matters (POS-expert lens):** **C9** asks booth state be "obvious on screen." Routing-only state works on the happy path but gives no at-a-glance confirmation of which level the booth is in — relevant in the handover/lock/override edge cases this release targets.
- **Suggested fix:** Add a small state chip to the booth header (Open · holder name).

### [UX-NIT] After ID-locale logout the login surface stuck on "Memuat…", roster never rendered in capture
- **Where:** Step 32 / `/login` (screens/36-login-id.png)
- **What:** Logging out with ID locale set, the login screen showed only "Memuat…"; the Indonesian roster ("Siapa yang bertugas?") did not render within the capture. flow-log: "ID login surface … : false." Positive: the locale did persist across logout (the loading text is Indonesian) — D12 persistence holds.
- **Why it matters (POS-expert lens):** **D12 / C10** want every surface to have a designed loading→ready transition; a login lingering on a bare "Memuat…" can read as a stall. Likely a capture-timing artifact given heavy load times elsewhere (Step 15 = 35s), but worth confirming the post-logout roster reliably resolves.
- **Suggested fix:** Verify the roster query resolves promptly post-logout in ID; add a timeout/retry affordance to the login loading state if it can hang.

### [UX-NIT] Dialog primitives missing `aria-describedby` (accessibility)
- **Where:** Throughout (console-errors.log: "Missing `Description` or `aria-describedby={undefined}` for {DialogContent}" ×2) — e.g. PIN/lock sheets (screens/19-override-pin-sheet.png, screens/35-lock-id.png)
- **What:** Radix `DialogContent` instances (PIN sheets / lock dialogs) render without a description association, emitting a11y warnings.
- **Why it matters (POS-expert lens):** Loosely **D11** (design-system conformance / well-formed surfaces). Low impact on a single-operator booth but trivially silenced; keeps the surface clean and screen-reader-correct.
- **Suggested fix:** Pass a `DialogDescription` (or `aria-describedby`) on each PIN/lock dialog, or set `aria-describedby={undefined}` intentionally where no description applies.

## Verdict
The core incident this rework targets (lock→relogin→resume, no `BOOTH_NOT_OPEN`) is fixed and solid, but the override→login path re-introduces stranding (BLOCKER) and the offline payment surface fails the C10 "never a silent failure" contract (two BUGs). Not ship-ready until those are closed.

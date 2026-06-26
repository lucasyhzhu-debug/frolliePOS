# findings-pos-user.md — "Bu Sri", non-technical booth operator

> Evaluated from the pre-captured evidence pack only (no browser). Produced by the `uat-pos-user`
> persona evaluator (isolated session); persisted by the orchestrator.

**Counts — BLOCKER: 1, BUG: 2, UX-HIGH: 4, UX-NIT: 6.**

### [BLOCKER] After a manager override, the manager can't log back in — stuck on an empty keypad
- **Where:** Step 19 / Manager override → re-login (screens/21-lucas-proceeds-after-override.png; screens/20-after-override.png)
- **What:** The override worked — the block cleared and the roster came back (Step 18). But when Lucas immediately taps his name and types his PIN, nothing happens: the four PIN dots stay empty, no spinner, no error. He never gets in. Reproduced on all 3 repeats; flow-log marks state broken.
- **Why it matters (POS-user lens):** This is the exact nightmare this update was supposed to kill — a staffer stranded on the booth phone with no way forward. The manager who just rescued the booth now can't even open it. That's a dead booth.
- **Suggested fix:** After an override clears the holder, take the manager straight through (or auto-stage their PIN). Every tap must fill a dot, and a clear message must show if it can't proceed.

### [BUG] The paid receipt says "QRIS / BCA VA" even though the customer paid by QRIS
- **Where:** Step 9 / paid receipt (screens/09-paid-receipt.png)
- **What:** Receipt shows Total Rp 90.000 (correct) but Method: QRIS / BCA VA — both methods slashed together, as if it doesn't know which one happened.
- **Why it matters (POS-user lens):** When a customer asks "how did I pay?", I read this aloud. "QRIS / BCA VA" makes me look unsure and doubt the right payment landed. The money number is trustworthy; the method line is not.
- **Suggested fix:** Show the single confirmed method ("QRIS", or "Bank transfer (BCA)"). Drop the "X / Y" label on a confirmed sale.

### [BUG] Going offline does not block payment — the Charge just silently does nothing
- **Where:** Step 35 / offline charge (flow-log Step 35; screens/38-offline-charge-blocked.png)
- **What:** With internet dropped the Charge/QRIS path was not blocked: no offline banner, QRIS tab not disabled, screen quietly went back to /sale and did nothing. Cart/catalog still worked offline (good), but taking payment failed with zero explanation.
- **Why it matters (POS-user lens):** Mall Wi-Fi drops constantly. If I tap Charge and nothing happens, I'll tap again or tell the customer "it's done" when no payment was taken. A silent payment failure is the scariest kind, because it's money.
- **Suggested fix:** Offline, block the payment screen with a clear message and visibly disable Charge/QRIS. Never let Charge look tappable and then do nothing.

### [UX-HIGH] The connection badge still says "live" (green) while the phone is offline
- **Where:** Step 34 / offline sale grid (flow-log Step 34; green chip on screens/06, screens/38)
- **What:** After going offline the catalog/cart still worked, but the corner dot still showed green "live" and no "offline" indicator appeared.
- **Why it matters (POS-user lens):** That green dot is the one thing I'd glance at to know "are we connected?" If it stays green while offline, it's lying to me — I'll try a payment that can't go through. "live" itself is unclear.
- **Suggested fix:** Flip the badge to "Offline" (red/grey) the moment the connection drops; reconsider "live" → "Online"/"Offline".

### [UX-HIGH] The Lock dialog sounds like I'm ending my shift / handing over, when I'm only locking
- **Where:** Step 10 / Lock (screens/10-lock-screen.png)
- **What:** Header "Lock + hand off", title "End Lucas's shift?", body "The next person taps their name and PIN to sign in." But this is a plain Lock — booth stays open and the same person comes back.
- **Why it matters (POS-user lens):** Lock, Handover, End-of-day are three different things and this screen blurs them. "End Lucas's shift?" makes me hesitate. It says "the next person" but actually I'm coming back.
- **Suggested fix:** For a plain lock: "Lock screen? You can unlock with your PIN." Keep "End shift" wording for real handover/end-of-day.

### [UX-HIGH] Three products all just say "Dubai" with no pack size — easy to sell the wrong one
- **Where:** Step 6–7 / sale grid (screens/06-sale-grid.png, screens/07-cart-2x.png)
- **What:** Three tiles labeled "Dubai" at Rp 45.000 / Rp 125.000 / Rp 320.000, distinguished only by tiny codes D1 / D3 / D8. Pack size (1pc / 3pcs / 8pcs) is never written out.
- **Why it matters (POS-user lens):** When a customer says "one box of 3," three identical "Dubai" labels force me to go by price or a memorized code. In a rush I'll tap the wrong one and charge wrong.
- **Suggested fix:** Put pack size in the tile name: "Dubai 1pc", "Dubai 3pcs", "Dubai 8pcs".

### [UX-HIGH] While building the cart I can't see a running total or a Charge button
- **Where:** Step 7 / cart with 2 items (screens/07-cart-2x.png)
- **What:** After adding Dubai ×2, the only sign anything happened is a small "2" badge on the tile. No running subtotal / Charge in view on the grid. (A bottom cart bar with subtotal + Charge IS present once the cart section is reached — see screens/38 — but not visible while adding items.)
- **Why it matters (POS-user lens):** As I add items I want to see the total climbing to read it to the customer and catch mistakes. A tiny badge doesn't tell me the money.
- **Suggested fix:** Persistent bottom cart bar with running total and "Charge Rp …" button from the first item, visible without scrolling.

### [UX-NIT] Indonesian doesn't clearly carry to the login screen after I switch language
- **Where:** Step 32 / login in Indonesian (flow-log Step 32, "warn"; screens/36-login-id.png)
- **What:** After switching to ID and locking, the login/roster did not clearly render the Indonesian roster in the capture (English / loading state). No broken text keys (good).
- **Why it matters (POS-user lens):** I picked Indonesian on purpose; an English-looking next screen feels like the setting didn't stick.
- **Suggested fix:** Remember the last-used language on the login screen, or make the pre-login English default clearer.

### [UX-NIT] "override", "SKUs", "live", "Manager unlock" — small bits of jargon
- **Where:** Step 17 block (screens/17), home header (screens/05), lock dialog (screens/10)
- **What:** Words that read like software/inventory jargon: "Manager override"/"override", "5 SKUs", "live", "Manager unlock".
- **Why it matters (POS-user lens):** I run the booth from WhatsApp and Tokopedia. "SKUs" and "override" aren't words I use; they make the app feel like it's talking to a developer.
- **Suggested fix:** Plainer phrasing: "Ask a manager to unlock", "5 product types", "Online/Offline".

### [UX-NIT] Block screen shows a big "Lucas" at the top but the message is about "Bayu"
- **Where:** Step 17 / login block (screens/17-login-block-holder.png)
- **What:** I tapped Lucas, so his name is the big heading. But the message below reads "Bayu is still on shift…". Two different names on one small screen.
- **Why it matters (POS-user lens):** For a second I'm not sure who's actually working. The key fact (Bayu holds the booth) should stand out.
- **Suggested fix:** Lead with the holder: make "Bayu is still on shift" the prominent line.

### [UX-NIT] The override pop-up shows four empty PIN dots before I've chosen the manager
- **Where:** Step 18 / "Pick a manager" stage (screens/18-override-pick-manager.png)
- **What:** On the "Pick a manager" step, four empty PIN circles already show, before any PIN entry.
- **Why it matters (POS-user lens):** Seeing PIN dots while still picking a name made me think I'd missed a step.
- **Suggested fix:** Only show the PIN dots on the PIN entry step.

### [UX-NIT] The sale grid flashes a dim, half-loaded state
- **Where:** Step 6 / sale grid (screens/06-sale-grid.png)
- **What:** The first capture shows tiles very dark/faint before they fill in (screens/07 shows them fully rendered).
- **Why it matters (POS-user lens):** For the half-second it's dim, the screen looks broken/empty.
- **Suggested fix:** Use a quick skeleton/placeholder, or fade tiles in together.

### [UX-NIT] Couldn't confirm the end-of-day sign-off showed hours worked or a clear "Done"
- **Where:** Step 37 / end-of-day summary (flow-log Step 37, "warn"; screens/40-eod-summary.png)
- **What:** Flow-log expected a sign-off with hours + stock diff and a "Done" button but recorded both not visible.
- **Why it matters (POS-user lens):** End-of-day is when I want a clear "you're done, booth is closed" before I walk away. (Step 39 routing back to Start-of-day suggests it did close.)
- **Suggested fix:** Verify the end-of-day summary renders a plain confirmation and one obvious Done button.

## What worked well (for balance)
- Resume after lock (Step 12): logged back in, landed straight on the sale grid — no "booth not open" dead-end.
- Lock pre-stages my name (Step 11): fast re-entry.
- Block names the holder (Step 17): told me Bayu was on shift.
- Money on payment + receipt (Steps 8–9): clear "AMOUNT DUE Rp 90.000", countdown, "Payment confirmed" + receipt R-PKW-2026-0001 (aside from the method line).
- Indonesian on home/shift (Steps 30–31): "Penjualan baru", "Tutup booth", "Serah terima", "Akhiri shift" — no broken text.

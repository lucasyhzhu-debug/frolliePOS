# DECISIONS.md

Running log of product and flow decisions. Architectural decisions live in `docs/ADR/`. This file is for the choices an engineer wouldn't infer from the schema or code.

Newest at top.

---

## 2026-05-21: Static BCA display rejected, BCA VA via Xendit only

**Decision:** All non-QRIS payments go through Xendit BCA Virtual Account. Static BCA account display ("transfer here, then tap paid") is not supported.

**Reason:** Static BCA requires staff to verify payment manually by watching the BCA mobile app. Reconciliation, audit, and fraud surface all bad. Marginal MDR (around IDR 4,000 per BCA VA transaction) is acceptable.

**Implication:** All payment confirmations flow through one mechanism (Xendit webhook + polling + manual override).

---

## 2026-05-21: WhatsApp receipts are optional, click-to-send via wa.me

**Decision:** Receipt delivery is opt-in. Customer phone is optional at checkout. When provided, staff sees a "Send via WhatsApp" button after payment confirmation. Tapping opens WhatsApp with a pre-filled message containing the receipt URL. Staff taps send.

**Reason:** WhatsApp Cloud API verification takes 1-3 weeks. wa.me click-to-send works day one. The receipt itself is a public Vercel-hosted page with a signed URL.

**Implication:** Receipt URL must be signed (HMAC) to prevent guessing. Receipt page renders from Convex transaction data on load. No PII in the URL.

**Upgrade path:** v1.1 swaps to WhatsApp Cloud API for fully automated sends.

---

## 2026-05-21: Cash deferred to future phase

**Decision:** No cash handling in v1, v1.1, or v1.2. POS is digital-only (QRIS + BCA VA).

**Reason:** No cash register, no till. Risk of cash mishandling without the right controls (shift open/close, variance reporting, manager count) is higher than the convenience.

**Implication:**
- No `cash_payment` enum value on `pos_payments.method`.
- No shift open/close flow in v1.
- "Lock device" replaces shift handoff. Each staff sees their own session totals at logout.
- Schema is forward-compatible: when cash is added, a new payment method enum value plus shift tables (`pos_shifts`, `pos_cash_movements`) get added without breaking existing data.

---

## 2026-05-21: PPN schema present, value zero until PKP

**Decision:** All `pos_transaction_items` have `tax_rate` and `tax_amount` fields from day one. Default tax_rate is 0 since Frollie is below the PKP threshold.

**Reason:** Adding tax columns later means a migration on every historical row. Zero today, 0.11 when registered, no schema change.

**Implication:** Receipt template shows tax line only when `tax_amount > 0`. Reporting queries already group by tax for future audits.

---

## 2026-05-21: Refund modeling — separate entity, never status mutation

**Decision:** A paid transaction never changes its `status` to `refunded` without a corresponding `pos_refunds` row. The transaction status flips, but the refund is the source of truth for the operation.

**Reason:** Audit integrity. Accounting must reconcile gross sales separately from refunds. Tax authorities (when PKP) require refunds traceable to original sales with reason codes.

**Implication:** Dashboard's "net sales" query = sum(paid transactions) - sum(succeeded refunds). Never derive from transaction status alone.

---

## 2026-05-21: Audit log is cloud-stored, append-only, never device-only

**Decision:** Every state-changing action writes a row to `audit_log` in Convex. No local-only logs. No periodic batch sync from device-side storage.

**Reason:** Device loss or wipe must not erase audit trail. Staff must not be able to clear logs from the device.

**Implication:** When offline, audit-log-writing mutations queue along with the primary mutation. Both succeed or fail atomically on reconnect.

**Tradeoff:** Audit writes cost a Convex bandwidth unit per action. At expected volumes (hundreds of actions per day) this is negligible.

---

## 2026-05-21: Payment confirmation has three paths, all logged

**Decision:** Payment is confirmed via one of three sources:
1. **Webhook** from Xendit (primary)
2. **Polling** Xendit's `GET /v2/invoices/{id}` every 2s for up to 60s after payment initiation (fallback)
3. **Manual override** by manager PIN re-entry (last resort, requires reason)

Each confirmation logs `confirmed_via` on `pos_payments` and emits a distinct audit action.

**Reason:** Real-world Xendit webhooks have occasional delays. Customer and staff standing at the counter can't wait. Polling closes the gap. Manual override handles the long-tail edge case where the customer's bank shows success but the webhook never arrives.

**Implication:**
- Polling runs client-side in a `usePaymentConfirmation` hook.
- Manual override requires manager PIN and a free-text reason, all logged.
- Daily dashboard shows count of manual overrides as a quality metric.

---

## 2026-05-21: Stock-in is the only stock-add operation

**Decision:** Staff bring physical units from the kitchen to the booth. Tap "Stock In" in the POS, select product, enter quantity, confirm. Logged as a `pos_stock_movements` row with type `stock_in`.

**Reason:** Simple, single-stall model. No transfers, no kitchen inventory sync in v1. Frollie Pro doesn't need to push stock to the POS.

**Implication:** Stock variance is the difference between cumulative stock-in and cumulative sales. Reconcile manually if it drifts. Adjustment requires manager PIN.

---

## 2026-05-21: Discount authority — preset vs ad-hoc

**Decision:**
- **Preset discounts** (configured in dashboard by manager): staff applies freely at checkout.
- **Ad-hoc discounts** (staff types arbitrary percentage or amount): blocked in v1. Future v1.1 may add with manager PIN.
- **Voucher codes**: staff enters at checkout, applied if valid, redemption logged.

**Reason:** Staff discounting friends' purchases is the most common shrinkage vector in mall retail. Lock it down at the schema level.

**Implication:** v1 ships with `pos_discounts` table populated by manager only. Staff has no UI to create discounts. Voucher codes are the only "discount creation" path staff sees.

---

## 2026-05-21: Voucher codes are static, manager-managed

**Decision:** Manager creates voucher codes manually in the dashboard. No generator UI. Codes distributed out-of-band (social media, influencer DMs, mall flyers).

**Reason:** Volume is low. Generating bulk codes is over-engineering for one stall.

**Implication:** Manager creates 10-20 codes at launch. Future v1.x can add a code generator if volume grows.

---

## 2026-05-21: Device registration before login

**Decision:** New devices must be activated by a manager-issued one-time setup code before any staff can log in. Device gets a `registered_devices` row. Sessions are bound to `device_id`.

**Reason:** Prevents staff from logging in on personal phones with their PIN, which would leak transaction capability and audit trail outside controlled devices.

**Implication:**
- Manager dashboard has "Register New Device" flow.
- Setup code is 6 digits, single-use, 1-hour TTL.
- Lost device requires manager to deactivate via dashboard.

---

## 2026-05-21: Customer phone optional, not required

**Decision:** Customer phone field at checkout is optional. Skip available with one tap.

**Reason:** Mall foot traffic is fast. Forcing phone entry adds friction for customers who don't want a receipt. Mall stalls in Indonesia rarely capture customer details for sub-IDR 100k transactions.

**Implication:**
- WhatsApp receipt only sent when phone provided.
- Future loyalty program needs phone, so prompt strongly but never block.

---

## 2026-05-21: Receipt URL signing

**Decision:** Public receipt URLs are signed with HMAC. Format: `https://pos.frollie.com/r/{transaction_number}?sig={hmac}`.

**Reason:** Prevent transaction enumeration. Without signing, anyone could iterate transaction numbers to view receipts.

**Implication:**
- `RECEIPT_SIGNING_SECRET` env var in Convex.
- Receipt page validates signature before rendering. Invalid sig = 404.
- Receipt content is non-sensitive (no payment details beyond method), but enumeration is still a concern.

---

## 2026-05-21: Connection state always visible

**Decision:** Top-right corner of every page shows a connection indicator. Green dot = online, red dot = offline. Payment buttons disable when red.

**Reason:** Staff must never wonder why payment isn't working. Mall WiFi drops happen.

**Implication:** `useConvexStatus` hook subscribes to Convex's WebSocket state. UI reflects in <500ms of state change.

---

## 2026-05-21: Offline matrix

What works offline:
- Browse cached catalog
- Build cart
- Apply discounts from cached vouchers
- Save draft (queued, syncs on reconnect)
- Stock-in (queued)

What does not work offline:
- Login (requires Convex auth)
- Initiate payment (Xendit needs internet)
- Confirm payment (Xendit webhooks need internet)
- Refund (Xendit API needs internet)
- Receipt generation (signed URL needs Convex)
- WhatsApp send (wa.me link works but receipt URL inside it needs server)

UI shows a banner "Offline mode, cash only" when disconnected. Since v1 has no cash, this is effectively "Offline mode, no payments." Banner updates to reflect cash availability in the future.

---

## 2026-05-21: Reconciliation runs nightly

**Decision:** A scheduled Convex action runs at 03:00 Jakarta time daily:
1. Reconciles `pos_stock_levels` from `pos_stock_movements` sum, flags drift.
2. Reaps stale `staff_sessions` (started_at > 8h ago, ended_at null).
3. Reaps expired `pos_payments` (status pending, expires_at past, no callback).
4. Polls Xendit for any settlement records not yet captured.

**Reason:** Drift accumulates. Nightly reconciliation catches issues before they compound.

**Implication:** Reconciliation drift over a threshold (e.g. 5 units) triggers a dashboard alert for the manager.

---

## 2026-05-21: CSV export for accounting

**Decision:** Dashboard has a "Export" route. Manager picks a date range and exports transactions, refunds, settlements as CSV. Three separate files.

**Reason:** Accounting workflow lives in spreadsheets. Don't fight it.

**Implication:** Convex action returns CSV string. Frontend triggers download. No 3rd-party export library, just template strings.

---

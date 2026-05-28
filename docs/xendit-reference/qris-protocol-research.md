# QRIS Protocol & Integration Field Research

> **Bundled into FrolliePOS from `product_master` on 2026-05-28.** Verbatim copy of
> `docs/research/2026-05-21-qris-protocol-and-fields.md`.
>
> **Heads-up before you read:** this research predates the implementation and was scoped
> to the **qris.online / InterActive** aggregator (a *poll-based* API). The team ultimately
> shipped on **Xendit's QR Codes API** (webhook-based) instead — so §3 below (the
> InterActive endpoints, `do=create-invoice`, polling `checkpaid_qris.php`) is **NOT** how
> the final integration works. Read §1, §2, and §4 for the protocol/field fundamentals
> (EMVCo TLV, NMID, MPM vs CPM, dynamic vs static) — those are aggregator-agnostic and
> still accurate. For the actual Xendit wiring, see this bundle's `README.md` +
> `reference-impl/`.

---

> **Date:** 2026-05-21
> **Status:** Research / reference (no implementation decisions committed)
> **Scope:** Understand the QRIS protocol, synthesize the key fields required to transact, and hypothesise which existing Frollie fields map to each. Primary API source: [qris.online API docs](https://qris.online/api-doc/) (the **InterActive** PJSP aggregator).
> **Next step:** brainstorm + plan how to introduce QRIS payment into the current order workflow (separate spec).

---

## 1. What QRIS actually is

**QRIS** (Quick Response Code Indonesian Standard) is the *national* QR-payment standard, mandated by **Bank Indonesia (BI)** and operationally governed by **ASPI** (Asosiasi Sistem Pembayaran Indonesia). It is **not an API** — it is a QR-code *payload format* built on top of the **EMVCo Merchant-Presented Mode (MPM)** specification, plus an Indonesian national numbering layer.

Key consequence for us: **you never integrate "QRIS" directly.** You integrate a licensed **PJSP** (Penyedia Jasa Sistem Pembayaran) / acquirer / aggregator who:
- holds your **NMID** (National Merchant ID, issued by BI/PTEN),
- generates valid QRIS payloads on your behalf,
- receives the funds from any payer's wallet/bank (GoPay, OVO, DANA, ShopeePay, BCA, etc.),
- tells you when an order is paid, and
- settles the money to your bank account (T+1 typical, minus MDR fee).

The qris.online / **InterActive** service used in this research is one such aggregator.
*(The shipped integration uses **Xendit** as the PJSP/aggregator instead — same role, webhook-based instead of poll-based.)*

### Two QRIS modes (we only need one)

| Mode | Who shows the QR | Use case | Relevant to us? |
|------|------------------|----------|-----------------|
| **MPM** — Merchant-Presented Mode | Merchant displays QR; customer scans | Storefront, invoices, e-commerce checkout | ✅ **Yes** — this is what we'd use |
| **CPM** — Customer-Presented Mode | Customer's app shows QR; merchant scans | POS terminal scanning a phone | ❌ No |

### Static vs Dynamic MPM (we need dynamic)

| | Static (tag 01 = `11`) | Dynamic (tag 01 = `12`) |
|---|---|---|
| Amount | Not embedded — customer types it | **Embedded** in the QR |
| Reuse | Reusable poster/sticker | One-time, per transaction |
| Reconciliation | Hard (no per-txn ref) | **Per-transaction reference** |
| Frollie fit | ✗ | ✅ One QR per order, amount = `finalTotal` |

---

## 2. The QRIS payload (EMVCo MPM TLV structure)

A QRIS string is a flat **TLV** (Tag-Length-Value) encoding. Each field = 2-digit tag + 2-digit length + value. Some tags (26–51, 62) nest another TLV inside.

Example (truncated): `00020101021226...5204581253033605802ID5910FROLLIE...6304ABCD`

### Root-level tags

| Tag | Field | QRIS value / notes | Required |
|-----|-------|--------------------|----------|
| `00` | Payload Format Indicator | Fixed `01` | ✅ |
| `01` | Point of Initiation Method | `11` static / `12` **dynamic** | ✅ |
| `26`–`51` | Merchant Account Information | Nested TLV blocks (see below). QRIS domestic data lives here. | ✅ (≥1) |
| `52` | Merchant Category Code (MCC) | ISO 18245, e.g. `5814` (fast-food/restaurants) | ✅ |
| `53` | Transaction Currency | ISO 4217 numeric — **`360`** for IDR | ✅ |
| `54` | Transaction Amount | Integer rupiah (dynamic only). e.g. `35000` | ⬤ dynamic only |
| `55` | Tip / Convenience Indicator | `01` no tip, `02` fixed, `03` percentage | optional |
| `56`/`57` | Convenience fee fixed / percentage | If tip enabled | optional |
| `58` | Country Code | **`ID`** | ✅ |
| `59` | Merchant Name | ≤ 25 chars, e.g. `FROLLIE` | ✅ |
| `60` | Merchant City | ≤ 15 chars, e.g. `JAKARTA` | ✅ |
| `61` | Postal Code | optional | optional |
| `62` | Additional Data Field Template | Nested TLV (see below) — holds the **bill/invoice ref** | recommended |
| `63` | CRC | CRC-16/CCITT-FALSE checksum, 4 hex chars | ✅ |

### Merchant Account Information (tags 26–51) — the QRIS-specific block

Each is a nested TLV. For QRIS, the canonical block:

| Sub-tag | Field | Notes |
|---------|-------|-------|
| `00` | Globally Unique Identifier (GUID) | `ID.CO.QRIS.WWW` (national QRIS domain) |
| `01` | NMID | **National Merchant ID** (issued by BI/PTEN) |
| `02` | Merchant ID (acquirer-side) | Acquirer/PJSP merchant id |
| `03` | Merchant Criteria | `UMI`/`UKE`/`UME`/`UBE` (merchant size class) |

Tags 26/27 typically carry the domestic QRIS block; higher tags (50/51) can carry acquirer-specific or interoperable blocks.

### Additional Data Field Template (tag 62)

| Sub-tag | Field | Use |
|---------|-------|-----|
| `01` | Bill Number | **Per-transaction invoice ref** → our `orderNumber` |
| `02` | Mobile Number | optional |
| `05` | Reference Label | alt transaction id |
| `07` | Terminal Label | device/POS id |

### CRC (tag 63)

**CRC-16/CCITT-FALSE**: polynomial `0x1021`, init `0xFFFF`, no reflection, no final XOR. Computed over the *entire* string including the literal `6304` tag+length, output as 4 uppercase hex chars. (Only relevant if we ever **generate** payloads ourselves; the aggregator does this for us.)

---

## 3. How we'd actually transact — the InterActive (qris.online) API

> ⚠️ **NOT THE SHIPPED DESIGN.** This section describes the *poll-based* InterActive
> aggregator that was researched but not chosen. The shipped integration uses **Xendit's
> webhook-based QR Codes API** — see this bundle's `README.md`. Kept for historical context
> on what a poll-based aggregator looks like (and why webhook-based was preferred).

> Reality check: **the documented API is poll-based, not webhook-based.** `create-invoice` accepts **no callback URL**; payment confirmation is done by **polling** `check-invoice`. This is the single biggest design constraint for the integration phase.

### Auth / identifiers (from activation email)

| Identifier | Meaning |
|------------|---------|
| `apikey` | API key, emailed on registration/activation |
| `mID` | Merchant ID (provider/acquirer side) — integer |
| `NMID` | National Merchant ID (BI/PTEN) — returned in responses, displayed under QR |

### 3.1 Create Invoice (generate dynamic QR)

```
GET https://qris.interactive.co.id/restapi/qris/show_qris.php
```

| Param | Type | Req | Description | Frollie source |
|-------|------|-----|-------------|----------------|
| `do` | string | ✅ | literal `"create-invoice"` | constant |
| `apikey` | string | ✅ | API key | secret/config |
| `mID` | int | ✅ | Merchant ID | secret/config |
| `cliTrxNumber` | string | ✅ | **your** txn reference | `orders.orderNumber` (MMDD-NNN) |
| `cliTrxAmount` | int | ✅ | final amount, IDR | `orders.finalTotal` |
| `useTip` | string | ✅ | `"yes"`/`"no"` | constant `"no"` |

**Success response:**
```json
{
  "status": "success",
  "data": {
    "qris_content": "<EMVCo TLV string to render as QR>",
    "qris_request_date": "YYYY-MM-DD HH:MM:SS",   // WIB
    "qris_invoiceid": 9,                            // provider invoice id
    "qris_nmid": "ID1024..."                        // National Merchant ID
  }
}
```
**Failure:** `{ "status": "failed", "data": { "qris_status": "<error>" } }`

- **Expiry:** ~**30 minutes** from `qris_request_date` (WIB / UTC+7).
- **Minimums:** Rp 100 (most e-wallets), Rp 1,000 (OVO).
- Render `qris_content` as a QR image client-side; show `qris_nmid` + merchant name beneath it (BI display rule).

### 3.2 Check Invoice (poll payment status)

```
GET https://qris.interactive.co.id/restapi/qris/checkpaid_qris.php
```

| Param | Type | Req | Description | Frollie source |
|-------|------|-----|-------------|----------------|
| `do` | string | ✅ | literal `"checkStatus"` | constant |
| `apikey` | string | ✅ | API key | secret/config |
| `mID` | int | ✅ | Merchant ID | secret/config |
| `invid` | int | ✅ | the `qris_invoiceid` from create | stored on order |
| `trxvalue` | int | ✅ | amount, IDR | `orders.finalTotal` |
| `trxdate` | date | ✅ | `YYYY-MM-DD` of payment | from create date |

**Paid response:**
```json
{
  "status": "success",
  "data": {
    "qris_status": "paid",
    "qris_payment_customername": "EDWIN PERDANA",
    "qris_payment_methodby": "BCA"
  },
  "qris_api_version_code": "2505011709"
}
```
**Unpaid:** `{ "status": "failed", "data": { "qris_status": "unpaid" } }`

> ⚠️ The provider returns the **payer name** and **paying bank/wallet** but (in the documented tier) **no RRN/settlement reference**. Reconciliation against bank settlement would still be partly manual.

---

## 4. Synthesized "key fields required" → Frollie mapping hypothesis

Legend: ✅ exists · 🟡 exists but needs adaptation · ❌ missing (must add)

### A. Merchant-level (one-time config, per business)

| QRIS field | Required by | Frollie field hypothesis | Status |
|------------|-------------|---------------------------|--------|
| `apikey` | both endpoints | — (new secret) | ❌ env var / `platformCredentials` |
| `mID` | both endpoints | — (new) | ❌ config |
| `NMID` | display rule | `businessSettings.npwp`? **No** — distinct | ❌ add `businessSettings.qrisNmid` |
| Merchant Name (tag 59) | payload | `businessSettings.businessName` | ✅ |
| Merchant City (tag 60) | payload | parse from `businessSettings.address` | 🟡 |
| MCC (tag 52) | payload | — | ❌ constant `5814` (set by PJSP anyway) |

*(Tags 52/59/60/NMID are baked into the merchant profile by the PJSP — we mostly just store/echo them, the aggregator owns payload generation.)*

### B. Per-transaction (per order, at QR creation)

| QRIS field | Endpoint param | Frollie field hypothesis | Status |
|------------|----------------|---------------------------|--------|
| Transaction reference | `cliTrxNumber` | `orders.orderNumber` (`convex/orders/helpers/customerResolution.ts:55`) | ✅ |
| Amount (IDR) | `cliTrxAmount` / tag 54 | `orders.finalTotal` (`convex/schema.ts:~270`) | ✅ |
| Currency | tag 53 | constant `360` | ✅ constant |
| Tip flag | `useTip` | constant `"no"` | ✅ constant |
| Provider invoice id | (returned) `qris_invoiceid` | — | ❌ store on order/new table |
| QR string | (returned) `qris_content` | — | ❌ store on order/new table |
| QR request date / expiry | (returned) `qris_request_date` | maps near `awaitingPaymentSince` | 🟡 store |
| NMID echo | (returned) `qris_nmid` | — | ❌ store/display |

### C. Payment confirmation (on poll / paid)

| QRIS field | Source | Frollie field hypothesis | Status |
|------------|--------|---------------------------|--------|
| Payment status | `qris_status` (`paid`/`unpaid`) | `orders.paymentStatus` (`Unpaid`/`Partial`/`Paid`) | 🟡 map `paid`→`Paid` |
| Payment method | `qris_payment_methodby` (e.g. "BCA") | `orders.paymentMethod` (free string) | ✅ |
| Payer name | `qris_payment_customername` | — (could note vs `customerName`) | 🟡 optional store |
| Paid timestamp | derive at poll time | `orders.confirmedAt` | ✅ |
| Status transition | — | `Draft→AwaitingPayment→PaymentReceived` (`convex/orders/helpers/statusTransitions.ts`) | ✅ existing workflow |

---

## 5. Gap summary — what we already have vs. must build

**Already have (strong fit):**
- ✅ Per-order reference (`orderNumber`, MMDD-NNN) → `cliTrxNumber`
- ✅ Final amount (`finalTotal`) → `cliTrxAmount`
- ✅ Payment status field + 3-value enum, `paymentMethod`, `confirmedAt`
- ✅ Order status workflow already has `AwaitingPayment` → `PaymentReceived` (auto-reserves stock)
- ✅ Manual `updatePayment` mutation (`convex/orders/mutations/statusUpdates.ts:230`)
- ✅ Business profile singleton (`businessSettings`) for merchant name/address
- ✅ Established external-integration pattern: `convex/integrations/{platform}/` + `platformCredentials` table for secrets + token pattern + `externalSyncLogs`
- ✅ Audit trail (`orderEvents`)

**Must add for QRIS:**
- ❌ Secrets: `QRIS_API_KEY`, `QRIS_MID` (env var or `platformCredentials` row, `platformId: "qris"`)
- ❌ Merchant `NMID` on `businessSettings`
- ❌ Per-order QRIS state: `qris_invoiceid`, `qris_content`, request date/expiry, returned NMID. Hypothesis: a dedicated **`qrisPayments`** table (1 order → N attempts, since QR expires in 30 min and may be regenerated) rather than fattening `orders`.
- ❌ A **Convex action** that calls `show_qris.php` (create) — actions can do `fetch`, queries/mutations cannot.
- ❌ A **polling mechanism** for `checkpaid_qris.php`: either client-side polling while the QR is on screen, or a scheduled action (`crons`) sweeping open QRIS invoices. (No webhook available.)
- ❌ Map `qris_status: "paid"` → drive existing `PaymentReceived` transition (reuse stock-reservation side effects).
- ❌ Expiry/timeout handling (30-min window) + regenerate flow.

**Open questions for the design phase:**
1. **Provider lock-in:** commit to InterActive/qris.online, or abstract behind a `ChannelAdapter`-style interface so Midtrans/Xendit could swap in later? (Their APIs *do* support webhooks, which would be cleaner than polling.) → *Resolved: abstracted behind a `QrisProvider` interface and shipped on **Xendit** (webhook-based).*
2. **Polling strategy:** client-driven (simple, only while staff watches the screen) vs. cron-swept (robust, costs scheduled-function runs). → *Resolved: moot — Xendit is webhook-driven, no polling.*
3. **Partial payments:** QRIS dynamic QR is exact-amount; `paymentStatus: "Partial"` likely never occurs via QRIS — confirm.
4. **Reconciliation:** no RRN in the documented tier — is payer-name + bank enough, or do we need a higher provider tier / settlement report? → *Xendit returns a `receipt_id` (RRN) in `payment_detail`.*
5. **Sandbox:** does InterActive provide a true sandbox/test merchant, or do we test against a live low-value (Rp 100) merchant? → *Xendit has Test Mode + a simulate-payment button.*

---

## Sources

- [qris.online — API documentation index](https://qris.online/api-doc/)
- [qris.online — Create Invoice spec](https://qris.online/api-doc/create-invoice.php) → `show_qris.php`
- [qris.online — Check Invoice spec](https://qris.online/api-doc/check-invoice.php) → `checkpaid_qris.php`
- [Bank Indonesia — QRIS](https://www.bi.go.id/en/fungsi-utama/sistem-pembayaran/ritel/kanal-layanan/qris/default.aspx)
- [ASPI Indonesia — QRIS standard](https://aspi-indonesia.or.id/standar-dan-layanan/qris/)
- [EMVCo — QR Code specifications](https://www.emvco.com/emv-technologies/qr-codes/)
- [EMVCo MPM tag reference (lee-ratinan/emv-qr)](https://github.com/lee-ratinan/emv-qr)
- [EMV QR Code Specifications overview (W3C/EMVCo slides)](https://www.w3.org/2020/Talks/emvco-qr-20201021.pdf)

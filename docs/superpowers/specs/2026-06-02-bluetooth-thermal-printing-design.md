# v0.5.4 — Bluetooth thermal receipt printing (design)

**Date:** 2026-06-02
**Status:** Design — approved in brainstorm; spec-staffreview fixes applied (see `docs/reviews/staffreview-v0.5.4-printing-design-2026-06-02.md`)
**Phase:** v0.5.4 (standalone; not part of in-flight v0.5.3a reporting)
**Author:** brainstorm session (lucas + Claude)

---

## 1. Problem & goal

The booth has an **EPPOS EP5811AI** 58mm Bluetooth thermal printer. Today receipts exist only as a server-rendered digital page (`/r/<token>`, ADR-039). Staff want to hand customers a **paper receipt**, printed from the POS PWA with **near-zero friction**: the printer is remembered and auto-connected, printing is one tap on the sale-complete screen, and there is a **test-print** path that works without making a sale.

**Success criteria**
- After a sale reaches `paid`, staff tap **one button** and a correctly formatted 58mm receipt prints.
- The printer is **chosen once**; thereafter it auto-reconnects on app load with no device picker.
- A **Test print** action prints a representative sample receipt at any time (no sale required).
- Printing is **fully client-side** over Bluetooth — no new server round-trip at print time beyond the (already-loaded) receipt data + the existing `shareReceipt` token mint.
- `npm run typecheck` + `npm run build` clean; `npx vitest` green (BE query + encoder golden + chunk tests).

**Non-goals (v1)**
- Raster/bitmap rendering or a printed Frollie logo image (fast-follow; see §11).
- Auto-print without a tap (manual tap in v1; auto-print is a later toggle).
- Reprint-from-history UI (history screen is itself still stubbed; printing is wired on the charge-success screen in v1).
- iOS support (POS is Android-only single-device per CLAUDE.md; Web Bluetooth is Chrome/Android).
- Cash-drawer / barcode / label modes.

---

## 2. Device facts (verified on-device 2026-06-01 via nRF Connect)

- Bluetooth name: **`BlueTooth Printer`** — module: CEVA `SM-1`, FW `01.1`.
- **Dual-mode**: advertises BLE (appeared in Chrome's Web Bluetooth chooser) *and* supports Classic SPP (the bundled "POSPrinter - BT" APK). We use **BLE only**.
- Hex write `1B 40 … 0A` physically printed → ESC/POS over BLE confirmed.

**GATT print target (hardcoded):**

| | UUID | Use |
|---|---|---|
| **Service** | `000018f0-0000-1000-8000-00805f9b34fb` (`0x18F0`) | ESC/POS print service |
| **Write characteristic** | `00002af1-0000-1000-8000-00805f9b34fb` (`0x2AF1`) | `WRITE` / `WRITE NO RESPONSE` — receipt bytes go here |
| Notify characteristic | `00002af0-…` (`0x2AF0`) | `INDICATE`/`NOTIFY` — status (unused in v1) |

Documented fallback (not implemented): ISSC transparent-UART service `49535343-fe7d-4ae5-8fa9-9fafd205e455`, write char `49535343-8841-43f4-a8d4-ecbe34729bb3`. We pin to the **service UUID, not the device MAC**, so a same-family replacement printer works without code changes.

---

## 3. Architecture & data flow

Web Bluetooth is browser-only, so ESC/POS encoding happens **client-side**. The server's job is to hand the browser the structured, snapshot-safe receipt data it already assembles — **without** the receipt token (ADR-021, see §4).

```
charge-success.tsx  (or Test print)
   │
   ├─ useMutation shareReceipt({ txnId, idempotencyKey })  ──► { token }   (existing; idempotent → stable QR)
   ├─ useQuery   receipts.public.getReceiptForPrint({ sessionId, txnId }) ─► { viewModel, status, statusLabel } | null
   │
   ▼  (both resolved)
src/lib/escpos.ts   encodeReceipt(viewModel, status, statusLabel, buildReceiptUrl(token)) → Uint8Array
   │                (money via src/lib/format.rp; datetime via fmtDate/fmtTime; ASCII-folded)
   ▼
useThermalPrinter   chunkBytes() → paced writeWithoutResponse → char 0x2AF1
   ▼
🖨  EP5811AI  → paper (QR → /r/<token>)
```

**No duplicate business logic.** The backend reuses `_buildViewModel_internal` (snapshot prices/names per rule #1, computed refund status, payment-method label, RRN, settings). The QR token comes from the existing `transactions.shareReceipt` mutation; the URL is built with the existing `src/lib/format.ts:buildReceiptUrl`.

---

## 4. Backend changes (small)

### `convex/receipts/public.ts` (new file)

```ts
export const getReceiptForPrint = query({
  args: { sessionId: v.id("staff_sessions"), txnId: v.id("pos_transactions") },
  handler: async (ctx, args): Promise<{
    viewModel: ReceiptViewModel;
    status: ReceiptStatus;        // "paid" | "partial_refund" | "refunded"
    statusLabel: string;          // pre-derived label, e.g. "LUNAS"
  } | null> => {
    // 1. Role + today-scope — MIRROR transactions.public.getTransactionDetail (public.ts:486):
    const who = await ctx.runQuery(internal.auth.internal._resolveSessionRole_internal, { sessionId: args.sessionId });
    if (!who) return null;                                   // invalid session → graceful null
    // (staff → server-today WIB only; manager → any. Same wibDayWindow guard as getTransactionDetail.)
    // 2. Reuse the existing view-model builder (no rebuild):
    const vm = await ctx.runQuery(internal.receipts.internal._buildViewModel_internal, { transactionId: args.txnId });
    if (!vm) return null;                                    // not paid / not found
    // (apply the staff today-window check against the txn's paid_at/created_at before returning)
    // 3. Pre-derive status label server-side (Improvement 2 — keeps the client off convex/receipts/template.ts):
    const status = computeReceiptStatus(vm);                 // existing template.ts helper, called BE-side
    return { viewModel: vm, status, statusLabel: STATUS_LABELS[status].label };
  },
});
```

**Critical fixes applied from staffreview:**
- **No token / no URL returned (ADR-021).** `getTransactionDetail` deliberately withholds `receipt_token` (`public.ts:516-519`) so the 32-byte view capability lives on exactly one seam. This query does the same. The QR token comes from `shareReceipt` (the sanctioned mint path); the client builds the URL via `buildReceiptUrl(token)`.
- **Same role/today scope as `getTransactionDetail`.** Uses `_resolveSessionRole_internal` and restricts staff to server-today (WIB), manager to any, returning `null` out-of-scope. A flat "require session" gate would be a strictly weaker seam for the same sensitive data (lines, RRN, payment detail).
- **Status label pre-derived BE-side** and returned, so `src/lib/escpos.ts` never imports `convex/receipts/template.ts` (which pulls `convex/lib/*` server modules into the browser bundle).

Notes:
- Read-only — **not** idempotency-wrapped (idempotency is for mutations, rule #20) and **not** audited in v1 (no state/money change; §9). `shareReceipt` already audits the first token mint.
- `_buildViewModel_internal` (`internal.ts:111`) reused verbatim — no change to `internal.ts`/`template.ts` (we only call `computeReceiptStatus`/`STATUS_LABELS`, already exported from `template.ts`).

---

## 5. ESC/POS encoder — `src/lib/escpos.ts` (new, pure)

Dependency: **`@point-of-sale/esc-pos-encoder`** (maintained, browser-safe, no Node deps, `Uint8Array` output, native QR via `GS ( k`).

`encodeReceipt(vm: ReceiptViewModel, status: ReceiptStatus, statusLabel: string, receiptUrl: string): Uint8Array`:
- `initialize()` (`ESC @`), set codepage for Latin text.
- **Header** centered: business name (bold, double-height), address, contact, `@frollie.id`.
- Status line: `[ ${statusLabel} ]` — **label passed in from BE** (no client status map).
- Receipt number + WIB datetime row using **`src/lib/format.ts:fmtDate`/`fmtTime`** (Improvement 1 — not `convex/lib/time`).
- **Line items** at 32-col: `qty x name` left / `line_subtotal` right; `@ unit_price` and refund annotation (`-> n dari m dikembalikan`) on sub-lines.
- Subtotal, voucher (when `voucher_discount > 0`), **TOTAL** (bold, double-height), refund block + NET DIBAYAR when refunds present — same conditional structure as the HTML template.
- Payment method + `RRN` (when present).
- **QR code** of `receiptUrl` (`.qrcode(url)`), centered, caption "Scan untuk struk digital".
- Footer thank-you + Instagram. Feed several lines at end (**no auto-cutter** — tear bar).
- **Money** via **`src/lib/format.ts:rp`** (Improvement 1 — rule #14, no new formatter, no floats).
- **ASCII-fold / strip emoji** (Improvement 5): the head can't render 🍪💛 — drop or fold non-ASCII in names/identity before encoding.

Pure function → **golden byte-stream unit tests** (deterministic; pass a **fixed `paid_at`** so bytes don't drift). Cases: paid, voucher, partial-refund, full-refund.

**QR caveat:** native ESC/POS QR (`GS ( k`) support on CEVA firmware is unverified. Build step verifies on-device; if unsupported, fall back to **raster QR** — generate a QR matrix (`qrcode` lib; note `qrcode.react@4.2.0` is already a dep but is DOM-only, so add `qrcode` for the matrix) → monochrome bitmap → `GS v 0`. Isolated inside `escpos.ts`; rest of the design unaffected. Build-time decision, not a blocker.

---

## 6. Bluetooth connection — `src/hooks/useThermalPrinter.ts` (new)

State machine: `unsupported | disconnected | connecting | connected | printing | error`.

- **`connect()`** (first time, requires user gesture): `navigator.bluetooth.requestDevice({ filters: [{ services: [0x18f0] }, { namePrefix: "BlueTooth" }], optionalServices: [0x18f0] })` → chooser pre-filtered to essentially just this printer → `device.gatt.connect()` → cache the `BluetoothDevice` grant.
- **Auto-reconnect (the "auto-chosen" requirement):** on mount, `navigator.bluetooth.getDevices()` returns previously-granted devices → match by id/name → silent `gatt.connect()` (no user gesture required for a re-grant) → `connected`, **no picker**. (Shipped in Android Chrome; no flag.)
- **`print(bytes)`:** get service `0x18f0` → char `0x2af1` → **`chunkBytes(bytes, MTU)`** → paced `writeValueWithoutResponse` per chunk (small await between) so the printer buffer doesn't overflow — prevents the "everything on one line / truncation" failure mode.
- **`testPrint()`:** encodes the shared sample `ReceiptViewModel` fixture (see §10) → `print()`. No backend, no sale.
- Handles `gattserverdisconnected` → `disconnected`, auto-retry once.
- Feature-detect `navigator.bluetooth` → `unsupported` (graceful: hide print UI, no crash).

**`chunkBytes(bytes: Uint8Array, size: number): Uint8Array[]`** is extracted as a **pure function** (Improvement 3) and unit-tested (empty / < MTU / exact / > MTU) — the one testable slice of the BLE layer.

**Types:** add **`@types/web-bluetooth`** devDependency (Critical 2) and include it in `tsconfig` `types` — `navigator.bluetooth`, `BluetoothDevice`, `getDevices()`, `writeValueWithoutResponse` have no ambient types otherwise → `tsc -b` fails.

---

## 7. UI surfaces

Minimal, staff-accessible (printing is **not** manager-gated).

- **`src/components/pos/PrinterSheet.tsx`** (new) — bottom sheet (shadcn), opened from a printer icon passed via **`AppHeader`'s existing `rightSlot` prop** (Improvement 4 — no AppHeader signature change):
  - Live status chip (Connected ✓ / Disconnected / Connecting…).
  - **Connect / Disconnect** button.
  - **Test print** button.
- **`src/routes/sale/charge-success.tsx`** (edit) — add:
  - Pull `sessionId` from `useSession` (page currently calls `getById` with only `{ txnId }`; the print query is session-gated).
  - Compact printer-status chip; tapping when disconnected triggers `connect()`.
  - **"Cetak struk" (Print receipt)** primary button → `shareReceipt` ∥ `getReceiptForPrint` → `encodeReceipt` → `print()`. Re-tappable (reprint; token stable). Toast on success/failure (Sonner). Disabled-with-hint when `unsupported`/`disconnected`/receipt `null`.

ASCII target (58mm / 32 col):
```
        FROLLIE
   Pakuwon Mall, Surabaya
        @frollie.id
- - - - - - - - - - - - - - - -
          [ LUNAS ]
R-2026-0042       02/06 18:08
- - - - - - - - - - - - - - - -
2 x Dubai 8pcs       Rp 240.000
  @ Rp 120.000
1 x Mixed Box 4pcs    Rp 85.000
- - - - - - - - - - - - - - - -
Subtotal            Rp 325.000
TOTAL               Rp 325.000
Dibayar via QRIS
       [ QR code ]
  Scan untuk struk digital
   Terima kasih! @frollie.id
```

---

## 8. Offline & deployment

- **Offline:** BLE printing needs no network — but `getReceiptForPrint` + `shareReceipt` do. On charge-success the data is already loaded from the live query, and a paid charge is strictly online anyway. Test print is fully offline (hardcoded fixture). No new offline-queue work. Consistent with ADR-025.
- **Deployment order:** deploy Convex (`getReceiptForPrint`) **before** the Vercel FE that calls it.
- **Rollback:** fully additive (new files + one button + one query; no schema change). Revert the commits, drop `@types/web-bluetooth` + `@point-of-sale/esc-pos-encoder` (+ `qrcode` if added). `shareReceipt`/token infra is pre-existing and untouched.

---

## 9. Audit & money

- **No audit row** for printing in v1 — read-only, moves no money/state (contrast rule #9 gated actions). `shareReceipt` already audits the first token mint. Documented in ADR-043. A `receipt.printed` audit is a later additive option if reprint-abuse tracking is wanted.
- All amounts integer rupiah (rule #14) via `src/lib/format.ts:rp`; ESC/POS receives pre-formatted strings, never floats.

---

## 10. Testing

| Layer | What | Type |
|-------|------|------|
| BE | `getReceiptForPrint`: paid happy-path; not-paid→null; **staff out-of-today→null**; manager-any; invalid-session→null | convex-test (mirror `getTransactionDetail` tests) |
| Client | `escpos.encodeReceipt`: paid / voucher / partial-refund / full-refund golden bytes (**fixed `paid_at`**) | vitest |
| Client | `chunkBytes`: empty / < MTU / exact / > MTU | vitest |
| Manual | Real EP5811AI: connect; **auto-reconnect cold-start**; full-length receipt (no truncation); **QR scans → `/r/<token>`**; test-print | on-device checklist |

Shared **sample `ReceiptViewModel` fixture** (exported) feeds both the golden tests and `testPrint()`.

**Test checkpoints:** after BE (Wave 1), after encoder/hook (Wave 2), before merge (full `vitest` + `build`).
**Regression:** low — only `charge-success.tsx` (additive button) + `AppHeader` `rightSlot` usage touched. Smoke-test charge-success still renders + "New sale".

---

## 11. Scope summary & fast-follows

**In v1:**
- BE: `convex/receipts/public.ts` (`getReceiptForPrint` — view-model + status, role/today-scoped, **no token**).
- FE: `src/lib/escpos.ts`, `src/hooks/useThermalPrinter.ts` (+ pure `chunkBytes`), `src/components/pos/PrinterSheet.tsx`; edits to `charge-success.tsx` (+ `useSession`), printer icon via `AppHeader` `rightSlot`.
- Deps: `@point-of-sale/esc-pos-encoder`, `@types/web-bluetooth` (dev); `qrcode` only if raster-QR fallback needed.
- **ADR-043** — Web Bluetooth ESC/POS thermal printing.
- Tests: BE query (convex-test), `escpos` golden, `chunkBytes` unit; BLE manual on-device checklist.
- Docs: CHANGELOG, API_REFERENCE (`getReceiptForPrint`), PROGRESS.md v0.5.4 phase + Task IDs.

**Fast-follows (not v1):** raster Frollie logo header; auto-print toggle; reprint-from-history once history ships; printer status read via `0x2AF0` notify (paper-out detection).

---

## 12. Implementation waves

| Wave | Work | Mode |
|------|------|------|
| 0 | Add `@types/web-bluetooth` + `@point-of-sale/esc-pos-encoder`; wire `tsconfig` types | SEQUENTIAL (first) |
| 1 | BE `getReceiptForPrint` (role/today scope, status label, **no token**) + convex-test | SEQUENTIAL (deploy before FE) |
| 2a | `src/lib/escpos.ts` + golden tests | PARALLEL w/ 2b |
| 2b | `useThermalPrinter` + pure `chunkBytes` test | PARALLEL w/ 2a |
| 3 | `PrinterSheet` + `charge-success` wiring (`shareReceipt` ∥ `getReceiptForPrint`) | SEQUENTIAL (needs 1,2a,2b) |
| 4 | ADR-043, CHANGELOG, API_REFERENCE, PROGRESS v0.5.4, on-device verification | SEQUENTIAL |

Commit boundaries: one per wave (deps / BE+test / encoder+test / hook+test / UI / docs).

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Native ESC/POS QR unsupported on CEVA FW | Isolated in `escpos.ts`; raster-QR fallback via `qrcode`→`GS v 0`. Verify on-device. |
| BLE write overflow → garbled/one-line output | `chunkBytes` ≤ MTU + paced awaits in `print()`; `chunkBytes` unit-tested. |
| `getDevices()` permission lost (browser data cleared) | Falls back to one-tap `connect()`; status chip makes state obvious. |
| Web Bluetooth absent (non-Chrome / iOS) | Feature-detect → `unsupported`, hide print UI. POS is Android-Chrome single-device. |
| Replacement printer of different family | Service UUID hardcoded for the EPPOS/CEVA `0x18f0` family; a non-family unit needs an `escpos`/UUID tweak (documented). |

## 14. Open verification items (build-time, non-blocking)
1. Native QR vs raster QR on the actual unit.
2. Optimal chunk size / pacing for clean full-length receipts.
3. `getDevices()` auto-reconnect timing on cold app start.

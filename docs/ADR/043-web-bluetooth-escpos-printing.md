# 043. Client-side Web Bluetooth ESC/POS thermal printing

**Date:** 2026-06-02
**Status:** Accepted
**Group:** Receipts

## Context

The booth has an **EPPOS EP5811AI** 58mm thermal printer (dual-mode BLE). Staff want a paper receipt at the counter the moment a sale completes — not only the digital `/r/<token>` receipt (ADR-021). The POS is a PWA running on a single Android device; there is no native shell to bridge to a printer SDK.

The EP5811AI exposes its print pipe over **BLE GATT**: service `0x18f0`, write characteristic `0x2af1`, accepting **ESC/POS** byte commands. (`0x18f0`/`0x2af1` is the common CEVA/ISSC profile; if a unit advertises only the ISSC alternate service it must be added to the chooser filter.) ESC/POS text + native QR rendering was verified on-device against this exact printer.

The only way for a browser PWA to talk to BLE is **Web Bluetooth** (`navigator.bluetooth`). It is **Chromium-only** and, on mobile, **Android Chrome only** — iOS Safari and non-Chromium browsers have no Web Bluetooth implementation. There is no server-side print path: the printer is on the booth's local Bluetooth, not reachable from Convex.

The receipt content already exists as a `ReceiptViewModel` (built server-side for the `/r/<token>` HTML page). Re-deriving it client-side would duplicate the money/line math; the print path should consume the same view model. The digital-receipt QR token, however, is a capability (ADR-021) and must **not** leak through a read query — it is minted only by the existing `transactions.shareReceipt` mutation.

## Decision

### Decision A — Client-side Web Bluetooth + ESC/POS, no server print path

Printing is entirely client-side. The PWA connects to the EP5811AI via Web Bluetooth, encodes the receipt to ESC/POS bytes in the browser, and writes them to characteristic `0x2af1` on service `0x18f0`. Convex is never in the print loop.

### Decision B — `esc-pos-encoder` (classic chainable, v2.x), text mode

Encoding uses the unscoped **`esc-pos-encoder`** package (v2.1.0 — the classic chainable encoder). *(The plan referenced `@point-of-sale/esc-pos-encoder`; that scoped package does not exist on npm. The unscoped `esc-pos-encoder` is the chainable encoder that was installed.)* Its Node build pulls in native `canvas`, but the **browser build is canvas-free** and is what Vite bundles — no native dependency reaches the PWA.

v1 is **text mode**: no raster logo. `settings.logo_url` is ignored for the printed receipt (a raster-logo pass is a fast-follow). The encoder reuses `src/lib/format` (`rp`/`fmtDate`/`fmtTime`) for money/date formatting and ASCII-folds emoji so the thermal head renders clean glyphs.

The encoder lives in **`src/lib/escpos.ts`** as a pure function — `encodeReceipt(viewModel, status, statusLabel, receiptUrl): Uint8Array` — plus an exported `SAMPLE_RECEIPT` fixture for the test-print path. View-model types are imported **`import type` only**, so no Convex runtime is pulled into the browser bundle.

### Decision C — QR encodes the digital-receipt URL; token comes from `shareReceipt`, not the read query

The printed receipt carries a QR code linking the customer to the digital `/r/<token>` receipt. The QR encodes the URL built from a token minted by the **existing `transactions.shareReceipt` mutation** (idempotent per txn — reprints reuse the same token). The QR is rendered with the encoder's **native ESC/POS QR** command (`GS ( k`).

A new read query **`receipts.getReceiptForPrint(sessionId, txnId)`** returns `{ viewModel, status, statusLabel } | null` — the existing `ReceiptViewModel` plus a pre-derived status label — and **never the token or URL** through that seam (ADR-021: tokens authorise VIEW and are minted, not read back). To enable the server-side label, **`STATUS_LABELS`** in `convex/receipts/template.ts` was promoted from module-private to exported, so the query derives the label server-side and the client never imports `template.ts`.

`getReceiptForPrint` is **session-gated and role/today-scoped, mirroring `getTransactionDetail`**: staff see server-today only; managers see any day. It routes the cross-module txn read through `transactions/internal` per ADR-034.

### Decision D — `getReceiptForPrint` is not audited

The query is read-only — it moves no money and changes no state — so it writes **no `audit_log` row**, consistent with the other reporting reads (`getTransactionDetail`, `dashboardSummary`). The token-minting `shareReceipt` mutation remains audited as before.

### Decision E — Fallback chain isolated in `escpos.ts`

Two fallback layers are anticipated and kept isolated in the encoder module so the BLE layer never changes:

1. **QR rendering:** native ESC/POS QR (`GS ( k`) is the default. If a firmware revision does not render native QR, the fallback is a **raster QR** (`qrcode` lib → bitmap → `GS v 0` raster image), swapped inside `escpos.ts` only.
2. **GATT service:** `0x18f0`/`0x2af1` is the default filter. If a unit advertises only the **ISSC alternate service**, it is added to the Web Bluetooth chooser filter — a one-line filter change, no protocol rewrite.

### Decision F — Chunked, paced writes; silent auto-reconnect

BLE characteristic writes have a small MTU. The hook chunks the ESC/POS byte stream and writes via `writeValueWithoutResponse` at a **180-byte chunk size with 20 ms pacing**. The pure `chunkBytes(bytes, size)` splitter (`src/hooks/useThermalPrinter.ts`) is unit-tested (empty / smaller-than-chunk / exact-boundary / remainder).

Connection uses a **filtered device chooser** on first connect, then **silent auto-reconnect** via `navigator.bluetooth.getDevices()` — the reconnect probe runs only from the idle "disconnected" state, which also yields auto-reconnect after a drop. The `useThermalPrinter` hook feature-detects Web Bluetooth and surfaces an `unsupported` state on non-Chrome/iOS.

## Amendment — 2026-06-02 (on-device QA): QR points to Instagram, not the digital receipt

Decision C is **superseded** by booth feedback during on-device QA. The printed QR now encodes the booth's **Instagram follow URL** (`https://www.instagram.com/<handle>/`), derived from the `instagram_handle` receipt setting via the pure `instagramUrl()` helper in `escpos.ts`. Rationale: at the counter, a follow-us QR is worth more than a per-transaction digital-receipt link, and the handle is already an editable `/mgr/receipt` setting (no schema change, no per-print token mint).

Consequences of the amendment:
- `encodeReceipt` no longer takes a `receiptUrl` argument; `charge-success` no longer calls `shareReceipt` just to print (one fewer mutation per print). The token-as-capability invariant (ADR-021) is **unaffected** — `getReceiptForPrint` still returns no token.
- The `/r/<token>` **digital receipt still exists** and is reachable via the history "share" action; it is simply no longer the *printed* QR target.
- The encoder also now (a) skips empty header lines so clearing `address` in `/mgr/receipt` removes the line, and (b) prints the configurable `settings.footer_text` instead of a hardcoded string.
- Decision E's raster-QR fallback still applies to the Instagram QR.

## Alternatives considered

- **Server-side / cloud print.** No path — the printer is on local Bluetooth, unreachable from Convex. Rejected.
- **Native app shell (Capacitor/TWA) with a printer SDK.** Would unlock iOS and a vendor SDK, but the POS is deliberately a PWA (ADR-025, no Play Store app). A whole native build for one feature is disproportionate. Deferred — revisit only if iOS printing becomes a hard requirement.
- **Re-derive the receipt view model client-side.** Duplicates the money/line math that already lives server-side and risks drift. Rejected — consume the same `ReceiptViewModel` via `getReceiptForPrint`.
- **Return the receipt token through `getReceiptForPrint`.** Simpler (one round-trip), but leaks a VIEW capability through a read query, violating ADR-021. Rejected — the token is minted by `shareReceipt`.
- **Raster logo in v1.** The on-device verification was text + native QR; raster logo adds bitmap-encoding surface for marginal benefit at launch. Deferred to a fast-follow.

## Consequences

- *Android-Chrome only.* iOS and non-Chromium browsers cannot print. The `useThermalPrinter` hook reports `unsupported`; the booth device is Android Chrome, so this is acceptable for v1.
- *No raster logo in v1.* `settings.logo_url` is ignored on the printed receipt; the digital `/r/<token>` receipt still renders the logo.
- *Printer auto-reconnects.* After the first paired connect, `navigator.bluetooth.getDevices()` reconnects silently on app load and after a drop — staff don't re-pick the device each shift.
- *The BLE layer is verified on-device, not unit-tested.* Web Bluetooth cannot be mocked meaningfully; the tested core is the pure `chunkBytes` splitter. End-to-end print was confirmed against the real EP5811AI.
- *Token never leaks through the read seam.* `getReceiptForPrint` returns view-model + label only; the QR URL's token comes from the audited `shareReceipt` mutation (ADR-021 preserved).
- *Fallbacks are pre-located.* QR-rendering and GATT-service fallbacks live in `escpos.ts` / the chooser filter, so a firmware quirk is a localised change, not a rewrite.
- *No new server state.* `getReceiptForPrint` is a read-only, unaudited query; `STATUS_LABELS` becoming an export is the only `template.ts` change.

## Affects other ADRs

- **Relates to [ADR-021](./021-receipt-url-convex-http-action.md):** the printed QR links to the same token-as-capability digital receipt; the token is minted via `shareReceipt`, never read back through `getReceiptForPrint`.
- **Relates to [ADR-025](./025-service-worker-cache.md):** printing is a client-only capability layered on the PWA; it does not change the offline-cache contract (printing requires the local Bluetooth device, independent of network).
- **Relates to [ADR-034](./034-deep-modules-surface-apis.md):** `getReceiptForPrint` lives in the receipts module and routes the cross-module txn read through `transactions/internal`; `STATUS_LABELS` is exported from `template.ts` for server-side label derivation.
- **Relates to [ADR-039](./039-receipt-after-refund-display-contract.md):** reuses the same `ReceiptViewModel` and status derivation that back the `/r/<token>` HTML page.

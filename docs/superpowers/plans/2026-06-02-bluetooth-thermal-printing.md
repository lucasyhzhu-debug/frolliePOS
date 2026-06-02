# Bluetooth Thermal Receipt Printing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Print 58mm ESC/POS receipts to the EPPOS EP5811AI over Web Bluetooth from the POS PWA — one tap on the sale-complete screen, auto-reconnecting printer, and a test-print path.

**Architecture:** Web Bluetooth is browser-only, so ESC/POS encoding is client-side. A new session-gated Convex query (`receipts.getReceiptForPrint`) returns the existing `ReceiptViewModel` + a pre-derived status label (no token — ADR-021). The QR token comes from the existing `transactions.shareReceipt` mutation; the URL is built with the existing `src/lib/format.ts:buildReceiptUrl`. A pure `escpos.ts` encoder turns the view-model into bytes; `useThermalPrinter` manages BLE connect/auto-reconnect and chunked writes.

**Tech Stack:** Convex 1.31.7, React 19 + TS + Vite, Web Bluetooth API, `@point-of-sale/esc-pos-encoder`, `@types/web-bluetooth`, shadcn/ui, vitest + convex-test.

**Spec:** `docs/superpowers/specs/2026-06-02-bluetooth-thermal-printing-design.md`
**Spec review:** `docs/reviews/staffreview-v0.5.4-printing-design-2026-06-02.md`

---

## Assumptions to verify FIRST (plan-review + execution)

1. **`@point-of-sale/esc-pos-encoder` API** — exact class/method names (default export `EscPosEncoder`? `.initialize()/.align()/.bold()/.size()/.line()/.text()/.newline()/.qrcode()/.encode()`). Confirm against the installed package's README/types before Task 3. The encoder *calls* below follow the documented API but method names MUST be verified post-install.
2. **Native ESC/POS QR** (`.qrcode()` → `GS ( k`) renders on the CEVA FW. If not, switch the QR step to the raster fallback (`qrcode` lib → `GS v 0`) — isolated in `escpos.ts`.
3. **`navigator.bluetooth.getDevices()`** is available in the target Android Chrome build (it is in current stable; confirm on the actual device).

These are flagged in the handoff's verify-first list.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `package.json` | Add `@point-of-sale/esc-pos-encoder` (dep), `@types/web-bluetooth` (dev) | Modify |
| `tsconfig.app.json` (or root tsconfig) | Add `"web-bluetooth"` to `compilerOptions.types` | Modify |
| `convex/receipts/template.ts` | Export `STATUS_LABELS` (currently module-private) | Modify |
| `convex/receipts/public.ts` | `getReceiptForPrint` query — view-model + status label, role/today-scoped, no token | Create |
| `convex/receipts/__tests__/getReceiptForPrint.test.ts` | convex-test for the query | Create |
| `src/lib/escpos.ts` | Pure `encodeReceipt(...)` + exported sample fixture | Create |
| `src/lib/__tests__/escpos.test.ts` | Golden byte-stream tests | Create |
| `src/hooks/useThermalPrinter.ts` | BLE connect/auto-reconnect/print + exported pure `chunkBytes` | Create |
| `src/hooks/__tests__/chunkBytes.test.ts` | Pure chunk unit tests | Create |
| `src/components/pos/PrinterSheet.tsx` | Connect / status / test-print bottom sheet | Create |
| `src/routes/sale/charge-success.tsx` | Print button + printer chip; `useSession` for sessionId | Modify |
| `docs/ADR/043-web-bluetooth-escpos-printing.md` | ADR | Create |
| `docs/API_REFERENCE.md`, `docs/CHANGELOG.md`, `docs/PROGRESS.md` | Docs | Modify |

---

## Task 0: Dependencies & types

**Files:**
- Modify: `package.json`, `tsconfig.app.json`

- [ ] **Step 1: Install deps**

```bash
npm install @point-of-sale/esc-pos-encoder
npm install -D @types/web-bluetooth
```

- [ ] **Step 2: Add web-bluetooth to tsconfig types**

In `tsconfig.app.json` `compilerOptions`, add `"web-bluetooth"` to the `types` array (create the array if absent):
```jsonc
"types": ["web-bluetooth"]
```

- [ ] **Step 3: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: PASS (no `navigator.bluetooth` references yet, but `BluetoothDevice` etc. now resolve).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.app.json
git commit -m "chore(v0.5.4): add esc-pos-encoder + @types/web-bluetooth"
```

---

## Task 1: Export `STATUS_LABELS` from the receipt template

`getReceiptForPrint` pre-derives the status label server-side so the client never imports `template.ts`. The label map is currently module-private.

**Files:**
- Modify: `convex/receipts/template.ts:52`

- [ ] **Step 1: Export the map**

Change line 52 from:
```ts
const STATUS_LABELS = {
```
to:
```ts
export const STATUS_LABELS = {
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add convex/receipts/template.ts
git commit -m "refactor(receipts): export STATUS_LABELS for print view-model"
```

---

## Task 2: Backend — `getReceiptForPrint` query (TDD)

Session-gated, role/today-scoped (mirrors `transactions.public.getTransactionDetail:486`), returns the existing `ReceiptViewModel` + status + label, **no token**.

**Files:**
- Create: `convex/receipts/public.ts`
- Test: `convex/receipts/__tests__/getReceiptForPrint.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

async function seedStaff(t: ReturnType<typeof convexTest>, role: "staff" | "manager") {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Ali", pin_hash: "x", role, active: true, created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "dev-1",
      started_at: Date.now(), ended_at: null, end_reason: null,
    });
    return { staffId, sessionId };
  });
}

async function seedPaidTxn(t: ReturnType<typeof convexTest>, staffId: Id<"staff">, createdAt: number) {
  return await t.run(async (ctx) => {
    const txnId = await ctx.db.insert("pos_transactions", {
      status: "paid", subtotal: 25_000, voucher_discount: 0, total: 25_000,
      flags: 0, staff_id: staffId, created_at: createdAt, paid_at: createdAt,
      receipt_number: "R-2026-0042", receipt_token: "tok_" + "a".repeat(40),
    });
    await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txnId, product_id: "px" as unknown as Id<"pos_products">,
      product_code_snapshot: "DUB8", product_name_snapshot: "Dubai 8pcs",
      unit_price_snapshot: 25_000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 25_000,
    });
    await ctx.db.insert("pos_xendit_invoices", {
      transaction_id: txnId, xendit_invoice_id: "qr-1", xendit_idempotency_key: "ik-1",
      method: "QRIS", qr_string: "0002...", status_at_create: "PENDING", created_at: createdAt,
    });
    return txnId;
  });
}

describe("getReceiptForPrint", () => {
  it("returns view-model + status label for a paid txn (staff, today)", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seedStaff(t, "staff");
    const txnId = await seedPaidTxn(t, staffId, Date.now());
    const res = await t.query(api.receipts.public.getReceiptForPrint, { sessionId, txnId });
    expect(res).not.toBeNull();
    expect(res!.viewModel.receipt_number).toBe("R-2026-0042");
    expect(res!.status).toBe("paid");
    expect(res!.statusLabel).toBe("LUNAS");
    // No token leaks through this seam (ADR-021):
    expect(JSON.stringify(res)).not.toContain("tok_");
  });

  it("returns null for an invalid session", async () => {
    const t = convexTest(schema);
    const { staffId } = await seedStaff(t, "staff");
    const txnId = await seedPaidTxn(t, staffId, Date.now());
    const fake = await t.run(async (ctx) => {
      const id = await ctx.db.insert("staff_sessions", {
        staff_id: staffId, device_id: "d", started_at: Date.now(),
        ended_at: Date.now(), end_reason: "lock",
      });
      return id;
    });
    const res = await t.query(api.receipts.public.getReceiptForPrint, { sessionId: fake, txnId });
    expect(res).toBeNull();
  });

  it("returns null for a staff member reading a txn outside server-today", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seedStaff(t, "staff");
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const txnId = await seedPaidTxn(t, staffId, twoDaysAgo);
    const res = await t.query(api.receipts.public.getReceiptForPrint, { sessionId, txnId });
    expect(res).toBeNull();
  });

  it("allows a manager to read an older txn", async () => {
    const t = convexTest(schema);
    const { staffId } = await seedStaff(t, "staff");
    const { sessionId: mgrSession } = await seedStaff(t, "manager");
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const txnId = await seedPaidTxn(t, staffId, twoDaysAgo);
    const res = await t.query(api.receipts.public.getReceiptForPrint, { sessionId: mgrSession, txnId });
    expect(res).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/receipts/__tests__/getReceiptForPrint.test.ts`
Expected: FAIL — `api.receipts.public.getReceiptForPrint` does not exist.

- [ ] **Step 3: Implement the query**

Create `convex/receipts/public.ts`:
```ts
import { query } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { wibDayWindow } from "../lib/time";
import {
  computeReceiptStatus,
  STATUS_LABELS,
  type ReceiptViewModel,
  type ReceiptStatus,
} from "./template";

/**
 * v0.5.4 — receipt data for in-app Bluetooth printing. Returns the structured
 * ReceiptViewModel (snapshot-safe, ADR-001) + a pre-derived status label.
 *
 * Scope mirrors transactions.public.getTransactionDetail:
 *   - manager: any paid txn
 *   - staff:   only txns whose created_at is within server-today (WIB)
 *   - null on invalid session / non-paid / out-of-scope (graceful UI degrade)
 *
 * Does NOT return receipt_token / URL — the QR token is minted via the
 * transactions.shareReceipt mutation (ADR-021 single-seam capability).
 */
export const getReceiptForPrint = query({
  args: { sessionId: v.id("staff_sessions"), txnId: v.id("pos_transactions") },
  handler: async (
    ctx,
    args,
  ): Promise<{ viewModel: ReceiptViewModel; status: ReceiptStatus; statusLabel: string } | null> => {
    const who = await ctx.runQuery(internal.auth.internal._resolveSessionRole_internal, {
      sessionId: args.sessionId,
    });
    if (!who) return null;

    // Staff-today scope (manager bypasses). Read created_at via transactions internal
    // surface (ADR-034) — receipts must not query pos_transactions directly.
    if (who.role !== "manager") {
      const txnMeta = await ctx.runQuery(
        internal.transactions.internal._getPaidTxnWithLinesForReceipt_internal,
        { transactionId: args.txnId },
      );
      if (!txnMeta) return null;
      const today = wibDayWindow(Date.now());
      if (txnMeta.txn.created_at < today.dayStartMs || txnMeta.txn.created_at >= today.dayEndMs) {
        return null;
      }
    }

    const vm = await ctx.runQuery(internal.receipts.internal._buildViewModel_internal, {
      transactionId: args.txnId,
    });
    if (!vm) return null;

    const status = computeReceiptStatus(vm);
    return { viewModel: vm, status, statusLabel: STATUS_LABELS[status].label };
  },
});
```

> **Verify in plan-review:** that `internal.transactions.internal._getPaidTxnWithLinesForReceipt_internal` returns `{ txn: { created_at, ... } }` (it does — used in `receipts/internal.ts:188`). If its return omits `created_at`, scope the staff check on `vm.paid_at` instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/receipts/__tests__/getReceiptForPrint.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add convex/receipts/public.ts convex/receipts/__tests__/getReceiptForPrint.test.ts
git commit -m "feat(receipts): getReceiptForPrint view-model query (role/today scoped, no token)"
```

---

## Task 3: ESC/POS encoder `src/lib/escpos.ts` (TDD golden)

> **Pre-req:** verify the `@point-of-sale/esc-pos-encoder` method names against its README (Assumption 1). Adjust the encoder calls below to match.

**Files:**
- Create: `src/lib/escpos.ts`
- Test: `src/lib/__tests__/escpos.test.ts`

- [ ] **Step 1: Write the failing golden test**

```ts
import { describe, it, expect } from "vitest";
import { encodeReceipt, SAMPLE_RECEIPT } from "../escpos";

describe("encodeReceipt", () => {
  it("produces bytes and embeds the receipt number + total (paid)", () => {
    const bytes = encodeReceipt(
      SAMPLE_RECEIPT.viewModel,
      SAMPLE_RECEIPT.status,
      SAMPLE_RECEIPT.statusLabel,
      "https://pos.example.com/r/tok_demo",
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(50);
    const text = new TextDecoder("ascii").decode(bytes);
    expect(text).toContain("R-2026-0042");
    expect(text).toContain("LUNAS");
    // Money formatted via src/lib/format.rp (no floats):
    expect(text).toContain("Rp 325.000");
    // No raw emoji bytes survive ASCII-fold:
    expect(text).not.toMatch(/[\u{1F000}-\u{1FAFF}]/u);
  });

  it("starts with the ESC @ init sequence", () => {
    const bytes = encodeReceipt(
      SAMPLE_RECEIPT.viewModel, SAMPLE_RECEIPT.status, SAMPLE_RECEIPT.statusLabel, "https://x/r/t",
    );
    expect(bytes[0]).toBe(0x1b); // ESC
    expect(bytes[1]).toBe(0x40); // @
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/escpos.test.ts`
Expected: FAIL — module `../escpos` not found.

- [ ] **Step 3: Implement the encoder + sample fixture**

Create `src/lib/escpos.ts`. (Confirm method names against the package; structure is fixed.)
```ts
import EscPosEncoder from "@point-of-sale/esc-pos-encoder";
import type { ReceiptViewModel, ReceiptStatus } from "../../convex/receipts/template";
import { rp, fmtDate, fmtTime } from "./format";

const COLS = 32; // 58mm @ Font A

/** Drop characters the thermal head can't render (emoji, etc.). */
function ascii(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "").trim();
}

/** Left text + right-aligned amount padded to COLS. */
function row(left: string, right: string): string {
  const l = ascii(left);
  const pad = Math.max(1, COLS - l.length - right.length);
  return l + " ".repeat(pad) + right;
}

export function encodeReceipt(
  vm: ReceiptViewModel,
  _status: ReceiptStatus,
  statusLabel: string,
  receiptUrl: string,
): Uint8Array {
  const e = new EscPosEncoder();
  e.initialize();

  e.align("center").bold(true).size(2, 2).line(ascii(vm.settings.business_name)).size(1, 1).bold(false);
  e.line(ascii(vm.settings.address));
  e.line(ascii(vm.settings.instagram_handle));
  e.line("-".repeat(COLS));
  e.line(`[ ${ascii(statusLabel)} ]`);
  e.align("left");
  e.line(row(vm.receipt_number, `${fmtDate(vm.paid_at)} ${fmtTime(vm.paid_at)}`));
  e.line("-".repeat(COLS));

  for (const l of vm.lines) {
    e.line(row(`${l.qty} x ${ascii(l.product_name)}`, rp(l.line_subtotal)));
    e.line(`  @ ${rp(l.unit_price)}`);
    if (l.refunded_qty > 0) e.line(`  -> ${l.refunded_qty} dari ${l.qty} dikembalikan`);
  }

  e.line("-".repeat(COLS));
  e.line(row("Subtotal", rp(vm.subtotal)));
  if (vm.voucher_discount > 0) {
    e.line(row(`Voucher (${ascii(vm.voucher_code ?? "-")})`, rp(-vm.voucher_discount)));
  }
  e.bold(true).size(1, 2).line(row("TOTAL", rp(vm.total))).size(1, 1).bold(false);

  if (vm.refunds.length > 0) {
    e.line("Pengembalian:");
    for (const r of vm.refunds) e.line(row(fmtDate(r.refunded_at), rp(-r.refund_amount)));
    const net = vm.total - vm.refunds.reduce((s, r) => s + r.refund_amount, 0);
    e.bold(true).line(row("NET DIBAYAR", rp(net))).bold(false);
  }

  e.line(`Dibayar via ${ascii(vm.payment_method)}`);
  if (vm.rrn) e.line(`RRN: ${ascii(vm.rrn)}`);

  e.align("center").qrcode(receiptUrl).line("Scan untuk struk digital");
  e.line("Terima kasih!");
  e.line(ascii(vm.settings.instagram_handle));
  e.newline().newline().newline();

  return e.encode();
}

/** Shared fixture — feeds golden tests AND useThermalPrinter.testPrint(). */
export const SAMPLE_RECEIPT: {
  viewModel: ReceiptViewModel;
  status: ReceiptStatus;
  statusLabel: string;
} = {
  status: "paid",
  statusLabel: "LUNAS",
  viewModel: {
    receipt_number: "R-2026-0042",
    paid_at: 1_780_000_000_000,
    subtotal: 325_000,
    voucher_discount: 0,
    total: 325_000,
    payment_method: "QRIS",
    lines: [
      { product_name: "Dubai 8pcs", qty: 2, unit_price: 120_000, line_subtotal: 240_000, refunded_qty: 0 },
      { product_name: "Mixed Box 4pcs", qty: 1, unit_price: 85_000, line_subtotal: 85_000, refunded_qty: 0 },
    ],
    refunds: [],
    settings: {
      business_name: "FROLLIE",
      address: "Pakuwon Mall, Surabaya",
      contact: "frollie.id",
      instagram_handle: "@frollie.id",
    },
  },
};
```

> **Note:** `SAMPLE_RECEIPT.viewModel.total` is 325.000 but lines sum to 325.000 — keep them consistent so the golden test's `Rp 325.000` assertion holds.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/escpos.test.ts`
Expected: PASS (2 tests). If method names differ, fix per the package README, then re-run.

- [ ] **Step 5: Commit**

```bash
git add src/lib/escpos.ts src/lib/__tests__/escpos.test.ts
git commit -m "feat(print): ESC/POS receipt encoder + sample fixture"
```

---

## Task 4: Pure `chunkBytes` + tests

The truncation/one-line failure mode lives in write chunking — make it a pure, tested function.

**Files:**
- Create: `src/hooks/__tests__/chunkBytes.test.ts`
- (function exported from `src/hooks/useThermalPrinter.ts` — created here, hook body in Task 5)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { chunkBytes } from "../useThermalPrinter";

describe("chunkBytes", () => {
  it("returns [] for empty input", () => {
    expect(chunkBytes(new Uint8Array(0), 20)).toEqual([]);
  });
  it("returns one chunk when smaller than size", () => {
    const out = chunkBytes(new Uint8Array([1, 2, 3]), 20);
    expect(out).toHaveLength(1);
    expect(Array.from(out[0])).toEqual([1, 2, 3]);
  });
  it("splits exactly on the boundary", () => {
    const out = chunkBytes(new Uint8Array([1, 2, 3, 4]), 2);
    expect(out).toHaveLength(2);
    expect(Array.from(out[1])).toEqual([3, 4]);
  });
  it("splits a remainder into a final short chunk", () => {
    const out = chunkBytes(new Uint8Array([1, 2, 3, 4, 5]), 2);
    expect(out).toHaveLength(3);
    expect(Array.from(out[2])).toEqual([5]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/hooks/__tests__/chunkBytes.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Create the file with the pure function**

Create `src/hooks/useThermalPrinter.ts` with just the export for now:
```ts
/** Split a byte stream into ≤ size chunks for BLE writeWithoutResponse. */
export function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.subarray(i, Math.min(i + size, bytes.length)));
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/hooks/__tests__/chunkBytes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useThermalPrinter.ts src/hooks/__tests__/chunkBytes.test.ts
git commit -m "feat(print): pure chunkBytes for BLE writes"
```

---

## Task 5: `useThermalPrinter` hook (BLE lifecycle)

No unit test (Web Bluetooth can't be mocked meaningfully); verified on-device. `chunkBytes` (Task 4) is the tested core.

**Files:**
- Modify: `src/hooks/useThermalPrinter.ts` (append below `chunkBytes`)

- [ ] **Step 1: Append the hook**

```ts
import { useCallback, useEffect, useRef, useState } from "react";

const PRINT_SERVICE = 0x18f0;
const PRINT_CHAR = 0x2af1;
const MTU = 180;            // conservative BLE payload; tune on-device
const PACE_MS = 20;         // gap between chunks so the buffer drains

export type PrinterStatus =
  | "unsupported" | "disconnected" | "connecting" | "connected" | "printing" | "error";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useThermalPrinter() {
  const [status, setStatus] = useState<PrinterStatus>(
    typeof navigator !== "undefined" && navigator.bluetooth ? "disconnected" : "unsupported",
  );
  const charRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const deviceRef = useRef<BluetoothDevice | null>(null);

  const bind = useCallback(async (device: BluetoothDevice) => {
    deviceRef.current = device;
    device.addEventListener("gattserverdisconnected", () => {
      charRef.current = null;
      setStatus("disconnected");
    });
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(PRINT_SERVICE);
    charRef.current = await service.getCharacteristic(PRINT_CHAR);
    setStatus("connected");
  }, []);

  // Auto-reconnect on mount via previously-granted devices (no picker).
  useEffect(() => {
    if (status === "unsupported") return;
    let cancelled = false;
    (async () => {
      try {
        const devices = await navigator.bluetooth.getDevices();
        const known = devices.find((d) => d.name === "BlueTooth Printer") ?? devices[0];
        if (known && !cancelled) {
          setStatus("connecting");
          await bind(known);
        }
      } catch {
        /* no grant yet — stay disconnected */
      }
    })();
    return () => { cancelled = true; };
  }, [status, bind]);

  const connect = useCallback(async () => {
    if (!navigator.bluetooth) return;
    setStatus("connecting");
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [PRINT_SERVICE] }, { namePrefix: "BlueTooth" }],
        optionalServices: [PRINT_SERVICE],
      });
      await bind(device);
    } catch {
      setStatus("disconnected"); // user cancelled chooser
    }
  }, [bind]);

  const disconnect = useCallback(() => {
    deviceRef.current?.gatt?.disconnect();
    charRef.current = null;
    setStatus("disconnected");
  }, []);

  const print = useCallback(async (bytes: Uint8Array) => {
    const ch = charRef.current;
    if (!ch) throw new Error("PRINTER_NOT_CONNECTED");
    setStatus("printing");
    try {
      for (const chunk of chunkBytes(bytes, MTU)) {
        await ch.writeValueWithoutResponse(chunk);
        await sleep(PACE_MS);
      }
      setStatus("connected");
    } catch (err) {
      setStatus("error");
      throw err;
    }
  }, []);

  return { status, connect, disconnect, print };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (web-bluetooth types resolve from Task 0).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useThermalPrinter.ts
git commit -m "feat(print): useThermalPrinter Web Bluetooth connect/auto-reconnect/print"
```

---

## Task 6: `PrinterSheet` component

**Files:**
- Create: `src/components/pos/PrinterSheet.tsx`

- [ ] **Step 1: Implement the sheet**

```tsx
import { Printer } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useThermalPrinter, type PrinterStatus } from "@/hooks/useThermalPrinter";
import { encodeReceipt, SAMPLE_RECEIPT } from "@/lib/escpos";

const LABEL: Record<PrinterStatus, string> = {
  unsupported: "Tidak didukung", disconnected: "Terputus", connecting: "Menghubungkan…",
  connected: "Terhubung", printing: "Mencetak…", error: "Error",
};

export function PrinterSheet() {
  const { status, connect, disconnect, print } = useThermalPrinter();

  const onTest = async () => {
    try {
      await print(encodeReceipt(
        SAMPLE_RECEIPT.viewModel, SAMPLE_RECEIPT.status, SAMPLE_RECEIPT.statusLabel,
        "https://frollie.id/r/contoh",
      ));
      toast.success("Tes cetak terkirim");
    } catch {
      toast.error("Gagal mencetak — periksa printer");
    }
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Printer">
          <Printer className={status === "connected" ? "text-teal-600" : "text-muted-foreground"} />
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom">
        <SheetHeader><SheetTitle>Printer struk</SheetTitle></SheetHeader>
        <div className="space-y-3 p-4">
          <div className="text-sm text-muted-foreground">Status: {LABEL[status]}</div>
          {status === "unsupported" ? (
            <p className="text-sm text-destructive">Browser ini tidak mendukung Bluetooth.</p>
          ) : status === "connected" || status === "printing" ? (
            <>
              <Button className="w-full" onClick={onTest} disabled={status === "printing"}>Tes cetak</Button>
              <Button className="w-full" variant="outline" onClick={disconnect}>Putuskan</Button>
            </>
          ) : (
            <Button className="w-full" onClick={connect} disabled={status === "connecting"}>
              Hubungkan printer
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

> **Verify in plan-review:** `src/components/ui/sheet.tsx` exists (shadcn). If absent, add via the project's shadcn setup before this task.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/pos/PrinterSheet.tsx
git commit -m "feat(print): PrinterSheet (connect + status + test print)"
```

---

## Task 7: Wire the print button into `charge-success`

**Files:**
- Modify: `src/routes/sale/charge-success.tsx`

- [ ] **Step 1: Add imports + hooks**

At the top of the component, add:
```tsx
import { useMutation } from "convex/react";
import { useSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import { useThermalPrinter } from "@/hooks/useThermalPrinter";
import { PrinterSheet } from "@/components/pos/PrinterSheet";
import { encodeReceipt } from "@/lib/escpos";
import { buildReceiptUrl } from "@/lib/format";
import { toast } from "sonner";
```

Inside `SaleChargeSuccess`, after the existing `result` query:
```tsx
const session = useSession();
const sessionId = session.status === "active" ? session.sessionId : undefined;
const { status: printerStatus, connect, print } = useThermalPrinter();
const shareReceipt = useMutation(api.transactions.shareReceipt);
const idemKey = useIdempotency(txnId ? `shareReceipt:${txnId}` : "share:none");

const printData = useQuery(
  api.receipts.public.getReceiptForPrint,
  sessionId && txnId ? { sessionId, txnId } : "skip",
);

const onPrint = async () => {
  if (!sessionId || !txnId || !idemKey || !printData) return;
  try {
    const { token } = await shareReceipt({ idempotencyKey: idemKey, sessionId, txnId });
    const bytes = encodeReceipt(
      printData.viewModel, printData.status, printData.statusLabel, buildReceiptUrl(token),
    );
    await print(bytes);
    toast.success("Struk dicetak");
  } catch {
    toast.error("Gagal mencetak struk");
  }
};
```

- [ ] **Step 2: Render the printer chip + print button**

Add the `PrinterSheet` to the success screen header area, and a print button below "New sale" (only in the paid branch). Example, inside the paid `return`, before the "New sale" button:
```tsx
<Button
  className="w-full max-w-xs"
  size="lg"
  variant="outline"
  onClick={onPrint}
  disabled={printerStatus === "printing" || printerStatus === "unsupported" || !printData}
>
  {printerStatus === "connected" || printerStatus === "printing" ? "Cetak struk" : "Hubungkan & cetak"}
</Button>
```
And mount `<PrinterSheet />` in the header (e.g., pass as `SpokeLayout`/`AppHeader` `rightSlot` if available on this screen; otherwise place near the success mark).

> If `printerStatus` is `disconnected`, `onPrint` will fail at `print()`; gate the button label to call `connect()` first when disconnected:
```tsx
onClick={printerStatus === "connected" ? onPrint : connect}
```

- [ ] **Step 3: Typecheck + build + smoke**

Run: `npm run typecheck && npm run build`
Expected: PASS.
Run existing route tests: `npx vitest run src/routes/sale/charge-success.test.tsx`
Expected: PASS (additive change shouldn't break existing assertions; update the test if it snapshots the button list).

- [ ] **Step 4: Commit**

```bash
git add src/routes/sale/charge-success.tsx
git commit -m "feat(print): print receipt button + printer sheet on charge-success"
```

---

## Task 8: ADR, docs, PROGRESS, CHANGELOG

**Files:**
- Create: `docs/ADR/043-web-bluetooth-escpos-printing.md`
- Modify: `docs/API_REFERENCE.md`, `docs/CHANGELOG.md`, `docs/PROGRESS.md`, `CLAUDE.md`

- [ ] **Step 1: Write ADR-043**

Create `docs/ADR/043-web-bluetooth-escpos-printing.md` covering: context (EP5811AI dual-mode BLE, service `0x18f0`/char `0x2af1`); decision (client-side Web Bluetooth + `@point-of-sale/esc-pos-encoder`, text mode, QR via existing `shareReceipt` token, no token through query seam per ADR-021); not audited (read-only); fallbacks (raster QR, ISSC service); consequences (Android-Chrome only).

- [ ] **Step 2: API_REFERENCE entry**

Add to `docs/API_REFERENCE.md` under receipts: `getReceiptForPrint(sessionId, txnId) → { viewModel, status, statusLabel } | null` — role/today scoped, no token.

- [ ] **Step 3: CHANGELOG entry**

```markdown
## v0.5.4 — Bluetooth thermal receipt printing
- Print 58mm receipts to the EPPOS EP5811AI over Web Bluetooth (ESC/POS), one tap on sale-complete.
- Printer auto-reconnects (Web Bluetooth getDevices); connect/test-print via printer sheet.
- New query receipts.getReceiptForPrint (view-model only; QR token via existing shareReceipt). ADR-043.
```

- [ ] **Step 4: PROGRESS.md v0.5.4 phase**

Add a `## v0.5.4 — Bluetooth thermal receipt printing` phase header with be/fe/xc lanes and Task IDs (`v054-be-print-query`, `v054-fe-escpos`, `v054-fe-printer-hook`, `v054-fe-print-ui`, `v054-xc-adr043`). Then regenerate: `npx ceo-report build --src docs/PROGRESS.md --out docs/progress.html`.

- [ ] **Step 5: CLAUDE.md file-locations**

Add `src/lib/escpos.ts`, `src/hooks/useThermalPrinter.ts`, `src/components/pos/PrinterSheet.tsx` to the `src/` table and ADR-043 to the business-rules/ADR references.

- [ ] **Step 6: Commit**

```bash
git add docs/ADR/043-web-bluetooth-escpos-printing.md docs/API_REFERENCE.md docs/CHANGELOG.md docs/PROGRESS.md docs/progress.html CLAUDE.md
git commit -m "docs(v0.5.4): ADR-043 + API ref + CHANGELOG + PROGRESS + file locations"
```

---

## On-device verification checklist (manual, post-merge, on the Android booth device)

- [ ] First connect: tap "Hubungkan printer" → chooser shows the printer → connects.
- [ ] Auto-reconnect: reload the PWA → printer reconnects with no chooser.
- [ ] Print a real paid receipt → full length, no truncation, lines not collapsed.
- [ ] QR on paper scans → opens `/r/<token>` digital receipt.
- [ ] Test print from the sheet works with no active sale.
- [ ] Native QR vs raster QR decision recorded (Assumption 2).

---

## Final verification before declaring done

Run: `npm run typecheck && npm run build && npx vitest run`
Expected: all green. Then the on-device checklist.

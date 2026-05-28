# Xendit Dedicated-API Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make QRIS and BCA VA payments work end-to-end with inline rendering by switching QRIS to the Xendit QR Codes API and BCA VA to the Virtual Accounts (FVA) API, fixing the webhook parse, retiring the dead polling/reconciliation paths, and capturing amount/RRN — all behind one deep adapter.

**Architecture:** A single deep adapter module (`convex/payments/xendit.ts`) hides every Xendit protocol detail (endpoints, the `api-version` header, Basic auth, request bodies, response mapping, and the two distinct webhook envelopes) behind a narrow surface. The action (`actions.ts`) and webhook (`webhook.ts`) become thin callers. The proven `_confirmPaid_internal` funnel is reused unchanged except for one additive `paid_amount` arg that flags amount mismatches. No breaking schema change (two additive optional columns + one new flag bit).

**Tech Stack:** Convex 1.31.7 (actions/httpActions/internalMutations), TypeScript, `convex-test` + Vitest, React 19 + `qrcode.react`@^4, Xendit QR Codes API (`POST /qr_codes`) + Virtual Accounts API (`POST /callback_virtual_accounts`).

**Spec:** [`docs/superpowers/specs/2026-05-28-xendit-dedicated-apis-design.md`](../specs/2026-05-28-xendit-dedicated-apis-design.md) (staffreview applied). **Diagnostic:** [`docs/xendit-reference/`](../../xendit-reference/).

---

## CRITICAL implementation notes (read before Task 1)

1. **`Buffer`, not `btoa`, for auth.** The spec text said `btoa`, copying the reference — but the reference's action was *not* `"use node"`, whereas FrolliePOS's `convex/payments/actions.ts` IS `"use node"` (it needs argon2 for the manual-override path). Convex's node runtime provides `Buffer` and **drops `btoa`**; the default runtime is the opposite. `createQrisCharge`/`createBcaVaCharge` only ever *run* from the node action, so they must use `Buffer`. The webhook (default runtime) imports `xendit.ts` but only *calls* `parseXenditWebhook` (pure JSON) — the `Buffer`-using functions are imported-but-never-evaluated there, which is safe because JS does not evaluate function bodies on import. **`xendit.ts` must NOT carry a `"use node"` directive** (so the default-runtime webhook can import it).

2. **The `api-version: 2022-07-31` header is load-bearing and silently fails.** Without it the `qr.payment` webhook never fires — QR renders, build passes, no payment ever detected. It is asserted by a dedicated test (Task 1) precisely so a future edit that drops it fails loudly.

3. **Keep the `"polling"` literal** in `_confirmPaid_internal`'s `source` union. We remove the polling *runtime* (the GET action + the hook loop), not the enum label — an existing test uses `source: "polling"` to exercise idempotent re-fire, and a future working-endpoint reconciliation may reuse it. Removing the literal would be churn for no gain.

4. **Match key is the provider id.** Store the QR Codes `id` (and later the FVA `id`) in the existing `xendit_invoice_id` column; the `by_xendit_invoice_id` index *is* the webhook match index. No new index.

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `convex/payments/xendit.ts` | **Deep adapter** — all Xendit protocol behind a narrow surface | **Create** |
| `convex/payments/__tests__/xendit.test.ts` | Pure unit tests for the adapter (no Convex runtime) | **Create** |
| `convex/payments/actions.ts` | Thin: auth + idempotency + adapter call + commit | Modify (gut `xenditPost`/`xenditGet`, branch on method, remove `checkInvoiceStatus`) |
| `convex/payments/webhook.ts` | Thin: token verify + `parseXenditWebhook` + funnel | Modify (rewrite parse, 401-on-missing-config, always-200) |
| `convex/payments/internal.ts` | Commit + paid-webhook funnel | Modify (`_onPaidWebhook` threads amount/RRN; remove `_onPaidPolling`) |
| `convex/payments/schema.ts` | `pos_xendit_invoices` table | Modify (+`receipt_id?`, +`payment_source?`) |
| `convex/transactions/flags.ts` | Bitset flags | Modify (+`PAYMENT_AMOUNT_MISMATCH = 1<<2`) |
| `convex/transactions/internal.ts` | `_confirmPaid_internal` funnel | Modify (+optional `paid_amount`, flag mismatch) |
| `convex/transactions/actions.ts` | `cancelTransaction` | Modify (remove invalid `/invoices/{id}/expire!`) |
| `convex/payments/__tests__/webhook.test.ts` | Webhook handler tests | Rewrite (new shape, 401-missing-config) |
| `convex/payments/__tests__/actions.test.ts` | Action tests | Modify (QRIS→`/qr_codes`; BCA→FVA in Task 5) |
| `convex/transactions/__tests__/confirmPaid.test.ts` | Funnel tests | Add amount-mismatch cases |
| `src/hooks/useXenditPayment.ts` | Charge-screen reactive phase | Modify (remove polling loop) |
| `src/hooks/useStartupReconciliation.ts` | ADR-026 reconciliation | Modify (gut the poll → no-op shell) |
| `src/routes/sale/charge.tsx` | Charge UI | Modify (render real QR) |
| `package.json` | deps | Modify (+`qrcode.react`@^4) |
| `docs/ADR/036-*.md`, ADR-011/014/026/§8, `docs/ADR/README.md`, `CLAUDE.md`, `docs/SCHEMA.md`, `docs/CHANGELOG.md` | docs | Modify (Task 6) |

---

## Task 1: Deep adapter — QRIS create, header, body, webhook parser (+ pure tests)

**Files:**
- Create: `convex/payments/xendit.ts`
- Create: `convex/payments/__tests__/xendit.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `convex/payments/__tests__/xendit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildQrisBody,
  buildQrisHeaders,
  buildBcaVaBody,
  parseXenditWebhook,
} from "../xendit";

beforeEach(() => {
  process.env.XENDIT_SECRET_KEY = "xnd_test_fake";
});

describe("buildQrisHeaders", () => {
  it("pins api-version 2022-07-31 (regression guard — dropping it silently kills the webhook)", () => {
    const h = buildQrisHeaders("idem-1");
    expect(h["api-version"]).toBe("2022-07-31");
    expect(h["X-IDEMPOTENCY-KEY"]).toBe("idem-1");
    expect(h.Authorization).toMatch(/^Basic /);
  });
});

describe("buildQrisBody", () => {
  it("builds a DYNAMIC IDR QR body echoing ref as reference_id + external_id", () => {
    expect(buildQrisBody("pos-abc", 35000)).toEqual({
      reference_id: "pos-abc",
      external_id: "pos-abc",
      type: "DYNAMIC",
      currency: "IDR",
      amount: 35000,
    });
  });
});

describe("buildBcaVaBody", () => {
  it("builds a closed single-use exact-amount BCA VA body", () => {
    expect(buildBcaVaBody("pos-xyz", 50000)).toEqual({
      external_id: "pos-xyz",
      bank_code: "BCA",
      name: "Frollie POS",
      expected_amount: 50000,
      is_closed: true,
      is_single_use: true,
    });
  });
});

describe("parseXenditWebhook", () => {
  it("QRIS SUCCEEDED envelope → paid, matchKey=qr_id, amount + reconciliation fields", () => {
    const body = JSON.stringify({
      event: "qr.payment",
      data: {
        id: "qr_inner",
        qr_id: "qr_123",
        status: "SUCCEEDED",
        amount: 35000,
        payment_detail: { receipt_id: "RRN-1", source: "DANA" },
      },
    });
    expect(parseXenditWebhook(body)).toEqual({
      paid: true,
      matchKey: "qr_123",
      amount: 35000,
      receiptId: "RRN-1",
      source: "DANA",
    });
  });

  it("QRIS non-SUCCEEDED status → not paid", () => {
    const body = JSON.stringify({ event: "qr.payment", data: { qr_id: "qr_9", status: "PENDING" } });
    expect(parseXenditWebhook(body)).toEqual({ paid: false, matchKey: null });
  });

  it("BCA flat FVA callback → paid, matchKey=callback_virtual_account_id (live-unverified shape)", () => {
    const body = JSON.stringify({
      callback_virtual_account_id: "va_456",
      external_id: "pos-xyz",
      account_number: "1080012345",
      amount: 50000,
      payment_id: "pay_1",
    });
    expect(parseXenditWebhook(body)).toEqual({
      paid: true,
      matchKey: "va_456",
      amount: 50000,
      receiptId: "pay_1",
    });
  });

  it("legacy flat Invoice shape {id,status:PAID} is now ignored", () => {
    expect(parseXenditWebhook(JSON.stringify({ id: "inv_1", status: "PAID" }))).toEqual({
      paid: false,
      matchKey: null,
    });
  });

  it("unparseable / empty → not paid, no match key", () => {
    expect(parseXenditWebhook("not json")).toEqual({ paid: false, matchKey: null });
    expect(parseXenditWebhook("")).toEqual({ paid: false, matchKey: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/payments/__tests__/xendit.test.ts`
Expected: FAIL — `Cannot find module '../xendit'` (file not created yet).

- [ ] **Step 3: Create the adapter**

Create `convex/payments/xendit.ts` (NO `"use node"` directive — see CRITICAL note 1):

```ts
// Deep Xendit adapter (ADR-034). Narrow surface; all Xendit protocol detail —
// endpoints, the api-version header, Basic auth, request bodies, response
// mapping, and the two distinct webhook envelopes — is hidden here.
//
// Runtime: NO "use node" directive. The create functions use Buffer (Convex's
// node runtime, where the "use node" actions.ts runs them, provides Buffer and
// drops btoa). The default-runtime webhook imports this module but only CALLS
// parseXenditWebhook (pure JSON) — the Buffer-using functions are imported but
// never evaluated there, which is safe (JS does not evaluate function bodies on
// import). No top-level side effects: env/fetch/Buffer are referenced only
// inside function bodies.

const XENDIT_BASE = "https://api.xendit.co";
const XENDIT_QR_API_VERSION = "2022-07-31";

export type ChargeResult = {
  providerId: string;
  qrString?: string;
  vaNumber?: string;
  statusAtCreate: string;
};

export type WebhookParse = {
  paid: boolean;
  matchKey: string | null;
  amount?: number;
  receiptId?: string;
  source?: string;
};

/** Basic auth: secret key as username, EMPTY password. Buffer (node runtime). */
function authHeader(): string {
  const key = process.env.XENDIT_SECRET_KEY;
  if (!key) throw new Error("XENDIT_SECRET_KEY not set");
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

/** QR-create headers. Exported so a test can assert api-version is present. */
export function buildQrisHeaders(idempotencyKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: authHeader(),
    "api-version": XENDIT_QR_API_VERSION,
    "X-IDEMPOTENCY-KEY": idempotencyKey,
  };
}

export function buildQrisBody(ref: string, amount: number) {
  return {
    reference_id: ref,
    external_id: ref,
    type: "DYNAMIC" as const,
    currency: "IDR" as const,
    amount,
  };
}

export function buildBcaVaBody(ref: string, amount: number) {
  return {
    external_id: ref,
    bank_code: "BCA" as const,
    name: "Frollie POS",
    expected_amount: amount,
    is_closed: true,
    is_single_use: true,
  };
}

/** Create an inline QRIS dynamic QR. Returns the provider id + raw qr_string. */
export async function createQrisCharge(
  ref: string,
  amount: number,
  idempotencyKey: string,
): Promise<ChargeResult> {
  const res = await fetch(`${XENDIT_BASE}/qr_codes`, {
    method: "POST",
    headers: buildQrisHeaders(idempotencyKey),
    body: JSON.stringify(buildQrisBody(ref, amount)),
  });
  if (!res.ok) {
    throw new Error(`XENDIT_QR_FAILED: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { id: string; qr_string: string; status?: string };
  return { providerId: json.id, qrString: json.qr_string, statusAtCreate: json.status ?? "ACTIVE" };
}

/** Create a closed single-use BCA Fixed VA. LIVE-UNVERIFIED (Decision C). */
export async function createBcaVaCharge(
  ref: string,
  amount: number,
  idempotencyKey: string,
): Promise<ChargeResult> {
  const res = await fetch(`${XENDIT_BASE}/callback_virtual_accounts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
      "X-IDEMPOTENCY-KEY": idempotencyKey,
    },
    body: JSON.stringify(buildBcaVaBody(ref, amount)),
  });
  if (!res.ok) {
    throw new Error(`XENDIT_VA_FAILED: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { id: string; account_number: string; status?: string };
  return { providerId: json.id, vaNumber: json.account_number, statusAtCreate: json.status ?? "PENDING" };
}

/**
 * Pure webhook parser. Discriminates the two Xendit envelopes that hit our
 * single endpoint and extracts the match key + amount + reconciliation fields.
 *  - BCA VA (live-unverified): flat FVA callback — no `event`, arrival = paid.
 *  - QRIS (reference-proven): { event: "qr.payment", data: { status, qr_id } }.
 *  - Anything else (incl. the legacy flat Invoice {id,status:"PAID"}) → ignored.
 */
export function parseXenditWebhook(rawBody: string): WebhookParse {
  let p: any;
  try {
    p = JSON.parse(rawBody);
  } catch {
    return { paid: false, matchKey: null };
  }
  if (!p || typeof p !== "object") return { paid: false, matchKey: null };

  // BCA VA — flat FVA payment callback (no event envelope; arrival = paid).
  if (p.callback_virtual_account_id && p.event === undefined) {
    return {
      paid: true,
      matchKey: p.callback_virtual_account_id,
      amount: p.amount,
      receiptId: p.payment_id,
    };
  }

  // QRIS — QR Codes v2 envelope (or a bare data object as a fallback).
  const d = p.data ?? p;
  const paid = d.status === "SUCCEEDED" || d.status === "COMPLETED";
  if (paid) {
    return {
      paid: true,
      matchKey: d.qr_id ?? d.id ?? null,
      amount: d.amount,
      receiptId: d.payment_detail?.receipt_id,
      source: d.payment_detail?.source,
    };
  }
  return { paid: false, matchKey: null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/payments/__tests__/xendit.test.ts`
Expected: PASS (all 8 cases green).

- [ ] **Step 5: Commit**

```bash
git add convex/payments/xendit.ts convex/payments/__tests__/xendit.test.ts
git commit -m "feat(v0.3): xendit QR Codes adapter (inline QRIS) + webhook parser"
```

---

## Task 2: Schema columns + amount-mismatch flag + funnel `paid_amount`

**Files:**
- Modify: `convex/payments/schema.ts`
- Modify: `convex/transactions/flags.ts`
- Modify: `convex/transactions/internal.ts` (`_confirmPaid_internal`)
- Test: `convex/transactions/__tests__/confirmPaid.test.ts`

- [ ] **Step 1: Add the additive schema columns**

In `convex/payments/schema.ts`, inside `pos_xendit_invoices` after the `va_number` line, add the two optional columns and a dual-meaning comment on `xendit_invoice_id`:

```ts
    xendit_invoice_id: v.string(),               // QR Codes `id` (QRIS) OR FVA `id` (BCA) — dedup/match key for webhook
    xendit_idempotency_key: v.string(),
    method: v.union(v.literal("QRIS"), v.literal("BCA_VA")),

    qr_string: v.optional(v.string()),
    va_number: v.optional(v.string()),
    receipt_id: v.optional(v.string()),          // bank RRN from the paid webhook — Frollie Pro settlement join key
    payment_source: v.optional(v.string()),      // paying wallet/bank (DANA/OVO/BCA)
```

- [ ] **Step 2: Add the new flag bit**

In `convex/transactions/flags.ts`, replace the placeholder comment line:

```ts
export const NEG_STOCK = 1 << 0;
export const VOUCHER_OVER_REDEEMED = 1 << 1;
export const PAYMENT_AMOUNT_MISMATCH = 1 << 2;
```

- [ ] **Step 3: Write the failing funnel test**

In `convex/transactions/__tests__/confirmPaid.test.ts`, add after the existing `import` block the new flag to the existing flags import, then add two cases inside the `describe("_confirmPaid_internal funnel", ...)` block. First update the flags import at the top of the file (it currently imports `VOUCHER_OVER_REDEEMED`):

```ts
import { VOUCHER_OVER_REDEEMED, PAYMENT_AMOUNT_MISMATCH } from "../flags";
```

Then add these cases:

```ts
  it("paid_amount mismatch: honors payment but sets PAYMENT_AMOUNT_MISMATCH flag", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaiting(t); // seeds total = 25_000 (see helper)
    await t.mutation(internal.transactions.internal._confirmPaid_internal, {
      txnId: s.txn, source: "webhook", paid_amount: 24_000,
    });
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("paid");
    expect(txn!.flags & PAYMENT_AMOUNT_MISMATCH).toBe(PAYMENT_AMOUNT_MISMATCH);
  });

  it("paid_amount matching total: no mismatch flag", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaiting(t);
    await t.mutation(internal.transactions.internal._confirmPaid_internal, {
      txnId: s.txn, source: "webhook", paid_amount: 25_000,
    });
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("paid");
    expect(txn!.flags & PAYMENT_AMOUNT_MISMATCH).toBe(0);
  });
```

> Note: `seedTxnAwaiting` seeds a txn with `total: 25_000` (confirm this in the helper at the top of `confirmPaid.test.ts`; if it differs, set `paid_amount` relative to that helper's total).

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run convex/transactions/__tests__/confirmPaid.test.ts -t "paid_amount"`
Expected: FAIL — `_confirmPaid_internal` rejects the unknown `paid_amount` arg (ArgumentValidationError) or the flag is never set.

- [ ] **Step 5: Add `paid_amount` to the funnel**

In `convex/transactions/internal.ts`:

(a) extend the flags import:

```ts
import { NEG_STOCK, VOUCHER_OVER_REDEEMED, PAYMENT_AMOUNT_MISMATCH, withFlag } from "./flags";
```

(b) add the arg to `_confirmPaid_internal`:

```ts
  args: {
    txnId: v.id("pos_transactions"),
    source: v.union(v.literal("webhook"), v.literal("polling"), v.literal("manual")),
    mgr_approver_id: v.optional(v.id("staff")),
    manual_reason: v.optional(v.string()),
    paid_amount: v.optional(v.number()),
  },
```

(c) after the NEG_STOCK re-check block (the `let flags = txn.flags; ... ` block ending around the voucher section) and BEFORE the voucher redemption block, insert the mismatch check:

```ts
    // Amount-mismatch defense (honor + flag): the money already moved, so we
    // always confirm — but flag a mismatch for manager reconciliation. DYNAMIC
    // QR + is_closed FVA make this unlikely, but this is a money path.
    if (args.paid_amount !== undefined && args.paid_amount !== txn.total) {
      flags = withFlag(flags, PAYMENT_AMOUNT_MISMATCH);
    }
```

- [ ] **Step 6: Run the funnel tests to verify pass**

Run: `npx vitest run convex/transactions/__tests__/confirmPaid.test.ts`
Expected: PASS (new mismatch cases + all existing cases, which omit `paid_amount` and so are unaffected).

- [ ] **Step 7: Push the schema to verify it compiles/deploys**

Run: `npx convex dev --once`
Expected: schema validates, indexes build, no type errors (additive optional fields are backward-compatible).

- [ ] **Step 8: Commit**

```bash
git add convex/payments/schema.ts convex/transactions/flags.ts convex/transactions/internal.ts convex/transactions/__tests__/confirmPaid.test.ts
git commit -m "feat(v0.3): additive RRN/source columns + PAYMENT_AMOUNT_MISMATCH flag in funnel"
```

---

## Task 3: Thin the QRIS create action onto the adapter

**Files:**
- Modify: `convex/payments/actions.ts` (`requestPayment` QRIS branch; remove `xenditPost`/`xenditGet` usage for QRIS; remove `checkInvoiceStatus`)
- Test: `convex/payments/__tests__/actions.test.ts`

> The BCA branch and the `retryWithFreshInvoice`/`cancelTransaction` Xendit-call removal are Tasks 5 and 4 respectively. This task makes the QRIS happy path call `/qr_codes`.

- [ ] **Step 1: Update the QRIS action test to expect `/qr_codes` + api-version**

In `convex/payments/__tests__/actions.test.ts`, change the first test's assertions (the `QRIS: posts to Xendit ...` case) to assert the new endpoint + header. Replace its `const calls = ...` assertion block with:

```ts
    const calls = _xenditMockCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/qr_codes");
    expect(calls[0].headers["api-version"]).toBe("2022-07-31");
    expect(calls[0].headers["X-IDEMPOTENCY-KEY"]).toBe(key);
    expect(calls[0].body.type).toBe("DYNAMIC");
    expect(calls[0].body.reference_id).toBe(`pos-${s.txn}`);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/payments/__tests__/actions.test.ts -t "QRIS: posts"`
Expected: FAIL — current code calls `/v2/invoices`, no `api-version` header.

- [ ] **Step 3: Rewrite `requestPayment` to use the adapter**

In `convex/payments/actions.ts`: add the adapter import at the top, delete the `xenditPost`/`xenditGet`/`readJson`/`XenditInvoiceResponse`/`XENDIT_BASE` helpers (they are replaced by the adapter — `retryWithFreshInvoice` still references `xenditPost`, so keep those helpers until Task 4/5; **for this task, only add the import and rewrite the `requestPayment` HTTP block**). Add near the existing imports:

```ts
import { createQrisCharge, createBcaVaCharge } from "./xendit";
```

Replace the `requestPayment` handler's step 3 + step 4 (the `payload` object, the `xenditPost(...)` call, and the `runMutation(... _persistInvoiceCommit ...)` return) with:

```ts
    // 3. Mint the charge via the deep adapter (QR Codes for QRIS, FVA for BCA).
    const ref = `pos-${args.txnId}`;
    const charge =
      args.method === "QRIS"
        ? await createQrisCharge(ref, txn.total, args.idempotencyKey)
        : await createBcaVaCharge(ref, txn.total, args.idempotencyKey);

    // 4. Commit invoice + cache row atomically (returns the full action response).
    return await ctx.runMutation(
      internal.payments.internal._persistInvoiceCommit_internal,
      {
        idempotencyKey: args.idempotencyKey,
        txnId: args.txnId,
        xendit_invoice_id: charge.providerId,
        xendit_idempotency_key: args.idempotencyKey,
        method: args.method,
        qr_string: charge.qrString,
        va_number: charge.vaNumber,
        status_at_create: charge.statusAtCreate,
      },
    );
```

- [ ] **Step 4: Remove the now-dead `checkInvoiceStatus` action**

Delete the entire `checkInvoiceStatus` export from `convex/payments/actions.ts` (the `action({ args: { invoiceId }, ... })` block that does `xenditGet("/v2/invoices/...")`). It is replaced by webhook-only confirmation (Decision B). Its consumers are removed in Task 4 (hooks).

> After this step `xenditGet` is unused; `retryWithFreshInvoice` still uses `xenditPost` (handled in Task 5). Delete `xenditGet` + `readJson` now only if no other reference remains — otherwise leave them for Task 5. Run `npx tsc --noEmit` to check for unused-symbol errors and remove whatever is genuinely unreferenced.

- [ ] **Step 5: Run the QRIS action test to verify pass**

Run: `npx vitest run convex/payments/__tests__/actions.test.ts -t "QRIS"`
Expected: PASS for the QRIS cases. (BCA cases in this file will fail — they still expect `/v2/invoices`; they are fixed in Task 5. The `checkInvoiceStatus` test, if any, is removed in this task — delete it.)

- [ ] **Step 6: Commit**

```bash
git add convex/payments/actions.ts convex/payments/__tests__/actions.test.ts
git commit -m "refactor(v0.3): thin requestPayment onto the xendit adapter; drop checkInvoiceStatus"
```

---

## Task 4: Rewire the webhook + funnel; retire polling & reconciliation

**Files:**
- Modify: `convex/payments/webhook.ts` (rewrite parse + 401-on-missing-config + always-200)
- Modify: `convex/payments/internal.ts` (`_onPaidWebhook_internal` threads amount/RRN; remove `_onPaidPolling_internal`)
- Modify: `src/hooks/useXenditPayment.ts` (remove polling loop)
- Modify: `src/hooks/useStartupReconciliation.ts` (gut the poll)
- Modify: `convex/transactions/actions.ts` (remove invalid `expire!`)
- Test: `convex/payments/__tests__/webhook.test.ts` (rewrite), `convex/payments/__tests__/onPaidPaths.test.ts`

- [ ] **Step 1: Rewrite the webhook handler tests for the new shape**

Replace the body of `convex/payments/__tests__/webhook.test.ts` test cases. Keep the `seedAwaitingWithInvoice` helper (it inserts `xendit_invoice_id`). Replace the three `it(...)` cases with:

```ts
describe("payments/webhook", () => {
  it("rejects request without matching x-callback-token (401)", async () => {
    const t = convexTest(schema);
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "wrong" },
      body: JSON.stringify({ event: "qr.payment", data: { qr_id: "x", status: "SUCCEEDED" } }),
    });
    expect(r.status).toBe(401);
  });

  it("missing token config → 401 (behavior change from 500)", async () => {
    const t = convexTest(schema);
    delete process.env.XENDIT_CALLBACK_TOKEN;
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "anything" },
      body: JSON.stringify({ event: "qr.payment", data: { qr_id: "x", status: "SUCCEEDED" } }),
    });
    expect(r.status).toBe(401);
    process.env.XENDIT_CALLBACK_TOKEN = "tok-test"; // restore for later tests
  });

  it("valid QRIS SUCCEEDED webhook funnels to paid + records receipt_id/source", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithInvoice(t, "qr_wh");
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test" },
      body: JSON.stringify({
        event: "qr.payment",
        data: {
          qr_id: "qr_wh", status: "SUCCEEDED", amount: 25_000,
          payment_detail: { receipt_id: "RRN-9", source: "OVO" },
        },
      }),
    });
    expect(r.status).toBe(200);
    const after = await t.run(async (ctx) => {
      const txn = await ctx.db.get(s.txn);
      const inv = await ctx.db
        .query("pos_xendit_invoices")
        .withIndex("by_xendit_invoice_id", (q) => q.eq("xendit_invoice_id", "qr_wh"))
        .first();
      return { txn, inv };
    });
    expect(after.txn?.status).toBe("paid");
    expect(after.txn?.confirmed_via).toBe("webhook");
    expect(after.inv?.receipt_id).toBe("RRN-9");
    expect(after.inv?.payment_source).toBe("OVO");
  });

  it("bad JSON → 200 no-op (avoids Xendit retry loop)", async () => {
    const t = convexTest(schema);
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test" },
      body: "{not json",
    });
    expect(r.status).toBe(200);
  });

  it("unmatched matchKey → 200 (silent drop)", async () => {
    const t = convexTest(schema);
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test" },
      body: JSON.stringify({ event: "qr.payment", data: { qr_id: "nope", status: "SUCCEEDED" } }),
    });
    expect(r.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/payments/__tests__/webhook.test.ts`
Expected: FAIL — current handler validates the old flat shape and 500s on missing config.

- [ ] **Step 3: Rewrite the webhook handler**

Replace the full contents of `convex/payments/webhook.ts`:

```ts
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { parseXenditWebhook } from "./xendit";

/** Constant-time compare; folds any length difference into the diff (I2). */
function tokenMatches(received: string, expected: string): boolean {
  let diff = received.length ^ expected.length;
  const max = Math.max(received.length, expected.length);
  for (let i = 0; i < max; i++) {
    diff |= (received.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Inbound Xendit webhook (QR Codes `qr.payment` + FVA payment callbacks share
 * this endpoint). Token-verified; missing config OR mismatch → 401 (the only
 * response that makes Xendit redeliver, and both self-heal once the token is
 * fixed). Shape parsing is delegated to the adapter's parseXenditWebhook; the
 * paid mutation is wrapped so a throw never becomes a 500 (a non-2xx on a post-
 * record error creates a permanent retry loop). Always 200 otherwise.
 */
export const xenditWebhook = httpAction(async (ctx, request) => {
  const expected = process.env.XENDIT_CALLBACK_TOKEN;
  const received = request.headers.get("x-callback-token") ?? "";
  if (!expected || !tokenMatches(received, expected)) {
    return new Response("unauthorized", { status: 401 });
  }

  const raw = await request.text();
  const { paid, matchKey, amount, receiptId, source } = parseXenditWebhook(raw);

  if (paid && matchKey) {
    try {
      await ctx.runMutation(internal.payments.internal._onPaidWebhook_internal, {
        xendit_invoice_id: matchKey,
        paid_amount: amount,
        receipt_id: receiptId,
        payment_source: source,
      });
    } catch (err) {
      // A mutation throw must never become a 500 (retry-storm guard).
      console.log("[xendit] webhook mutation error:", err);
    }
  }

  return new Response("ok", { status: 200 });
});
```

- [ ] **Step 4: Thread amount/RRN through `_onPaidWebhook_internal`; remove polling**

In `convex/payments/internal.ts`:

(a) replace the `_resolveAndConfirm` helper + the two paid-path exports (`_onPaidWebhook_internal`, `_onPaidPolling_internal`) with:

```ts
/**
 * Resolve a Xendit provider id (QR id / FVA id) → invoice row → txn, record the
 * reconciliation fields on the payments-owned invoice row, then funnel to
 * _confirmPaid_internal threading paid_amount for the mismatch flag. Unknown id
 * → silent drop. Idempotent because the funnel status-guards.
 */
async function _resolveAndConfirm(
  ctx: MutationCtx,
  xenditInvoiceId: string,
  extra: { paid_amount?: number; receipt_id?: string; payment_source?: string },
): Promise<void> {
  const inv = await ctx.db
    .query("pos_xendit_invoices")
    .withIndex("by_xendit_invoice_id", (q) => q.eq("xendit_invoice_id", xenditInvoiceId))
    .first();
  if (!inv) return;
  if (extra.receipt_id !== undefined || extra.payment_source !== undefined) {
    await ctx.db.patch(inv._id, {
      ...(extra.receipt_id !== undefined ? { receipt_id: extra.receipt_id } : {}),
      ...(extra.payment_source !== undefined ? { payment_source: extra.payment_source } : {}),
    });
  }
  await ctx.runMutation(internal.transactions.internal._confirmPaid_internal, {
    txnId: inv.transaction_id,
    source: "webhook",
    paid_amount: extra.paid_amount,
  });
}

/** Webhook path (primary — and now the sole automatic confirmation path). */
export const _onPaidWebhook_internal = internalMutation({
  args: {
    xendit_invoice_id: v.string(),
    paid_amount: v.optional(v.number()),
    receipt_id: v.optional(v.string()),
    payment_source: v.optional(v.string()),
  },
  handler: (ctx, args) =>
    _resolveAndConfirm(ctx, args.xendit_invoice_id, {
      paid_amount: args.paid_amount,
      receipt_id: args.receipt_id,
      payment_source: args.payment_source,
    }),
});
```

This deletes `_onPaidPolling_internal` entirely (polling retired, Decision B).

- [ ] **Step 5: Remove the polling loop from `useXenditPayment`**

In `src/hooks/useXenditPayment.ts`: delete `POLL_INTERVAL_MS`, the `checkStatus` action, and the entire polling `useEffect` (the `setInterval`/`setTimeout` block). **Keep** `POLL_CEILING_MS` (the charge route imports it for the ceiling timer), the `computePhase` function, and the `useQuery` subscriptions. The hook becomes:

```ts
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

export type Phase =
  | { kind: "loading" }
  | { kind: "showing" }
  | { kind: "paid" }
  | { kind: "expired" }
  | { kind: "cancelled" };

// Kept: the charge route's wall-clock ceiling timer reads this to reveal the
// manual-fallback CTAs (Retry / Manager override / Cancel). Polling is retired
// (Decision B) — payment detection is webhook-only; the reactive subscription
// flips the phase to "paid" the instant the webhook writes.
export const POLL_CEILING_MS = 60_000;

export function computePhase(
  txn: { status: string } | null | undefined,
  invoice: { xendit_invoice_id: string } | null | undefined,
): Phase {
  if (!txn || !invoice) return { kind: "loading" };
  if (txn.status === "paid") return { kind: "paid" };
  if (txn.status === "cancelled") return { kind: "cancelled" };
  return { kind: "showing" };
}

export function useXenditPayment(txnId: Id<"pos_transactions">) {
  const txn = useQuery(api.transactions.public.getById, { txnId });
  const invoice = useQuery(api.payments.public.getCurrentInvoice, { txnId });
  const phase: Phase = computePhase(txn ?? undefined, invoice ?? undefined);
  return { phase, invoice, txn };
}
```

- [ ] **Step 6: Gut the reconciliation poll**

In `src/hooks/useStartupReconciliation.ts`, replace the whole file with a no-op shell (Decision F — QR poll is architecturally impossible; missed-webhook recovery is manager override only):

```ts
import type { Id } from "../../convex/_generated/dataModel";

/**
 * ADR-026 reconciliation-on-reload — DOWNGRADED (Decision F, ADR-036).
 *
 * The QR Codes API never reports "paid" on a status poll, so poll-based
 * reconciliation is architecturally impossible. Missed-webhook recovery is now
 * the manager-PIN manual override only. This shell preserves the RootLayout
 * mount point for a future working-endpoint reconciliation (Xendit QR-payments
 * lookup) without re-introducing a dead poll.
 */
export function useStartupReconciliation(_sessionId: Id<"staff_sessions"> | undefined) {
  // intentionally no-op
}
```

- [ ] **Step 7: Remove the invalid `expire!` from `cancelTransaction`**

In `convex/transactions/actions.ts`, delete the step-4 best-effort Xendit cancel block (the `if (txn.xendit_invoice_id_current) { ... fetch(.../expire!) ... }`) and the step-5 `_auditInvoiceCancelOutcome_internal` call that depends on `cancel_outcome`. `xendit_invoice_id_current` is now a QR/FVA id, so `/invoices/{id}/expire!` would 404 and write a spurious failed-cancel audit row every cancel. The handler reduces to: cache pre-check → session → state guard → `_cancelCommit_internal`. Also remove the now-unused `XENDIT_BASE` const and the `"use node"`-only `Buffer` usage in this file if nothing else needs them (run `npx tsc --noEmit` to confirm). Result:

```ts
  handler: async (ctx, args): Promise<{ cancelled: true }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached);

    const session = await ctx.runQuery(api.auth.public.getSession, {
      sessionId: args.sessionId,
    });
    if (!session) throw new Error("SESSION_INVALID");

    const txn = await ctx.runQuery(api.transactions.public.getById, { txnId: args.txnId });
    if (!txn) throw new Error("TXN_NOT_FOUND");
    if (txn.status !== "awaiting_payment") throw new Error("INVALID_STATE_FOR_CANCEL");

    // Dedicated APIs have no invoice "expire" call; the prior QR/VA is superseded
    // locally and the funnel's terminal-state alert handles a pay-after-cancel
    // (Decision E). Just commit the local cancel.
    return await ctx.runMutation(internal.transactions.internal._cancelCommit_internal, {
      idempotencyKey: args.idempotencyKey,
      txnId: args.txnId,
      reason: args.reason,
      actor_staff_id: session.staff._id,
      device_id: session.deviceId,
    });
  },
```

> Keep `_auditInvoiceCancelOutcome_internal` in `payments/internal.ts` — `_replaceInvoiceCommit_internal` (retry) still references the cancel-outcome audit shape; only the `cancelTransaction` caller is removed. Verify with `npx tsc --noEmit`.

- [ ] **Step 8: Run the backend tests**

Run: `npx vitest run convex/payments convex/transactions`
Expected: PASS — webhook tests (new shape + 401 missing-config), `onPaidPaths.test.ts` (its `_onPaidWebhook_internal` call still type-checks with the new optional args), funnel tests. Fix any `cancelTransaction.test.ts` case that asserted a Xendit expire call (remove that assertion — the call is gone).

- [ ] **Step 9: Run the app + manual smoke (the behavioral proof)**

Run `npm run dev` + `npx convex dev`. In the Convex/Xendit dashboard set the QR Codes webhook URL to `https://helpful-grasshopper-46.convex.site/payments/webhook`, copy the Verification Token into `XENDIT_CALLBACK_TOKEN` (`npx convex env set XENDIT_CALLBACK_TOKEN <token>`). Create a sale → Charge → QRIS. Use the dashboard **"simulate payment"** on the created QR. Expected: the charge screen flips to success reactively (no manual action), `pos_transactions.status = "paid"` with a `receipt_number`, one stock movement, and `receipt_id`/`payment_source` on the invoice row. **This is the hard success gate — with polling gone the webhook is the sole automatic path.**

- [ ] **Step 10: Commit**

```bash
git add convex/payments/webhook.ts convex/payments/internal.ts convex/payments/__tests__/webhook.test.ts src/hooks/useXenditPayment.ts src/hooks/useStartupReconciliation.ts convex/transactions/actions.ts
git commit -m "fix(v0.3): parse QR Codes webhook shape; retire polling + reconciliation (Decisions B/E/F)"
```

---

## Task 5: Render a real QR + thin the retry path (frontend + retry)

**Files:**
- Modify: `package.json` (+`qrcode.react`@^4)
- Modify: `src/routes/sale/charge.tsx` (render `<QRCodeSVG>`)
- Modify: `convex/payments/actions.ts` (`retryWithFreshInvoice` → adapter, unique ref, no `expire!`)
- Test: `convex/payments/__tests__/actions.test.ts` (retry + BCA cases)

> Runs PARALLEL to Tasks 2–4 for the UI portion; the `retryWithFreshInvoice` portion depends on Task 1 (adapter) + Task 3 (import).

- [ ] **Step 1: Install the QR library**

Run: `npm install --save qrcode.react@^4`
Expected: `qrcode.react` ^4 added to `package.json` dependencies (v4 declares React 19 peer support).

- [ ] **Step 2: Render the QR in the charge screen**

In `src/routes/sale/charge.tsx`, add the import:

```ts
import { QRCodeSVG } from "qrcode.react";
```

Replace the QRIS branch's raw-string `<code>...</code>` block (the `SCAN TO PAY` section) with a rendered QR, guarding an empty payload:

```tsx
                <>
                  <p className="text-xs font-medium tracking-widest text-muted-foreground">
                    SCAN TO PAY
                  </p>
                  {invoice?.qr_string ? (
                    <div className="rounded-lg bg-white p-3">
                      <QRCodeSVG value={invoice.qr_string} size={220} marginSize={0} />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No QR payload.</p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Scan with any QRIS-enabled wallet
                  </p>
                </>
```

- [ ] **Step 3: Thin `retryWithFreshInvoice` onto the adapter (unique ref, no expire!)**

In `convex/payments/actions.ts`, rewrite the `retryWithFreshInvoice` handler's Xendit section. Remove the `xenditPost(\`/invoices/${prev.xendit_invoice_id}/expire!\`, ...)` cancel call and the `xenditPost("/v2/invoices", ...)` create call. The prior invoice is superseded **locally** by `_replaceInvoiceCommit_internal`. Replace from the `const prev = ...` line through the `runMutation(... _replaceInvoiceCommit ...)` return with:

```ts
    const prev = await ctx.runQuery(api.payments.public.getCurrentInvoice, { txnId: args.txnId });
    if (!prev) throw new Error("PREV_INVOICE_MISSING");

    const txn = await ctx.runQuery(api.transactions.public.getById, { txnId: args.txnId });
    if (!txn) throw new Error("TXN_NOT_FOUND");

    // Unique ref per retry so a regenerate can't collide with the prior QR's
    // reference. Matching is on the globally-unique provider id; this only avoids
    // any Xendit-side duplicate-reference ambiguity.
    const ref = `pos-${args.txnId}-r-${crypto.randomUUID()}`;
    const charge =
      args.method === "QRIS"
        ? await createQrisCharge(ref, txn.total, args.idempotencyKey)
        : await createBcaVaCharge(ref, txn.total, args.idempotencyKey);

    // No Xendit "expire" exists for QR codes; the prior row is superseded locally
    // (Decision E). Pass a success outcome — the local supersede did succeed.
    return await ctx.runMutation(
      internal.payments.internal._replaceInvoiceCommit_internal,
      {
        idempotencyKey: args.idempotencyKey,
        txnId: args.txnId,
        prev_invoice_id: prev._id,
        new_xendit_id: charge.providerId,
        new_xendit_idempotency_key: args.idempotencyKey,
        method: args.method,
        qr_string: charge.qrString,
        va_number: charge.vaNumber,
        status_at_create: charge.statusAtCreate,
        cancel_outcome: { success: true },
      },
    );
```

Now delete the residual `xenditPost` / `xenditGet` / `readJson` / `XenditInvoiceResponse` / `XENDIT_BASE` definitions from `actions.ts` (no longer referenced). Run `npx tsc --noEmit` to confirm zero unused symbols.

- [ ] **Step 4: Update the BCA + retry action tests for the FVA endpoint**

In `convex/payments/__tests__/actions.test.ts`, update the BCA-VA case(s) and the retry case to expect the new endpoints. For BCA, mock the FVA response and assert the VA endpoint:

```ts
  it("BCA_VA: posts to the FVA API and returns vaNumber", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    _xenditMockNextResponse({ id: "va_real_1", account_number: "1080099887", status: "PENDING" });
    const r = await t.action(api.payments.actions.requestPayment, {
      sessionId: s.session, txnId: s.txn, method: "BCA_VA",
      idempotencyKey: `pay-va-${Date.now()}`,
    });
    expect(r.vaNumber).toBe("1080099887");
    const calls = _xenditMockCalls();
    expect(calls[0].url).toContain("/callback_virtual_accounts");
    expect(calls[0].body.bank_code).toBe("BCA");
    expect(calls[0].body.is_closed).toBe(true);
  });
```

For the retry case, assert it hits `/qr_codes` (QRIS) with a unique `reference_id` (suffix `-r-`) and does NOT call any `/expire!` endpoint:

```ts
  it("retryWithFreshInvoice: QRIS mints a fresh QR with a unique ref and no expire call", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    _xenditMockNextResponse({ id: "qr_first", qr_string: "qr1", status: "ACTIVE" });
    await t.action(api.payments.actions.requestPayment, {
      sessionId: s.session, txnId: s.txn, method: "QRIS", idempotencyKey: "init-1",
    });
    _xenditMockReset(); installFetchMock();
    _xenditMockNextResponse({ id: "qr_second", qr_string: "qr2", status: "ACTIVE" });
    const r = await t.action(api.payments.actions.retryWithFreshInvoice, {
      sessionId: s.session, txnId: s.txn, method: "QRIS", idempotencyKey: "retry-1",
    });
    expect(r.qrString).toBe("qr2");
    const calls = _xenditMockCalls();
    expect(calls.every((c) => !c.url.includes("expire"))).toBe(true);
    expect(calls[0].url).toContain("/qr_codes");
    expect(calls[0].body.reference_id).toContain("-r-");
  });
```

Remove any existing BCA/retry assertions that expected `/v2/invoices` or `payment_methods`.

- [ ] **Step 5: Run the action tests**

Run: `npx vitest run convex/payments/__tests__/actions.test.ts`
Expected: PASS (QRIS, BCA-via-FVA, retry-no-expire, Critical#1 dedup).

- [ ] **Step 6: Typecheck + build + manual QR check**

Run: `npm run typecheck && npm run build`
Expected: PASS. Then in `npm run dev`, open Charge → QRIS and confirm a real QR renders (with TEST keys it won't be wallet-scannable — that's expected; the render itself is the check).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/routes/sale/charge.tsx convex/payments/actions.ts convex/payments/__tests__/actions.test.ts
git commit -m "feat(v0.3): render scannable QRIS via qrcode.react; thin retry onto adapter (BCA via FVA)"
```

---

## Task 6: ADR-036 + cross-doc back-refs + CHANGELOG/SCHEMA/CLAUDE.md

**Files:**
- Create: `docs/ADR/036-xendit-dedicated-apis-inline.md`
- Modify: `docs/ADR/011-qris-via-xendit-bca-va-secondary.md`, `docs/ADR/014-single-xendit-invoice-per-transaction.md`, `docs/ADR/026-reconciliation-on-reload.md`, `docs/ADR/000-strategic-foundations.md` (§8)
- Modify: `docs/ADR/README.md`, `CLAUDE.md`, `docs/SCHEMA.md`, `docs/CHANGELOG.md`

- [ ] **Step 1: Write ADR-036**

Create `docs/ADR/036-xendit-dedicated-apis-inline.md` following the repo's ADR format (Date/Status/Group; Context; Decision; Alternatives; Consequences; Affects-other-ADRs). Record Decisions A–F from the spec. The "Affects other ADRs" section must list: **supersedes ADR-011** (single surface), **adjusts ADR-014** (local supersede vs API cancel), **amends ADR-026** (reconciliation → manual-only), **amends strategic-foundations §8** (polling leg retired for QRIS/FVA). Reference the spec + the diagnostic bundle.

- [ ] **Step 2: Add back-references to the affected ADRs**

In each of ADR-011, ADR-014, ADR-026, and `000-strategic-foundations.md` §8, add a one-line note at the top (or in their "Status"/"Related" area): `> **Amended/superseded by [ADR-036](./036-xendit-dedicated-apis-inline.md)** (2026-05-28): <one-line what changed>`.

- [ ] **Step 3: Update the ADR index + CLAUDE.md + SCHEMA.md**

- `docs/ADR/README.md`: add the ADR-036 row.
- `CLAUDE.md`: in "Xendit integration notes", change the Invoice-API description to QR Codes (QRIS) + FVA (BCA); update business-rule #5 (payment confirmation paths — note polling retired for these methods, webhook + manual) and #18 (reconciliation-on-reload now manual-only for QRIS/FVA per ADR-036).
- `docs/SCHEMA.md`: document the new `receipt_id`/`payment_source` columns, the `PAYMENT_AMOUNT_MISMATCH` flag, and the dual-meaning `xendit_invoice_id`.

- [ ] **Step 4: Add the CHANGELOG entry**

In `docs/CHANGELOG.md`:

```markdown
## 2026-05-28 — Xendit inline payments fix (v0.3)
- QRIS now uses the Xendit QR Codes API (inline scannable QR) instead of the Invoice API
- BCA VA now uses the Virtual Accounts (FVA) API for an inline VA number (live-unverified)
- Webhook parses the QR Codes v2 shape (`data.status: "SUCCEEDED"`, match on `qr_id`); always-200 + 401-on-missing-config
- Retired QRIS status polling + poll-based reconciliation; webhook + manager override are the confirmation paths
- Captured RRN (`receipt_id`) + paying `payment_source`; added `PAYMENT_AMOUNT_MISMATCH` flag
- ADR-036 supersedes ADR-011, adjusts ADR-014, amends strategic-foundations §8 + ADR-026
```

- [ ] **Step 5: Final full test + typecheck + build**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Update the progress tracker**

Run `/progress-update` for the relevant v0.3 payments task with `--status done --commit <sha>` (and regenerate the HTML per CLAUDE.md), or add a new task if none matches.

- [ ] **Step 7: Commit**

```bash
git add docs/ADR/ CLAUDE.md docs/SCHEMA.md docs/CHANGELOG.md docs/PROGRESS.md docs/progress.html
git commit -m "docs(v0.3): ADR-036 + supersede ADR-011/014, amend §8/ADR-026; CHANGELOG/SCHEMA/CLAUDE"
```

---

## Self-review

**Spec coverage:** Decision A → Tasks 1,3,5 (QR Codes + FVA endpoints). B → Task 4 (polling removed). C → Task 5 (BCA built, FVA parser tagged unverified in Task 1). D → Task 1 (single deep adapter). E → Tasks 4,5 (cancel + retry drop `expire!`, local supersede). F → Task 4 (reconciliation no-op + ADR-026 amend in Task 6). `api-version` test → Task 1. Amount-mismatch flag + RRN columns → Task 2 + Task 4. Webhook-fires gate → Task 4 Step 9 (hard gate). ADR cross-refs → Task 6. All spec sections map to a task.

**Placeholder scan:** No "TBD"/"handle errors"/"similar to". Every code step shows full code. The one soft spot — `seedTxnAwaiting`'s seeded total in Task 2 — is called out with a verification instruction (read the helper, set `paid_amount` relative to it).

**Type consistency:** `ChargeResult` (`providerId`/`qrString?`/`vaNumber?`/`statusAtCreate`) is produced by `createQrisCharge`/`createBcaVaCharge` (Task 1) and consumed identically in `requestPayment` (Task 3) and `retryWithFreshInvoice` (Task 5). `WebhookParse` (`paid`/`matchKey`/`amount?`/`receiptId?`/`source?`) is produced by `parseXenditWebhook` (Task 1) and destructured identically in `webhook.ts` (Task 4). `_onPaidWebhook_internal`'s new args (`paid_amount`/`receipt_id`/`payment_source`) match the webhook caller (Task 4) and feed `_confirmPaid_internal`'s `paid_amount` (Task 2). `PAYMENT_AMOUNT_MISMATCH` defined in Task 2, used in Task 2 funnel + asserted in Task 2 tests. `POLL_CEILING_MS` retained for `charge.tsx`. Consistent.

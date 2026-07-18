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

// A PURE ANNOTATION describing which Xendit envelope shape this callback is.
// Derived alongside — never feeds back into — paid/matchKey/amount/receiptId/
// paymentSource (see parseXenditWebhook). Added so a downstream forwarder can
// route/label callbacks without re-parsing.
export type WebhookKind = "qr_payment" | "bca_va" | "refund" | "ignored";

export type WebhookParse = {
  paid: boolean;
  matchKey: string | null;
  amount?: number;
  receiptId?: string;
  // The paying wallet/bank (DANA/OVO/BCA). Named distinctly from the funnel's
  // `source` (the confirmation PATH: webhook/polling/manual) to avoid confusion.
  paymentSource?: string;
  // Pure annotation (never alters the fields above). See WebhookKind.
  kind: WebhookKind;
  // QR envelopes only: the per-PAYMENT id (`data.id`), distinct from the QR id
  // (`data.qr_id`). One qr_id can receive MULTIPLE payments (each with its own
  // data.id), so the forwarder deduping on qr_id alone would silently drop a
  // second genuine payment — it dedups on (qr_id, payment_id) instead. Pure
  // annotation like `kind`: never feeds back into paid/matchKey.
  paymentId?: string;
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
  // A 200 without a usable instrument must fail loudly, not persist an invoice
  // that renders "No QR payload" and strands the txn in awaiting_payment — the
  // exact failure mode this dedicated-API switch exists to eliminate.
  if (!json.id || !json.qr_string) {
    throw new Error(`XENDIT_QR_FAILED: 200 but missing id/qr_string: ${JSON.stringify(json)}`);
  }
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
  // Same guard as QRIS: a 200 without an id/account_number is unusable.
  if (!json.id || !json.account_number) {
    throw new Error(`XENDIT_VA_FAILED: 200 but missing id/account_number: ${JSON.stringify(json)}`);
  }
  return { providerId: json.id, vaNumber: json.account_number, statusAtCreate: json.status ?? "PENDING" };
}

/**
 * Pure webhook parser. Discriminates the two Xendit envelopes that hit our
 * single endpoint and extracts the match key + amount + reconciliation fields.
 *  - BCA VA (live-unverified): flat FVA callback — no `event`, arrival = paid.
 *    LIVE-UNVERIFIED means the flat `callback_virtual_account_id` field name and
 *    the absence of an `event` wrapper are asserted from Xendit's FVA docs, NOT
 *    confirmed against a real callback. Verify before BCA go-live (Decision C).
 *  - QRIS (reference-proven): { event: "qr.payment", data: { status, qr_id } }.
 *  - Anything else (incl. the legacy flat Invoice {id,status:"PAID"}) → ignored.
 */
export function parseXenditWebhook(rawBody: string): WebhookParse {
  let p: any;
  try {
    p = JSON.parse(rawBody);
  } catch {
    return { paid: false, matchKey: null, kind: "ignored" };
  }
  if (!p || typeof p !== "object") return { paid: false, matchKey: null, kind: "ignored" };

  // `kind` is a PURE ANNOTATION derived here, BEFORE the existing branch bodies
  // run. It is attached to whatever those branches return WITHOUT altering their
  // paid/matchKey/amount/receiptId/paymentSource values. Refund detection wins
  // over the bca_va/qr_payment labels but must NOT suppress the existing
  // status-guarded logic — a refund of an already-paid POS txn stays the
  // harmless no-op it is today; it is merely labeled `refund` here.
  // LIVE-UNVERIFIED (same discipline as the BCA-VA branch): the refund envelope's
  // field names (`event`/`data.type`/`type` containing "refund") are asserted from
  // Xendit docs, NOT confirmed against a real refund callback. The label only ever
  // GATES the forward-out decision (never `paid`), so a mislabel cuts both ways:
  // a refund mislabeled as payment is forwarded (RM's Phase-1 refund gate absorbs
  // it — harmless), but a genuine payment whose envelope happens to carry "refund"
  // in one of these three fields is labeled `refund` and NOT forwarded (silent
  // suppress — the costly direction). Accepted trade until the real field names
  // are live-verified; see docs/xendit-reference/README.md (refund envelope note).
  // Verify the real refund field names before treating this label as authoritative.
  const hasRefund = (v: unknown): boolean =>
    typeof v === "string" && v.toLowerCase().includes("refund");
  const refundDetected =
    hasRefund(p.event) || hasRefund(p.data?.type) || hasRefund(p.type);

  // BCA VA — flat FVA payment callback (no event envelope; arrival = paid).
  if (p.callback_virtual_account_id && p.event === undefined) {
    return {
      paid: true,
      matchKey: p.callback_virtual_account_id,
      amount: p.amount,
      receiptId: p.payment_id,
      kind: refundDetected ? "refund" : "bca_va",
    };
  }

  // QRIS — QR Codes v2 envelope (or a bare data object as a fallback).
  // Intentionally NOT gated on `event === "qr.payment"`: detection keys off the
  // SUCCEEDED status so a slightly-wrong event-label assumption can't silently
  // drop a REAL payment (false negative — the costly failure on a money path).
  // The near-impossible false positive (a non-qr.payment envelope carrying
  // data.status SUCCEEDED to this endpoint) is the accepted trade. Do not
  // "harden" this into an event-label gate without live-verifying the label.
  const d = p.data ?? p;
  // "COMPLETED" is an Invoice-API status, kept only as a defensive fallback;
  // QR Codes v2 uses SUCCEEDED.
  const paid = d.status === "SUCCEEDED" || d.status === "COMPLETED";
  if (paid) {
    return {
      paid: true,
      matchKey: d.qr_id ?? d.id ?? null,
      amount: d.amount,
      receiptId: d.payment_detail?.receipt_id,
      paymentSource: d.payment_detail?.source,
      kind: refundDetected ? "refund" : "qr_payment",
      // Per-payment id for the forwarder's (qr_id, payment_id) dedup. When the
      // envelope has no qr_id, matchKey already fell back to d.id — exposing it
      // here too is harmless (the pair is still unique per payment).
      paymentId: typeof d.id === "string" ? d.id : undefined,
    };
  }
  return { paid: false, matchKey: null, kind: refundDetected ? "refund" : "ignored" };
}

// ─── List Transactions (settlement poll, v0.7) ───────────────────────────────
// Appended after parseXenditWebhook so the webhook parser keeps its own JSDoc.

/** Build the GET /transactions URL. Confirmed shape (v0.7 Task 0): the date
 *  window uses bracket notation; there is NO `settlement_status` query filter —
 *  settled-status filtering happens client-side in aggregateSettledByDate.
 *  Windows on `updated[gte]`, not `created[gte]`: a settlement posting UPDATES
 *  the txn, so an updated-window catches a txn that was created long ago but
 *  settled recently (the self-heal target, spec G5) — a created-window would
 *  miss it. (The exact created-vs-updated semantics are KYB-gated, see #66.)
 *  Exported so a test asserts the window param without a live call. */
export function buildListTransactionsUrl(params: { settledAfterIso: string; afterId?: string }): string {
  const u = new URL(`${XENDIT_BASE}/transactions`);
  u.searchParams.set("updated[gte]", params.settledAfterIso);
  u.searchParams.set("limit", "50");
  if (params.afterId) u.searchParams.set("after_id", params.afterId);
  return u.toString();
}

/** V8-safe Basic auth for listTransactions (called from the default-runtime
 *  settlement cron). The default runtime provides the web-standard `btoa`; the
 *  "use node" create-charge funcs use `Buffer` instead (Buffer is undefined in
 *  the V8 runtime, btoa is undefined in node). Isolated so node-runtime
 *  importers of this module never evaluate btoa. */
function listTransactionsAuthHeader(): string {
  const key = process.env.XENDIT_SECRET_KEY;
  if (!key) throw new Error("XENDIT_SECRET_KEY not set");
  return "Basic " + btoa(`${key}:`);
}

/** Fetch settled transactions since `settledAfterIso` (paginated via after_id).
 *  Returns the concatenated raw `{ data }` envelope for parseListTransactions.
 *  Plain async fn (like createQrisCharge), called directly by the V8 cron —
 *  fetch + btoa both work there. */
export async function listTransactions(params: { settledAfterIso: string }): Promise<unknown> {
  const rows: unknown[] = [];
  let afterId: string | undefined;
  // Bounded pagination guard (defensive — a booth's 7-day window is << 50 settled txns).
  const MAX_PAGES = 20;
  let page = 0;
  for (; page < MAX_PAGES; page++) {
    const res = await fetch(
      buildListTransactionsUrl({ settledAfterIso: params.settledAfterIso, afterId }),
      { method: "GET", headers: { "Content-Type": "application/json", Authorization: listTransactionsAuthHeader() } },
    );
    if (!res.ok) {
      throw new Error(`XENDIT_LIST_TXN_FAILED: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: unknown[]; has_more?: boolean };
    if (Array.isArray(json.data)) rows.push(...json.data);
    const last = json.data?.[json.data.length - 1] as { id?: string } | undefined;
    if (!json.has_more || !last?.id) break;
    afterId = last.id;
  }
  // Never silently truncate: if the page cap fired with more rows pending, throw
  // so the resilient cron surfaces it (an audited failure) rather than reporting
  // a complete sync over an incomplete dataset (under-counting settlements).
  if (page === MAX_PAGES) {
    throw new Error(`XENDIT_LIST_TXN_TRUNCATED: >${MAX_PAGES * 50} rows in lookback window`);
  }
  return { data: rows };
}

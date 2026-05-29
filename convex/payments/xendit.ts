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
  // The paying wallet/bank (DANA/OVO/BCA). Named distinctly from the funnel's
  // `source` (the confirmation PATH: webhook/polling/manual) to avoid confusion.
  paymentSource?: string;
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
    };
  }
  return { paid: false, matchKey: null };
}

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
/** Reject obviously-misconfigured tokens (real Xendit tokens are long random
 * strings). Guards against an operator fat-fingering the env var to "" or " ". */
const MIN_CALLBACK_TOKEN_LEN = 16;

export const xenditWebhook = httpAction(async (ctx, request) => {
  const expected = process.env.XENDIT_CALLBACK_TOKEN;
  const received = request.headers.get("x-callback-token") ?? "";
  if (!expected || expected.length < MIN_CALLBACK_TOKEN_LEN || !tokenMatches(received, expected)) {
    return new Response("unauthorized", { status: 401 });
  }

  const raw = await request.text();
  const { paid, matchKey, amount, receiptId, paymentSource } = parseXenditWebhook(raw);

  if (paid && matchKey) {
    try {
      await ctx.runMutation(internal.payments.internal._onPaidWebhook_internal, {
        xendit_invoice_id: matchKey,
        paid_amount: amount,
        receipt_id: receiptId,
        payment_source: paymentSource,
      });
    } catch (err) {
      // A mutation throw must never become a 500 (retry-storm guard). Logged at
      // error level: a paid webhook that couldn't commit is an alertable event.
      console.error("[xendit] webhook mutation error:", err);
    }
  }

  return new Response("ok", { status: 200 });
});

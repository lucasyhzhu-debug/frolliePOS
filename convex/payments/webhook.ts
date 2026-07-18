import { httpAction, ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { parseXenditWebhook } from "./xendit";

/** Best-effort ops report for post-auth webhook failures. Never throws — a
 * report failure must not break the return-200 Xendit contract. */
async function reportWebhookError(ctx: ActionCtx, err: unknown): Promise<void> {
  try {
    await ctx.runMutation(internal.ops.internal._recordError_internal, {
      kind: "backend",
      message: err instanceof Error ? err.message : String(err),
      route: "convex/payments/webhook",
    });
  } catch { /* swallow — reporting must not affect Xendit retry behavior */ }
}

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

  // Post-auth processing wrapped in try/catch for v1.0.1 backend error reporting.
  // The auth check above stays FIRST and UNCHANGED — 401 on mismatch, NO report
  // (bot-scanner noise). Catch here is post-auth only; swallow reporting errors
  // so a report failure can never break the return-200 Xendit contract.
  try {
    const raw = await request.text();
    const { paid, matchKey, amount, receiptId, paymentSource, kind, paymentId } = parseXenditWebhook(raw);

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
        // v1.0.1: best-effort ops report — kind: "backend", never mask original behavior
        await reportWebhookError(ctx, err);
      }
    }

    // POS -> RM forward (additive — the POS paid path above is UNCHANGED).
    // INVARIANT (LOW-7): forwarding is strictly POS -> RM; this webhook must
    // never be pointed back and RM must never forward. Gated on a genuine QR
    // payment WITH a match key (mirrors the paid && matchKey guard so a
    // SUCCEEDED-QR envelope missing its id can't create a null-keyed row) AND
    // the FROLLIE_FORWARD_ENABLED kill-switch. Wrapped so a transient enqueue
    // throw is reported + swallowed — never breaks the return-200 contract.
    if (kind === "qr_payment" && matchKey && process.env.FROLLIE_FORWARD_ENABLED === "true") {
      try {
        await ctx.runMutation(internal.payments.forwarder._enqueueForward_internal, {
          raw_payload: raw,
          xendit_qr_id: matchKey,
          // (qr_id, payment_id) pair dedup — one QR can receive multiple payments.
          ...(paymentId !== undefined ? { xendit_payment_id: paymentId } : {}),
        });
      } catch (err) {
        console.error("[xendit] webhook forward enqueue error:", err);
        await reportWebhookError(ctx, err);
      }
    }
  } catch (err) {
    // Parsing or other post-auth error — report and swallow
    console.error("[xendit] webhook processing error:", err);
    await reportWebhookError(ctx, err);
  }

  return new Response("ok", { status: 200 });
});

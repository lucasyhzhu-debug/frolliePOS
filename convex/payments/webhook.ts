import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

const webhookBodyValidator = (
  body: unknown,
): body is {
  id: string;
  status: "PAID" | "EXPIRED" | "PENDING";
  external_id?: string;
} => {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.id === "string" && typeof b.status === "string";
};

/**
 * Inbound Xendit webhook. Verified via constant-time compare of the
 * x-callback-token header against XENDIT_CALLBACK_TOKEN env var.
 * Dedup via _onPaidWebhook_internal → _confirmPaid_internal status guard.
 * Always returns 200 on success/duplicate — Xendit retries on non-2xx.
 */
export const xenditWebhook = httpAction(async (ctx, request) => {
  const expected = process.env.XENDIT_CALLBACK_TOKEN;
  if (!expected) return new Response("misconfigured", { status: 500 });

  const received = request.headers.get("x-callback-token") ?? "";
  // Constant-time compare: fold any length difference into the diff and walk the
  // longer of the two, rather than returning early on length mismatch — a
  // wrong-length token must not be distinguishable from a wrong-byte one by
  // timing (I2). charCodeAt past the end is NaN → coerced to 0.
  let diff = received.length ^ expected.length;
  const max = Math.max(received.length, expected.length);
  for (let i = 0; i < max; i++)
    diff |= (received.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  if (diff !== 0) return new Response("unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (!webhookBodyValidator(body)) return new Response("bad request", { status: 400 });

  if (body.status === "PAID") {
    await ctx.runMutation(internal.payments.internal._onPaidWebhook_internal, {
      xendit_invoice_id: body.id,
    });
  }

  return new Response("ok", { status: 200 });
});

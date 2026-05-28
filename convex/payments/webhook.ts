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
  if (received.length !== expected.length)
    return new Response("unauthorized", { status: 401 });

  let diff = 0;
  for (let i = 0; i < received.length; i++)
    diff |= received.charCodeAt(i) ^ expected.charCodeAt(i);
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

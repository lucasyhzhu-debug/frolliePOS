import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { constantTimeEqual } from "../lib/constantTimeEqual";

const BODY_MAX = 16_000; // bytes; well under keepalive 64KB cap

const KINDS = new Set(["crash", "unhandled", "payment", "mutation", "backend"]);

// Always 2xx/204 — never reveal token validity, never make the browser retry.
export const opsErrorRoute = httpAction(async (ctx, request) => {
  const envToken = process.env.OPS_INGEST_TOKEN;
  const token = request.headers.get("x-ops-token") ?? "";
  if (!envToken || !constantTimeEqual(token, envToken)) {
    return new Response(null, { status: 204 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new Response(null, { status: 204 });
  }
  if (raw.length > BODY_MAX) return new Response(null, { status: 204 });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 204 });
  }

  const kind = typeof body.kind === "string" ? body.kind : "";
  const message = typeof body.message === "string" ? body.message : "";
  if (!KINDS.has(kind) || !message) return new Response(null, { status: 204 });

  // Truncation is owned by _recordError_internal (single contract for both this
  // route and direct BE callers) — don't pre-truncate here.
  await ctx.runMutation(internal.ops.internal._recordError_internal, {
    kind: kind as "crash" | "unhandled" | "payment" | "mutation" | "backend",
    message,
    stack: typeof body.stack === "string" ? body.stack : undefined,
    route: typeof body.route === "string" ? body.route : undefined,
    staff_code: typeof body.staff_code === "string" ? body.staff_code : undefined,
    device_id: typeof body.device_id === "string" ? body.device_id : undefined,
    online: typeof body.online === "boolean" ? body.online : undefined,
    app_version: typeof body.app_version === "string" ? body.app_version : undefined,
  });

  return new Response(null, { status: 200 });
});

// convex/api/v1/_shape.ts
// Shape-agnostic envelope + Response builders shared by both endpoints.

export function envelope<T>(rows: T[], nextCursor: string | null) {
  return { data: rows, nextCursor };
}

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

// Use `new Response(JSON.stringify(...))` — matches the proven pattern in
// receipts/http.ts + payments/webhook.ts. Do NOT use the static `Response.json()`:
// its runtime support in the Convex isolate is not guaranteed (staffreview Imp 1).
export function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

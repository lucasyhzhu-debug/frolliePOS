import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

// Browser cache hint — short enough that refunds (PR B) reflect within minutes
// of a manager action, long enough to make the customer's "refresh to re-show
// receipt" snappy. Server-side cache row (24h) is the source of truth for
// invalidation; this header is just a hint.
const BROWSER_CACHE_MAX_AGE_SEC = 300;
const CACHE_CONTROL_VALUE = `private, max-age=${BROWSER_CACHE_MAX_AGE_SEC}`;

/**
 * GET /r/:token — serves the receipt HTML to the public. Token IS the capability
 * per ADR-021. 24h HTML cache per ADR-022; lazy regenerate on miss.
 *
 * Returns:
 *   200 text/html — receipt rendered
 *   404 text/html — token missing, txn not paid, or backing data unavailable
 *
 * Cache-Control: private, max-age=BROWSER_CACHE_MAX_AGE_SEC — let the browser
 * short-cache for refresh snappiness, but invalidation is server-side (cache
 * row), not HTTP.
 */
export const handleReceiptRoute = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  // Route registered as pathPrefix "/r/" — token is the trailing segment.
  // Strip a trailing slash so /r/abc/ resolves to "abc" rather than "" — common
  // when share-intent helpers (Telegram, iOS Share Sheet) append a slash.
  const pathname = url.pathname.endsWith("/") && url.pathname !== "/"
    ? url.pathname.slice(0, -1)
    : url.pathname;
  const token = pathname.split("/").pop() ?? "";

  if (!token || token.length < 10) {
    return new Response(notFoundHtml(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Cache hit?
  const cached = await ctx.runQuery(internal.receipts.internal._getCachedReceipt_internal, { token });
  if (cached) {
    return new Response(cached.html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": CACHE_CONTROL_VALUE,
      },
    });
  }

  // Cache miss / expired — render fresh.
  const rendered = await ctx.runQuery(internal.receipts.internal._renderReceiptByToken_internal, { token });
  if (!rendered) {
    return new Response(notFoundHtml(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Write to cache for next time. The render is already in hand — a transient
  // cache-write failure (OCC contention, etc.) must not turn a renderable
  // receipt into a 500. Log and serve.
  try {
    await ctx.runMutation(internal.receipts.internal._writeCacheEntry_internal, {
      token,
      html: rendered.html,
    });
  } catch (e) {
    console.error("Receipt cache write failed (non-fatal):", e);
  }

  return new Response(rendered.html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": CACHE_CONTROL_VALUE,
    },
  });
});

function notFoundHtml(): string {
  return `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Struk tidak ditemukan</title>
<style>body{margin:0;padding:48px 24px;background:#f3f4f6;font-family:system-ui,sans-serif;color:#1d1d1f;text-align:center}.card{max-width:380px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 12px rgba(0,0,0,0.08)}</style>
</head><body><div class="card"><h1 style="font-size:18px;margin-bottom:12px">Struk tidak ditemukan</h1><p style="font-size:14px;color:#6b7280;line-height:1.5">Mohon hubungi Frollie untuk bantuan.</p><p style="font-size:12px;color:#6b7280;margin-top:20px">Follow us on Instagram! @frollie.id</p></div></body></html>`;
}

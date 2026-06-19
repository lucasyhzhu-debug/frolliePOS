// convex/api/v1/transactions.ts
import { httpAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";
import { verifyBearerToken, ApiError } from "./_auth";
import { decodeCursor } from "../../lib/apiCursor";
import { parseRange } from "./_request";
import { envelope, errorBody, jsonResponse } from "./_shape";

const PATH = "/api/v1/transactions";

export const handleTransactionsRoute = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const cursorParam = url.searchParams.get("cursor");
  let tokenId: Id<"api_tokens"> | undefined;
  const log = async (http_status: number, extra: Record<string, unknown> = {}) => {
    try {
      await ctx.runMutation(internal.api.v1.internal._logApiRequest_internal, {
        token_id: tokenId,
        endpoint: PATH,
        http_status,
        cursor_in: cursorParam ?? undefined,
        ...extra,
      });
    } catch (e) { console.error("[api/transactions] log write failed (non-fatal):", e); }
  };
  try {
    const auth = await verifyBearerToken(ctx, request, PATH);
    tokenId = auth.tokenId;
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 500);
    const { fromMs, toMs } = parseRange(url);  // throws BAD_RANGE
    const cur = cursorParam ? decodeCursor(cursorParam) : undefined;  // throws BAD_CURSOR
    const { rows, nextCursor } = await ctx.runQuery(
      internal.transactions.internal._listPaidTxnsForApi_internal,
      { afterPaidAtMs: cur?.orderKeyMs, afterCreationTime: cur?.creationTime, fromMs, toMs, limit },
    );
    await log(200, { returned_count: rows.length, cursor_out: nextCursor ?? undefined });
    return jsonResponse(envelope(rows, nextCursor), 200);
  } catch (e) {
    if (e instanceof ApiError) {
      await log(e.status, { error_code: e.code });
      return jsonResponse(errorBody(e.code, e.message), e.status,
        e.code === "RATE_LIMITED" ? { "Retry-After": "60" } : {});
    }
    if (e instanceof Error && e.message === "BAD_CURSOR") {
      await log(400, { error_code: "BAD_CURSOR" });
      return jsonResponse(errorBody("BAD_CURSOR", "cursor failed to decode"), 400);
    }
    await log(500, { error_code: "INTERNAL" });
    console.error("[api/transactions] internal error:", e);
    return jsonResponse(errorBody("INTERNAL", "unexpected server error"), 500);
  }
});

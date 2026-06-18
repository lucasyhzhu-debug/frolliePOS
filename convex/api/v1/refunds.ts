// convex/api/v1/refunds.ts
import { httpAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { verifyBearerToken, ApiError } from "./_auth";
import { decodeCursor } from "../../lib/apiCursor";
import { envelope, errorBody, jsonResponse } from "./_shape";

const PATH = "/api/v1/refunds";

export const handleRefundsRoute = httpAction(async (ctx, request) => {
  try {
    await verifyBearerToken(ctx, request, PATH);
    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 500);
    const cursorParam = url.searchParams.get("cursor");
    const cur = cursorParam ? decodeCursor(cursorParam) : undefined;  // throws BAD_CURSOR
    const { rows, nextCursor } = await ctx.runQuery(
      internal.refunds.internal._listRefundsForApi_internal,
      { afterCreatedAtMs: cur?.orderKeyMs, afterCreationTime: cur?.creationTime, limit },
    );
    return jsonResponse(envelope(rows, nextCursor), 200);
  } catch (e) {
    if (e instanceof ApiError)
      return jsonResponse(errorBody(e.code, e.message), e.status,
        e.code === "RATE_LIMITED" ? { "Retry-After": "60" } : {});
    if (e instanceof Error && e.message === "BAD_CURSOR")
      return jsonResponse(errorBody("BAD_CURSOR", "cursor failed to decode"), 400);
    console.error("[api/refunds] internal error:", e);
    return jsonResponse(errorBody("INTERNAL", "unexpected server error"), 500);
  }
});

// convex/api/v1/_auth.ts
import { GenericActionCtx } from "convex/server";
import { DataModel, Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { sha256Hex } from "../../lib/sha256";

export class ApiError extends Error {
  constructor(public status: number, public code: string, msg?: string) {
    super(msg ?? code);
  }
}

// httpAction ctx. Verifies the bearer token and the per-token RPM bucket.
// Returns the token id on success; throws ApiError otherwise.
export async function verifyBearerToken(
  ctx: GenericActionCtx<DataModel>,
  request: Request,
  endpointPath: string,
): Promise<{ tokenId: Id<"api_tokens"> }> {
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(\S+)$/);
  if (!m) throw new ApiError(401, "UNAUTHENTICATED");
  const hash = await sha256Hex(m[1]);
  const result = await ctx.runMutation(internal.api.v1.internal._authAndCount_internal, {
    hash, endpointPath,
  });
  if (result.error) throw new ApiError(result.status!, result.code!);
  return { tokenId: result.tokenId! };
}

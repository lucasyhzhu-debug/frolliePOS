"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const STAFF_NAMES = ["Bayu", "Citra", "Dewi", "Eka"] as const;

/**
 * Dev-only seed. Wipes POS tables + reseeds:
 *   - 4 staff (Bayu, Citra, Dewi, Eka — PIN 0000)
 *   - 1 manager (Lucas — PIN 9999)
 *   - 5 inventory SKUs (dubai, choco, matcha, lotus, brownie)
 *   - 7 products from the wireframe catalog
 *   - initial stock levels
 *
 * Hard prod guard: aborts unless CONVEX_CLOUD_URL identifies a dev deployment
 * OR the staff table is empty (greenfield prod is also acceptable). Writes an
 * audit row so the wipe is traceable. INTERNAL — not exposed via api.*.
 */
export const reset = internalAction({
  args: {},
  handler: async (ctx): Promise<{ wiped: number; inserted: number }> => {
    const url = process.env.CONVEX_CLOUD_URL ?? "";
    const isDev = url.includes("dev-") || url.includes("localhost");

    const existingStaff = await ctx.runQuery(internal.seed._countStaff_internal, {});
    if (!isDev && existingStaff > 0) {
      throw new Error(
        `seedActions.reset refuses to run on a non-dev deployment that already has staff (${existingStaff}). ` +
        `URL=${url}. Verify CONVEX_CLOUD_URL or clear the staff table manually first.`,
      );
    }

    const staffPinHash: string = await ctx.runAction(internal.authActions._hashPin_internal, { pin: "0000" });
    const mgrPinHash: string = await ctx.runAction(internal.authActions._hashPin_internal, { pin: "9999" });

    const result = await ctx.runMutation(internal.seed._reset_internal, {
      staffPinHash,
      mgrPinHash,
      staffNames: STAFF_NAMES as unknown as string[],
    });
    return result;
  },
});

"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

const STAFF_NAMES = ["Bayu", "Citra", "Dewi", "Eka"] as const;

/**
 * Dev-only seed. Wipes POS tables + reseeds:
 *   - 4 staff (Bayu, Citra, Dewi, Eka — PIN 0000)
 *   - 1 manager (Lucas — PIN 9999)
 *   - 5 inventory SKUs (dubai, choco, matcha, lotus, brownie)
 *   - 7 products from the wireframe catalog
 *   - initial stock levels
 *
 * Prod guard (deny-list): aborts if CONVEX_CLOUD_URL contains the known prod
 * deployment slug. All other deployments (dev, localhost, ephemeral test) are
 * allowed through. If the prod deployment ever changes, update KNOWN_PROD_SLUG
 * here and in CLAUDE.md §"Convex deployment". INTERNAL — not exposed via api.*.
 */
export const reset = internalAction({
  args: {},
  handler: async (ctx): Promise<{ wiped: number; inserted: number }> => {
    const url = process.env.CONVEX_CLOUD_URL ?? "";
    // POS prod deployment slug per CLAUDE.md §"Convex deployment".
    // Update this constant if the prod deployment is ever replaced.
    const KNOWN_PROD_SLUG = "savory-zebra-800";
    const isProd = url.includes(KNOWN_PROD_SLUG);

    if (isProd) {
      throw new Error(
        `seedActions.reset is BLOCKED on production (${url}). ` +
        `Refuses to run on the known prod deployment slug "${KNOWN_PROD_SLUG}".`,
      );
    }

    const existingStaff = await ctx.runQuery(internal.seed.internal._countStaff_internal, {});
    if (existingStaff > 0) {
      console.warn(
        `[seedActions.reset] Wiping ${existingStaff} existing staff rows on deployment ${url}. ` +
        `This is intentional in dev but should never happen in prod.`,
      );
    }

    const staffPinHash: string = await ctx.runAction(internal.auth.actions._hashPin_internal, { pin: "0000" });
    const mgrPinHash: string = await ctx.runAction(internal.auth.actions._hashPin_internal, { pin: "9999" });

    const result = await ctx.runMutation(internal.seed.internal._reset_internal, {
      staffPinHash,
      mgrPinHash,
      staffNames: STAFF_NAMES as unknown as string[],
    });
    return result;
  },
});

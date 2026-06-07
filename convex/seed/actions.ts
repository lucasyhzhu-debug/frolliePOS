"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { assertNotProd } from "./internal";

const STAFF_NAMES = ["Bayu", "Citra", "Dewi", "Eka"] as const;

/**
 * Dev-only seed. Wipes POS tables + reseeds:
 *   - 4 staff (Bayu, Citra, Dewi, Eka — PIN 0000)
 *   - 1 manager (Lucas — PIN 9999)
 *   - 5 inventory SKUs (dubai, choco, matcha, lotus, brownie)
 *   - 7 products from the wireframe catalog
 *   - initial stock levels
 *
 * Returns stable test IDs (managerSessionId, voucherId, voucherCode) consumed
 * by e2e/specs/voucher-offline.spec.ts (C2). These are emitted as JSON on
 * stdout by `npx convex run`, parseable by the spec.
 *
 * Prod guard (deny-list): aborts if CONVEX_CLOUD_URL contains the known prod
 * deployment slug (via shared `assertNotProd`). All other deployments (dev,
 * localhost, ephemeral test) are allowed through. INTERNAL — not exposed via
 * api.*.
 */
export const reset = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    wiped: number;
    inserted: number;
    // Stable test IDs for e2e (C2) — see _reset_internal. IDs are stringified
    // across the action boundary. Dev-only; prod-guarded.
    managerSessionId: string;
    voucherId: string;
    voucherCode: string;
  }> => {
    // Single-writer prod guard (shared with _e2eFixtureIds_internal).
    assertNotProd();

    const url = process.env.CONVEX_CLOUD_URL ?? "";
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

/**
 * Bootstrap a fresh deployment with the initial manager account.
 * Creates Lucas (S-0001, manager, PIN 1111) when the staff table is empty.
 * Idempotent guard: aborts with "already_bootstrapped" if staff already exist.
 *
 * Safe on prod — it refuses to write if any staff row exists, so running it
 * a second time is a no-op error rather than destructive. The prod guard from
 * `reset` is intentionally absent here: bootstrapping prod is the intended use.
 *
 * INTERNAL — not exposed via api.*.
 */
export const bootstrap = internalAction({
  args: {},
  handler: async (ctx): Promise<{ staffId: string; staffCode: string }> => {
    const pinHash: string = await ctx.runAction(internal.auth.actions._hashPin_internal, {
      pin: "1111",
    });
    const result = await ctx.runMutation(internal.seed.internal._bootstrapCommit_internal, {
      pinHash,
    });
    return result;
  },
});

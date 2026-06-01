import type { convexTest } from "convex-test";
import { internal } from "../../_generated/api";

/**
 * Seeds a manager (real argon2 hash via `_seedHashedStaff_internal` so PIN
 * "9999" verifies for downstream manager-PIN flows) plus an active session.
 *
 * `requireSession` (`convex/auth/sessions.ts`) only reads the session row +
 * its staff row, so NO `registered_devices` row is needed for queries gated
 * by `requireManagerSession`. Mutations that emit audit rows via
 * `logAudit({ device_id })` will accept the unregistered device id — the
 * audit row is just for trace.
 *
 * `staff_sessions` REQUIRES `ended_at` + `end_reason` (both `v.union(_,
 * v.null())` — see `convex/auth/schema.ts`); pass them as `null` to match the
 * canonical seed shape used in `convex/approvals/__tests__/cancelPendingRequest.test.ts`.
 *
 * Returns ids for the manager staff row, the active session, and the device
 * label so consumers can pass them straight to mutations under test.
 */
export async function seedManagerSession(t: ReturnType<typeof convexTest>) {
  const managerId = await t.action(
    internal.auth.actions._seedHashedStaff_internal,
    { name: "Lucas", pin: "9999", role: "manager" },
  );
  const deviceId = "mgr-device";
  await t.run(async (ctx) => {
    await ctx.db.patch(managerId, { code: "S-0001" });
  });
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: managerId,
      device_id: deviceId,
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
    }),
  );
  return { managerId, sessionId, deviceId };
}

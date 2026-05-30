import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { requireManagerSession, requireSession } from "../auth/sessions";
import { internal } from "../_generated/api";

const SETUP_CODE_TTL_MS = 60 * 60 * 1000; // 1h per strategic-foundations §6
const MAX_CODE_COLLISION_RETRIES = 5;

function generateSecureSetupCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Map to [100_000, 999_999]. Modulo bias is negligible at this range.
  return String(100_000 + (buf[0] % 900_000)).padStart(6, "0");
}

export const isDeviceRegistered = query({
  args: { deviceId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query("registered_devices")
      .withIndex("by_device_id", (q) => q.eq("device_id", args.deviceId))
      .unique();
    return !!row && row.active;
  },
});

export const listStaff = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args) => {
    await requireManagerSession(ctx, args.sessionId);
    return ctx.db.query("staff").collect();
  },
});

/**
 * Returns active managers (with staff codes) for the booth manager-picker UI.
 * Any active session may call this — the list is non-sensitive (names + codes)
 * and is required for the manual-payment-override picker shown to all staff.
 * Reads go via auth/internal per ADR-034 — this module does not query `staff` directly.
 */
export const listActiveManagers = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ _id: string; name: string; code: string }>> => {
    await requireSession(ctx, args.sessionId);
    return ctx.runQuery(internal.auth.internal._listActiveManagers_internal, {});
  },
});

export const generateDeviceSetupCode = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<
    { idempotencyKey: string; sessionId: Id<"staff_sessions"> },
    { code: string; expiresAt: number }
  >(
    "staff.generateDeviceSetupCode",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId); // defensive — also provides mgrId/deviceId
      const now = Date.now();
      const expiresAt = now + SETUP_CODE_TTL_MS;

      let code: string | null = null;
      for (let i = 0; i < MAX_CODE_COLLISION_RETRIES; i++) {
        const candidate = generateSecureSetupCode();
        const collision = await ctx.db
          .query("pending_device_setups")
          .withIndex("by_code", (q) => q.eq("setup_code", candidate))
          .filter((q) => q.eq(q.field("consumed_at"), null))
          .filter((q) => q.gt(q.field("expires_at"), now))
          .unique();
        if (!collision) { code = candidate; break; }
      }
      if (!code) throw new Error("CODE_COLLISION");

      await ctx.db.insert("pending_device_setups", {
        setup_code: code,
        issued_by: mgrId,
        expires_at: expiresAt,
        consumed_at: null,
      });
      await logAudit(ctx, {
        actor_id: mgrId, action: "device.setup_code_issued",
        entity_type: "device", source: "booth_inline", device_id: deviceId,
      });
      return { code, expiresAt };
    },
    {
      staffIdFromArgs: (_a) => undefined,
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

export const activateDevice = mutation({
  args: {
    idempotencyKey: v.string(),
    code: v.string(),
    deviceLabel: v.string(),
    deviceId: v.string(),
  },
  handler: withIdempotency<
    { idempotencyKey: string; code: string; deviceLabel: string; deviceId: string },
    { _id: Id<"registered_devices">; device_id: string; label: string; active: boolean }
  >(
    "staff.activateDevice",
    async (ctx, args) => {
      if (!/^\d{6}$/.test(args.code)) throw new Error("INVALID_CODE");

      // Server-side label validation (defense-in-depth — client form also validates)
      const trimmedLabel = args.deviceLabel.trim();
      if (trimmedLabel.length === 0) throw new Error("INVALID_LABEL: deviceLabel must not be empty");
      if (args.deviceLabel.length > 64) throw new Error("INVALID_LABEL: deviceLabel must be 64 characters or fewer");

      const now = Date.now();

      // Use .collect() to defensively handle multiple rows (past-bug recovery)
      const existingRows = await ctx.db
        .query("registered_devices")
        .withIndex("by_device_id", (q) => q.eq("device_id", args.deviceId))
        .collect();

      const activeRow = existingRows.find((r) => r.active);
      if (activeRow) {
        throw new Error("Device already registered");
      }

      const pending = await ctx.db
        .query("pending_device_setups")
        .withIndex("by_code", (q) => q.eq("setup_code", args.code))
        .unique();
      if (
        !pending ||
        pending.consumed_at != null ||
        pending.expires_at < now
      ) {
        throw new Error("INVALID_CODE");
      }

      await ctx.db.patch(pending._id, { consumed_at: now });

      let deviceRowId: Id<"registered_devices">;
      let reactivated = false;

      if (existingRows.length > 0) {
        // Reactivate the most recently activated inactive row; delete the rest
        const sorted = [...existingRows].sort(
          (a, b) => (b.activated_at ?? 0) - (a.activated_at ?? 0),
        );
        const primary = sorted[0];
        deviceRowId = primary._id;
        await ctx.db.patch(primary._id, {
          active: true,
          label: args.deviceLabel,
          activated_by: pending.issued_by,
          activated_at: now,
          last_seen_at: now,
        });
        // Delete any extra duplicate rows
        for (const dup of sorted.slice(1)) {
          await ctx.db.delete(dup._id);
        }
        reactivated = true;
      } else {
        deviceRowId = await ctx.db.insert("registered_devices", {
          device_id: args.deviceId,
          label: args.deviceLabel,
          activated_by: pending.issued_by,
          activated_at: now,
          last_seen_at: now,
          active: true,
        });
      }

      await logAudit(ctx, {
        actor_id: pending.issued_by, action: "device.activated",
        entity_type: "device", entity_id: deviceRowId,
        source: "booth_inline", device_id: args.deviceId,
        metadata: { activated_via_pending_id: pending._id, label: args.deviceLabel, reactivated },
      });
      return {
        _id: deviceRowId,
        device_id: args.deviceId,
        label: args.deviceLabel,
        active: true,
      };
    },
    {
      // intentional: activateDevice runs before any session exists. Device-setup
      // codes are the auth mechanism; no requireSession is possible here.
      authCheck: async () => {},
    },
  ),
});

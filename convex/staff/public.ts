import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { requireManagerSession, requireSession } from "../auth/sessions";
import { internal } from "../_generated/api";
import { issueDeviceSetupCode } from "./internal";

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
    const rows = await ctx.db.query("staff").collect();
    // v0.2 follow-up: never expose pin_hash to the admin UI.
    return rows.map((s) => ({
      _id: s._id,
      name: s.name,
      code: s.code ?? null,
      role: s.role,
      active: s.active,
      last_login_at: s.last_login_at ?? null,
      created_at: s.created_at,
    }));
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
  ): Promise<Array<{ name: string; code: string }>> => {
    await requireSession(ctx, args.sessionId);
    return ctx.runQuery(internal.auth.internal._listActiveManagers_internal, {});
  },
});

/**
 * Rename a staff member. Session-gated (manager session required), NO PIN.
 * v0.5.3b Task 5 — names are low-sensitivity admin metadata; the manager session
 * itself is the proof of authority. Role changes use the PIN-gated action.
 */
export const updateStaffName = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    staffId: v.id("staff"),
    name: v.string(),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      staffId: Id<"staff">;
      name: string;
    },
    { ok: true }
  >(
    "staff.updateStaffName",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId);
      const name = args.name.trim();
      if (name.length === 0 || name.length > 60) throw new Error("NAME_INVALID");
      const before = await ctx.db.get(args.staffId);
      if (!before) throw new Error("STAFF_NOT_FOUND");
      await ctx.db.patch(args.staffId, { name });
      await logAudit(ctx, {
        actor_id: mgrId,
        action: "staff.updated",
        entity_type: "staff",
        entity_id: args.staffId,
        source: "booth_inline",
        device_id: deviceId,
        metadata: { field: "name" },
      });
      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

export const generateDeviceSetupCode = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<
    { idempotencyKey: string; sessionId: Id<"staff_sessions"> },
    { code: string; expiresAt: number }
  >(
    "staff.generateDeviceSetupCode",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId);
      return await issueDeviceSetupCode(ctx, {
        issuedVia: "booth_inline",
        issuedBy: mgrId,
        deviceId,
      });
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

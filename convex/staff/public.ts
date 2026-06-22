import { mutation, query, action } from "../_generated/server";
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

/**
 * SEC-04: device-activation entry point is now an ACTION (was a mutation). A
 * throwing mutation rolls back its own writes, so the throttle counter could
 * never persist across an INVALID_CODE rejection. The action mirrors the
 * loginWithPin pattern: lock pre-check → commit attempt → on INVALID_CODE,
 * record the failed attempt in a SEPARATE committed mutation, then re-throw.
 *
 * API path is preserved (api.staff.public.activateDevice) so the FE/tests need
 * only switch useMutation→useAction / t.mutation→t.action.
 */
/**
 * Self-service UI language preference. v1.2 #1 (i18n, ADR-049). Staff-session,
 * SELF-ONLY — staff_id is derived from the session, never an arg, so a staffer can
 * only set their own locale (rule #22 low-stakes config; no manager-PIN).
 */
export const setOwnLocale = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    locale: v.union(v.literal("en"), v.literal("id")),
  },
  handler: withIdempotency<
    { idempotencyKey: string; sessionId: Id<"staff_sessions">; locale: "en" | "id" },
    { ok: true }
  >(
    "staff.setOwnLocale",
    async (ctx, args) => {
      const { staffId, deviceId } = await requireSession(ctx, args.sessionId);
      await ctx.db.patch(staffId, { locale: args.locale });
      await logAudit(ctx, {
        actor_id: staffId,
        action: "staff.locale_set",
        entity_type: "staff",
        entity_id: staffId,
        source: "booth_inline",
        device_id: deviceId,
        metadata: { locale: args.locale },
      });
      return { ok: true as const };
    },
    {
      staffIdFromArgs: (_a) => undefined, // self-derived from session, not args
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});

export const activateDevice = action({
  args: {
    idempotencyKey: v.string(),
    code: v.string(),
    deviceLabel: v.string(),
    deviceId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ _id: Id<"registered_devices">; device_id: string; label: string; active: boolean }> => {
    // Cheap arg validation first (no DB) — format misses aren't brute-force
    // guesses, so they don't count toward the throttle.
    if (!/^\d{6}$/.test(args.code)) throw new Error("INVALID_CODE_FORMAT");
    const trimmedLabel = args.deviceLabel.trim();
    if (trimmedLabel.length === 0) throw new Error("INVALID_LABEL: deviceLabel must not be empty");
    if (args.deviceLabel.length > 64) throw new Error("INVALID_LABEL: deviceLabel must be 64 characters or fewer");

    // SEC-04: reject if this device or the global window is throttle-locked.
    const lock = await ctx.runQuery(internal.staff.internal._getActivationLockState_internal, {
      deviceId: args.deviceId,
    });
    if (lock.locked) throw new Error(`ACTIVATION_LOCKED:${lock.seconds_remaining}`);

    try {
      return await ctx.runMutation(internal.staff.internal._activateDeviceCommit_internal, args);
    } catch (err) {
      // SEC-04: only a wrong/expired CODE counts toward the throttle (I1: exact
      // match, not `includes` — INVALID_CODE_FORMAT/INVALID_LABEL/already-registered
      // are not brute-force guesses). Recorded in its OWN committed mutation so the
      // increment survives this rejection.
      const msg = err instanceof Error ? err.message : "";
      if (msg === "INVALID_CODE") {
        await ctx.runMutation(internal.staff.internal._recordActivationFailure_internal, {
          deviceId: args.deviceId,
        });
      }
      throw err;
    }
  },
});

// ─── Outlet device designation (v1.2) ────────────────────────────────────────
// A manager picks WHICH registered device is the booth "outlet". Only the outlet
// is subject to the start-of-day / handover SOP gate (RootLayout); every other
// device is a viewer that skips the SOP. `registered_devices` is owned by this
// module (ADR-034), so the device LIST + validation live here; the WRITE to
// `pos_settings.outlet_device_id` routes through settings/internal.

type DeviceRow = {
  _id: Id<"registered_devices">;
  device_id: string;
  label: string;
  last_seen_at: number | null;
  activated_at: number;
};

/**
 * Manager-only: list active registered devices for the outlet picker, plus the
 * currently-designated outlet device id. Explicit return type breaks the
 * cross-module `ctx.runQuery` inference cycle (TS7022).
 */
export const listRegisteredDevices = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (
    ctx,
    args,
  ): Promise<{ devices: DeviceRow[]; outletDeviceId: string | null }> => {
    const { outlet_id } = await requireManagerSession(ctx, args.sessionId);
    const rows = outlet_id
      ? await ctx.db
          .query("registered_devices")
          .withIndex("by_outlet_active", (q) => q.eq("outlet_id", outlet_id).eq("active", true))
          .collect()
      : // eslint-disable-next-line frollie-internal/index-leads-with-outlet_id -- scoped via sessionId; undefined outlet_id means migration window (manager session predates outlet assignment)
        await ctx.db
          .query("registered_devices")
          .withIndex("by_active", (q) => q.eq("active", true))
          .collect();
    const settings = await ctx.runQuery(
      internal.settings.internal._getSettings_internal,
      { outletId: outlet_id },
    );
    return {
      outletDeviceId: settings.outlet_device_id,
      devices: rows.map((d) => ({
        _id: d._id,
        device_id: d.device_id,
        label: d.label,
        last_seen_at: d.last_seen_at ?? null,
        activated_at: d.activated_at,
      })),
    };
  },
});

/**
 * Manager-only: designate the outlet device (or clear it with `deviceId: null`).
 * Manager-SESSION, not PIN — low-stakes operational config (ADR-005 tiering,
 * rule #22), same tier as receipt/ticker config. A non-null deviceId must be a
 * REGISTERED ACTIVE device (can't designate a phantom). The write goes through
 * settings/internal per ADR-034.
 */
export const setOutletDevice = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    deviceId: v.union(v.string(), v.null()),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      deviceId: string | null;
    },
    { ok: true }
  >(
    "staff.setOutletDevice",
    async (ctx, args) => {
      const { staffId } = await requireManagerSession(ctx, args.sessionId);
      if (args.deviceId !== null) {
        const dev = await ctx.db
          .query("registered_devices")
          .withIndex("by_device_id", (q) =>
            q.eq("device_id", args.deviceId as string),
          )
          .unique();
        if (!dev || !dev.active) throw new Error("DEVICE_NOT_REGISTERED");
      }
      await ctx.runMutation(
        internal.settings.internal._setOutletDevice_internal,
        { outletDeviceId: args.deviceId, staffId },
      );
      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

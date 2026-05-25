import { mutation, query, internalMutation, MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { withIdempotency } from "./idempotency";
import { logAudit } from "./audit";

const SETUP_CODE_TTL_MS = 60 * 60 * 1000; // 1h per strategic-foundations §6
const MAX_CODE_COLLISION_RETRIES = 5;

export async function requireSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string; role: "staff" | "manager" }> {
  const s = await ctx.db.get(sessionId);
  if (!s || s.ended_at != null) throw new Error("NO_SESSION");
  const staff = await ctx.db.get(s.staff_id);
  if (!staff || !staff.active) throw new Error("NO_SESSION");
  return { staffId: s.staff_id, deviceId: s.device_id, role: staff.role };
}

export async function requireManagerSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string }> {
  const { staffId, deviceId, role } = await requireSession(ctx, sessionId);
  if (role !== "manager") throw new Error("MANAGER_ONLY");
  return { staffId, deviceId };
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

export const _createStaffCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    name: v.string(),
    role: v.union(v.literal("staff"), v.literal("manager")),
    pin_hash: v.string(),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      name: string;
      role: "staff" | "manager";
      pin_hash: string;
    },
    { _id: Id<"staff">; name: string; role: "staff" | "manager" }
  >(
    "staff.createStaff",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId);
      const newId = await ctx.db.insert("staff", {
        name: args.name, pin_hash: args.pin_hash, role: args.role,
        active: true, created_at: Date.now(),
      });
      await logAudit(ctx, {
        actor_id: mgrId, action: "staff.created",
        entity_type: "staff", entity_id: newId,
        source: "booth_inline", device_id: deviceId,
      });
      return { _id: newId, name: args.name, role: args.role };
    },
  ),
});

function generateSecureSetupCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Map to [100_000, 999_999]. Modulo bias is negligible at this range.
  return String(100_000 + (buf[0] % 900_000)).padStart(6, "0");
}

export const generateDeviceSetupCode = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<
    { idempotencyKey: string; sessionId: Id<"staff_sessions"> },
    { code: string; expiresAt: number }
  >(
    "staff.generateDeviceSetupCode",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId);
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
    { staffIdFromArgs: (_a) => undefined },
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
      const now = Date.now();

      const existing = await ctx.db
        .query("registered_devices")
        .withIndex("by_device_id", (q) => q.eq("device_id", args.deviceId))
        .unique();
      if (existing && existing.active) {
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

      const deviceRowId = await ctx.db.insert("registered_devices", {
        device_id: args.deviceId,
        label: args.deviceLabel,
        activated_by: pending.issued_by,
        activated_at: now,
        last_seen_at: now,
        active: true,
      });
      await ctx.db.patch(pending._id, { consumed_at: now });

      await logAudit(ctx, {
        actor_id: pending.issued_by, action: "device.activated",
        entity_type: "device", entity_id: deviceRowId,
        source: "booth_inline", device_id: args.deviceId,
        metadata: { activated_via_pending_id: pending._id, label: args.deviceLabel },
      });
      return {
        _id: deviceRowId,
        device_id: args.deviceId,
        label: args.deviceLabel,
        active: true,
      };
    },
  ),
});

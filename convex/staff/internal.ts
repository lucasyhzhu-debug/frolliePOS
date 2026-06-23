import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { requireManagerSession } from "../auth/sessions";
import type { MutationCtx } from "../_generated/server";

const SETUP_CODE_TTL_MS = 15 * 60 * 1000; // SEC-04: 15min (was 1h) — shrinks the brute-force window
const MAX_CODE_COLLISION_RETRIES = 5;

// SEC-04: activateDevice throttle constants.
// Per-device lock mirrors the PIN lockout (5 misses → 60s). The global ceiling
// (50 failures / 15-min rolling window) is the load-bearing control: an attacker
// can rotate device_id freely, so per-device alone is bypassable.
const ACTIVATION_MAX_FAILS = 5;
const ACTIVATION_LOCKOUT_MS = 60_000;
const ACTIVATION_GLOBAL_KEY = "__global__";
const ACTIVATION_GLOBAL_CAP = 50;
const ACTIVATION_GLOBAL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Collect-and-dedupe the activation-attempt row for a key (device_id or the
 * global sentinel), keeping the most recent and deleting older duplicates in
 * the same tx. Mirrors auth/internal.ts::cleanupAndGetAttempt.
 */
async function getActivationAttempt(ctx: MutationCtx, key: string) {
  const rows = await ctx.db
    .query("pos_device_activation_attempts")
    .withIndex("by_key", (q) => q.eq("key", key))
    .collect();
  if (rows.length === 0) return null;
  const sorted = rows.slice().sort((a, b) => b.last_attempt_at - a.last_attempt_at);
  for (let i = 1; i < sorted.length; i++) await ctx.db.delete(sorted[i]._id);
  return sorted[0];
}

/**
 * SEC-04: record one failed activation. Increments the per-device counter (locks
 * that device for 60s past 5 misses) and the global rolling-window counter. On a
 * global breach (≥50 fails / 15min) the global singleton is locked until the
 * window resets so ALL activateDevice calls reject for the rest of the window —
 * but pending_device_setups is NOT wiped: nuking live codes would let an attacker
 * repeatedly DoS a manager's freshly issued code (re-issue DoS). The window-block
 * + 15-min TTL is sufficient (≤50 guesses/window against a ~900k space).
 *
 * Over-count note: because the activateDevice ACTION calls this recorder in a
 * SEPARATE (un-cached) mutation, a network retry of the action can double-count a
 * single guess. That is fail-SAFE (tightens the throttle, never loosens it) — the
 * counts here are an upper-bound rate limiter, not an exact tally.
 */
export async function recordActivationFailure(
  ctx: MutationCtx,
  deviceId: string,
): Promise<void> {
  const now = Date.now();

  // Per-device counter.
  const dev = await getActivationAttempt(ctx, deviceId);
  const devExpired = dev?.locked_until != null && dev.locked_until <= now;
  const devNext = devExpired ? 1 : (dev?.fail_count ?? 0) + 1;
  const devLock = devNext >= ACTIVATION_MAX_FAILS ? now + ACTIVATION_LOCKOUT_MS : null;
  if (dev) {
    await ctx.db.patch(dev._id, { fail_count: devNext, locked_until: devLock, last_attempt_at: now });
  } else {
    // window_start_at is only meaningful for the global rolling-window row; the
    // per-device path uses fail_count + locked_until only. Set to `now` to satisfy
    // the (non-optional) schema; device rows never read it.
    await ctx.db.insert("pos_device_activation_attempts", {
      key: deviceId, fail_count: devNext, window_start_at: now, locked_until: devLock, last_attempt_at: now,
    });
  }

  // Global rolling-window counter.
  const glob = await getActivationAttempt(ctx, ACTIVATION_GLOBAL_KEY);
  const windowExpired = glob == null || now - glob.window_start_at >= ACTIVATION_GLOBAL_WINDOW_MS;
  const globNext = windowExpired ? 1 : glob.fail_count + 1;
  const windowStart = windowExpired ? now : glob.window_start_at;
  const globBreached = globNext >= ACTIVATION_GLOBAL_CAP;
  // C1 fix: lock until the window RESETS (windowStart + WINDOW), not a fixed 60s.
  // A 60s lock let a device-rotating attacker resume ~1 guess/60s and defeat the
  // cap; locking to the window boundary enforces ≤CAP guesses per 15-min window.
  const globLock = globBreached ? windowStart + ACTIVATION_GLOBAL_WINDOW_MS : null;
  if (glob) {
    await ctx.db.patch(glob._id, {
      fail_count: globNext, window_start_at: windowStart, locked_until: globLock, last_attempt_at: now,
    });
  } else {
    await ctx.db.insert("pos_device_activation_attempts", {
      key: ACTIVATION_GLOBAL_KEY, fail_count: globNext, window_start_at: windowStart,
      locked_until: globLock, last_attempt_at: now,
    });
  }
  if (globBreached) {
    await logAudit(ctx, {
      actor_id: "system",
      action: "device.activation_throttled",
      entity_type: "device",
      source: "system",
      device_id: deviceId,
      reason: `${ACTIVATION_GLOBAL_CAP} failed activations in ${ACTIVATION_GLOBAL_WINDOW_MS / 60000}min`,
    });
  }
}

/**
 * SEC-04: clear a device's attempt row after a successful activation (the global
 * window self-expires; only the per-device counter needs an explicit reset).
 */
export async function clearActivationAttempts(ctx: MutationCtx, deviceId: string): Promise<void> {
  const rows = await ctx.db
    .query("pos_device_activation_attempts")
    .withIndex("by_key", (q) => q.eq("key", deviceId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

/**
 * SEC-04: read-only lock pre-check for the activateDevice ACTION. Returns the
 * locked state across the per-device row AND the global window (worst-case secs).
 * Read-only (no dedupe deletes) so it is safe to call from the action's query
 * stage before the commit mutation runs.
 */
export const _getActivationLockState_internal = internalQuery({
  args: { deviceId: v.string() },
  handler: async (ctx, args): Promise<{ locked: boolean; seconds_remaining: number }> => {
    const now = Date.now();
    let maxLockedUntil = 0;
    for (const key of [args.deviceId, ACTIVATION_GLOBAL_KEY]) {
      const rows = await ctx.db
        .query("pos_device_activation_attempts")
        .withIndex("by_key", (q) => q.eq("key", key))
        .collect();
      for (const r of rows) {
        if (r.locked_until != null && r.locked_until > maxLockedUntil) maxLockedUntil = r.locked_until;
      }
    }
    return maxLockedUntil > now
      ? { locked: true, seconds_remaining: Math.ceil((maxLockedUntil - now) / 1000) }
      : { locked: false, seconds_remaining: 0 };
  },
});

/**
 * SEC-04: record one failed activation as its OWN committed transaction. Invoked
 * from the activateDevice ACTION (NOT inside the commit mutation) so the counter
 * survives even though the activation rejects with INVALID_CODE — mirrors the
 * loginWithPin → _recordFailedAttempt_internal pattern (a throwing mutation would
 * roll back the increment). Never idempotency-cached: every wrong guess counts.
 */
export const _recordActivationFailure_internal = internalMutation({
  args: { deviceId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    await recordActivationFailure(ctx, args.deviceId);
  },
});

/**
 * SEC-04: the device-registration transaction (was the body of the activateDevice
 * mutation pre-v1.1). Internal — only the `staff.public.activateDevice` ACTION
 * calls it. withIdempotency dedupes a successful registration on retry. Throws
 * `INVALID_CODE` for a missing/expired/consumed code; the action records the
 * throttle failure in a separate committed mutation (a throwing mutation would
 * roll back any counter write it did itself). Lives in internal.ts per ADR-034
 * (C2 review fix — public.ts is the external surface only).
 */
export const _activateDeviceCommit_internal = internalMutation({
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
        // SEC-04: a throwing mutation rolls back its writes, so the throttle
        // counter is incremented by the activateDevice ACTION (in its own
        // committed mutation) when this INVALID_CODE surfaces — never here.
        throw new Error("INVALID_CODE");
      }

      await ctx.db.patch(pending._id, { consumed_at: now });
      // SEC-04: successful activation clears this device's failed-attempt counter.
      await clearActivationAttempts(ctx, args.deviceId);

      // v0.6: codes minted via Telegram have no staff issuer — fall back to the
      // "system" audit actor and carry the issuance channel into metadata.
      // NOTE: `source` stays "booth_inline" — activation is always a physical
      // booth act (code typed into the new device); only ISSUANCE came from
      // Telegram. Don't overload "telegram_approval" (the approval/token flow
      // source, CLAUDE.md rule #10). The channel lives in metadata.activated_via.
      const auditActor = pending.issued_by ?? ("system" as const);
      const activatedVia = pending.issued_via ?? "booth_inline";

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
          activated_by: pending.issued_by, // may be undefined (Telegram-issued)
          activated_at: now,
          last_seen_at: now,
        });
        // Delete any extra duplicate rows
        for (const dup of sorted.slice(1)) {
          await ctx.db.delete(dup._id);
        }
        reactivated = true;
      } else {
        // v2.0 OQ4: devices activate unbound; a manager binds via assignDeviceOutlet.
        deviceRowId = await ctx.db.insert("registered_devices", {
          device_id: args.deviceId,
          label: args.deviceLabel,
          activated_by: pending.issued_by, // may be undefined (Telegram-issued)
          activated_at: now,
          last_seen_at: now,
          active: true,
          // outlet_id intentionally absent — unbound at activation
        });
      }

      await logAudit(ctx, {
        actor_id: auditActor,
        action: "device.activated",
        entity_type: "device",
        entity_id: deviceRowId,
        source: "booth_inline", // activation is a physical booth act regardless of issuance channel
        device_id: args.deviceId,
        metadata: {
          activated_via_pending_id: pending._id,
          label: args.deviceLabel,
          reactivated,
          activated_via: activatedVia,
        },
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

function generateSecureSetupCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Map to [100_000, 999_999] — always exactly 6 digits, so no padding needed.
  // Modulo bias is negligible at this range (~0.004%).
  return String(100_000 + (buf[0] % 900_000));
}

/**
 * Single writer for `pending_device_setups`. Plain async fn (NOT an
 * internalMutation) so the booth mutation can call it inside its own
 * transaction — same pattern as `logAudit` (ADR-034). Both issuance paths
 * (booth-session + managers-Telegram) funnel through here so the collision
 * loop and audit shape never drift (v0.5.5 canonical-insert lesson).
 */
export async function issueDeviceSetupCode(
  ctx: MutationCtx,
  opts: {
    issuedVia: "booth_inline" | "telegram";
    issuedBy?: Id<"staff">;
    telegramIssuer?: { fromId?: number; chatTitle: string };
    deviceId?: string;
  },
): Promise<{ code: string; expiresAt: number }> {
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
    if (!collision) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error("CODE_COLLISION");

  await ctx.db.insert("pending_device_setups", {
    setup_code: code,
    issued_by: opts.issuedBy,
    issued_via: opts.issuedVia,
    issued_by_telegram: opts.telegramIssuer
      ? { from_id: opts.telegramIssuer.fromId, chat_title: opts.telegramIssuer.chatTitle }
      : undefined,
    expires_at: expiresAt,
    consumed_at: null,
  });

  await logAudit(ctx, {
    actor_id: opts.issuedBy ?? "system",
    action: "device.setup_code_issued",
    entity_type: "device",
    // Telegram issuance has no staff actor and (unlike /approve) no PIN/approval
    // token, so it is NOT a "telegram_approval" event — that source is reserved
    // for the off-booth PIN-gated approval flow (CLAUDE.md #10; the "manager
    // approvals this week" audit query filters source = telegram_approval). Use
    // the "system" source to match the "system" actor; the channel lives in
    // metadata.issued_via.
    source: opts.issuedVia === "telegram" ? "system" : "booth_inline",
    device_id: opts.deviceId,
    metadata:
      opts.issuedVia === "telegram"
        ? {
            issued_via: "telegram",
            telegram_from_id: opts.telegramIssuer?.fromId,
            chat_title: opts.telegramIssuer?.chatTitle,
          }
        : { issued_via: "booth_inline" },
  });

  return { code, expiresAt };
}

/**
 * Telegram path wrapper. The `/activatepos` internalAction calls this via
 * ctx.runMutation (an action cannot touch the db directly). No idempotencyKey:
 * the webhook dedupes by Telegram update_id (`telegram/webhook.ts:recordIfNew`),
 * so dispatch fires at most once per command.
 */
export const _issueDeviceSetupCodeFromTelegram_internal = internalMutation({
  args: {
    chatTitle: v.string(),
    fromId: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    return await issueDeviceSetupCode(ctx, {
      issuedVia: "telegram",
      telegramIssuer: { fromId: args.fromId, chatTitle: args.chatTitle },
    });
  },
});

/**
 * Commit a staff role change. Owns the last-active-manager guard so the
 * read-and-patch happens in a single mutation transaction (no race window
 * between the check and the write). Called by `staff/actions.setStaffRole`
 * AFTER the manager PIN has been verified in the action layer.
 *
 * The guard scans `staff` via the `by_role` index then JS-filters for
 * `active && _id !== targetId`. `_listActiveManagers_internal` returns code+name
 * only (no _id), so it can't support an exclude-by-id query — direct scan is
 * the correct read here. The staff table is tiny (single-booth).
 *
 * v0.5.3b post-review fix: action retry after a crash between commit and
 * action-level cache write would re-execute and double-emit the audit row.
 * withIdempotency on the `:commit`-derived key short-circuits the retry. See
 * docs/PATTERNS/idempotency-dual-call-authcheck.md and
 * refunds._commitRefund_internal for the canonical shape.
 *
 * Also: already-this-role short-circuit. A repeat patch with the same role is
 * a no-op (mirrors _deactivateStaffCommit_internal's `if (!target.active)`
 * idempotent guard), preventing a duplicate `staff.updated` audit row when a
 * manager re-confirms the same role.
 */
export const _setStaffRoleCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    staffId: v.id("staff"),
    role: v.union(v.literal("staff"), v.literal("manager"), v.literal("owner")),
    mgrId: v.id("staff"),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      staffId: Id<"staff">;
      role: "staff" | "manager" | "owner";
      mgrId: Id<"staff">;
    },
    { ok: true }
  >(
    "staff._setStaffRoleCommit_internal",
    async (ctx, args) => {
      const target = await ctx.db.get(args.staffId);
      if (!target) throw new Error("STAFF_NOT_FOUND");
      if (target.role === args.role) return { ok: true as const }; // idempotent no-op
      if (target.role === "manager" && args.role === "staff") {
        const managers = await ctx.db
          .query("staff")
          .withIndex("by_role", (q) => q.eq("role", "manager"))
          .collect();
        const otherActive = managers.filter(
          (m) => m.active && m._id !== args.staffId,
        );
        if (otherActive.length === 0) throw new Error("LAST_ACTIVE_MANAGER");
      }
      await ctx.db.patch(args.staffId, { role: args.role });
      await logAudit(ctx, {
        actor_id: args.mgrId,
        action: "staff.updated",
        entity_type: "staff",
        entity_id: args.staffId,
        source: "booth_inline",
        metadata: { field: "role", role: args.role },
      });
      return { ok: true as const };
    },
  ),
});

/**
 * Commit a staff deactivation. Owns SELF_DEACTIVATE + LAST_ACTIVE_MANAGER guards
 * so read+patch are atomic. Called by `staff/actions.deactivateStaff` AFTER
 * manager PIN verification.
 *
 * Guard order is deliberate:
 *   1. SELF_DEACTIVATE  (cheapest, semantically clearest — no DB read)
 *   2. STAFF_NOT_FOUND  (target lookup)
 *   3. already-inactive (idempotent no-op for retries past the original commit)
 *   4. LAST_ACTIVE_MANAGER (index scan + JS filter)
 *   5. patch + audit
 *
 * No session teardown: `requireSession` rejects inactive staff, so the target's
 * live session self-invalidates on its next request.
 *
 * v0.5.3b post-review fix: action retry after a crash between commit and
 * action-level cache write would re-execute. The already-inactive guard above
 * catches the duplicate patch, but withIdempotency on the `:commit`-derived key
 * adds belt-and-braces and matches refunds._commitRefund_internal's shape. See
 * docs/PATTERNS/idempotency-dual-call-authcheck.md.
 */
export const _deactivateStaffCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    staffId: v.id("staff"),
    mgrId: v.id("staff"),
  },
  handler: withIdempotency<
    { idempotencyKey: string; staffId: Id<"staff">; mgrId: Id<"staff"> },
    { ok: true }
  >(
    "staff._deactivateStaffCommit_internal",
    async (ctx, args) => {
      if (args.staffId === args.mgrId) throw new Error("SELF_DEACTIVATE");
      const target = await ctx.db.get(args.staffId);
      if (!target) throw new Error("STAFF_NOT_FOUND");
      if (!target.active) return { ok: true as const }; // idempotent no-op
      if (target.role === "manager") {
        const managers = await ctx.db
          .query("staff")
          .withIndex("by_role", (q) => q.eq("role", "manager"))
          .collect();
        const otherActive = managers.filter(
          (m) => m.active && m._id !== args.staffId,
        );
        if (otherActive.length === 0) throw new Error("LAST_ACTIVE_MANAGER");
      }
      await ctx.db.patch(args.staffId, { active: false });
      await logAudit(ctx, {
        actor_id: args.mgrId,
        action: "staff.deactivated",
        entity_type: "staff",
        entity_id: args.staffId,
        source: "booth_inline",
      });
      return { ok: true as const };
    },
  ),
});

/**
 * v2.0 Task 7 (C2): Bind (or re-bind) a registered_devices row to an outlet.
 * Called by staff.actions.assignDeviceOutlet (manager-PIN action).
 *
 * - Patches `registered_devices.outlet_id` to `targetOutletId`.
 * - If the device was ALREADY bound to a DIFFERENT outlet, force-logs out all
 *   active sessions on that device (`end_reason: "force_logout"`) so those
 *   sessions don't silently carry a stale outlet_id.
 * - Same-outlet re-assign is a no-op (no session disruption).
 * - Logs `device.assignOutlet` audit with from/to outlet IDs.
 * - Lives in staff/internal.ts: staff already owns registered_devices writes
 *   (ADR-034; the allowlist covers this module).
 */
export const _assignDeviceOutlet_internal = internalMutation({
  args: {
    deviceId: v.string(),
    targetOutletId: v.id("outlets"),
    mgrId: v.id("staff"),
    mgrDeviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const dev = await ctx.db
      .query("registered_devices")
      .withIndex("by_device_id", (q) => q.eq("device_id", args.deviceId))
      .first();
    if (!dev) throw new Error("DEVICE_NOT_FOUND");

    const fromOutletId = (dev.outlet_id as typeof args.targetOutletId | undefined) ?? null;
    const isReassign = fromOutletId !== null && fromOutletId !== args.targetOutletId;

    // Patch the outlet binding first.
    await ctx.db.patch(dev._id, { outlet_id: args.targetOutletId });

    // If the device moved to a different outlet, end all active sessions so they
    // don't carry the old outlet_id. Same-outlet assign skips this (no disruption).
    // Use by_outlet_device_active with fromOutletId (the OLD outlet) so the
    // index is outlet-scoped — a device moving outlets only has sessions on the old outlet.
    if (isReassign) {
      const fromOutletIdOrUndef = fromOutletId ?? undefined;
      // v2.0 Task 9: always use outlet-scoped index (window-tolerant: fromOutletIdOrUndef may be undefined).
      const activeSessions = await ctx.db
        .query("staff_sessions")
        .withIndex("by_outlet_device_active", (q) =>
          q.eq("outlet_id", fromOutletIdOrUndef).eq("device_id", args.deviceId).eq("ended_at", null),
        )
        .collect();
      for (const sess of activeSessions) {
        await ctx.db.patch(sess._id, { ended_at: now, end_reason: "force_logout" });
      }
    }

    await logAudit(ctx, {
      actor_id: args.mgrId,
      action: "device.assignOutlet",
      entity_type: "device",
      entity_id: dev._id,
      source: "booth_inline",
      device_id: args.mgrDeviceId,
      metadata: {
        device_id: args.deviceId,
        from_outlet_id: fromOutletId,
        to_outlet_id: args.targetOutletId,
      },
    });
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
    { _id: Id<"staff">; name: string; role: "staff" | "manager"; code: string }
  >(
    "staff.createStaff",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId, outlet_id: mgrOutletId } = await requireManagerSession(ctx, args.sessionId); // defensive — also provides mgrId/deviceId/outlet
      // Allocate next S-NNNN. Reading all staff codes inside the mutation makes
      // the read part of the OCC read-set: a concurrent createStaff that also
      // allocated will conflict and retry, so codes never collide (ADR-031 server-time
      // analogue for sequential IDs).
      const all = await ctx.db.query("staff").collect();
      const maxN = all.reduce((m, s) => {
        const n = s.code?.match(/^S-(\d{4})$/)?.[1];
        return n ? Math.max(m, parseInt(n, 10)) : m;
      }, 0);
      const code = `S-${String(maxN + 1).padStart(4, "0")}`;
      // SEC-03 scope note (v1.1): must_change_pin is intentionally NOT set here.
      // The audit (SEC-03) targeted only the hardcoded bootstrap PIN; forcing
      // rotation on every manager-created staffer is a product/UX change that
      // belongs in its own spec (deferred — v1.1 follow-up), not this audit-fix.
      const newId = await ctx.db.insert("staff", {
        name: args.name, pin_hash: args.pin_hash, role: args.role,
        active: true, created_at: Date.now(), code,
      });
      // v2.0 Task 12 (ENFORCE): login now asserts a staff_outlet_access row
      // (NO_OUTLET_ACCESS otherwise). Grant the new staffer access to the
      // creating manager's outlet so they can log in immediately — mirrors the
      // backfill (_insertStaffOutletAccess_internal) for pre-existing staff and
      // the _grantOutletAccess_internal row shape. (staff module is ALLOWLIST-ed
      // for the auth-owned staff_outlet_access table — ADR-034.)
      await ctx.db.insert("staff_outlet_access", {
        staff_id: newId,
        outlet_id: mgrOutletId,
        granted_at: Date.now(),
        granted_by: mgrId,
      });
      await logAudit(ctx, {
        actor_id: mgrId, action: "staff.created",
        entity_type: "staff", entity_id: newId,
        source: "booth_inline", device_id: deviceId,
        metadata: { outlet_id: mgrOutletId },
      });
      return { _id: newId, name: args.name, role: args.role, code };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

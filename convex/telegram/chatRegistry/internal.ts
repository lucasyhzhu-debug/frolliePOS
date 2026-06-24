// convex/telegram/chatRegistry/internal.ts
//
// ── Self-registration registry — internal surface ────────────────────────────
// All internalQuery / internalMutation / internalAction exports, plus the
// shared private impl helpers used by both this file and public.ts.
//
// Ported from convex/telegram/chatRegistry.ts (v0.4 flat file) as part of the
// v0.5.0 ADR-034 module-shape split. No behavior change.

import { v, ConvexError } from "convex/values";
import {
  internalQuery,
  internalMutation,
  internalAction,
  type QueryCtx,
  type MutationCtx,
  type ActionCtx,
} from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { sendTelegramHtml, escapeHtml } from "../../lib/telegramHtml";
import { logAudit } from "../../audit/internal";
import {
  KNOWN_TELEGRAM_ROLES,
  isKnownTelegramRole,
  ROLE_SCOPE,
  TELEGRAM_ADMIN_URL,
  TELEGRAM_BOT_USERNAME,
} from "../config";

// ─── role guard (shared with public.ts via file-level import) ────────────────

/** Throws ConvexError if `role` is not in KNOWN_TELEGRAM_ROLES. */
export function assertKnownRole(role: string): void {
  if (!isKnownTelegramRole(role)) {
    throw new ConvexError(
      `Unknown telegram role: '${role}'. Add it to KNOWN_TELEGRAM_ROLES in ` +
        `convex/telegram/config.ts (current: ${KNOWN_TELEGRAM_ROLES.join(", ") || "<empty>"}).`,
    );
  }
}

// ─── parseCommand ────────────────────────────────────────────────────────────

export type RegistryCommand = "register" | "start";

export function parseCommand(text: string): RegistryCommand | null {
  const m = /^\/(register|start)(@[A-Za-z0-9_]+)?$/.exec(text.trim());
  return m ? (m[1] as RegistryCommand) : null;
}

// ─── shared impl helpers (used by internal Convex handlers and public.ts) ────

export async function listChatsImpl(
  ctx: QueryCtx,
  includeArchived: boolean,
): Promise<Doc<"telegramChats">[]> {
  const all = await ctx.db.query("telegramChats").collect();
  return includeArchived ? all : all.filter((r) => r.archivedAt === undefined);
}

export const assignRoleArgs = {
  chatId: v.string(),
  role: v.union(v.string(), v.null()),
  outletId: v.optional(v.id("outlets")), // required for outlet-scoped roles (managers/inventory); absent for business roles (owners/ops)
  forceReassign: v.optional(v.boolean()),
  restoreIfArchived: v.optional(v.boolean()),
} as const;

export async function assignRoleImpl(
  ctx: MutationCtx,
  args: {
    chatId: string;
    role: string | null;
    outletId?: Id<"outlets">;
    forceReassign?: boolean;
    restoreIfArchived?: boolean;
  },
): Promise<void> {
  if (args.role !== null) assertKnownRole(args.role);

  const target = await ctx.db
    .query("telegramChats")
    .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
    .unique();
  if (!target) {
    throw new ConvexError(`No registered Telegram chat with id '${args.chatId}'`);
  }

  if (args.role === null) {
    // Clear both role and outlet_id atomically (role: null is a full de-assignment).
    await ctx.db.patch(target._id, { role: undefined, outlet_id: undefined });
    return;
  }

  // Enforce scope: outlet roles require outletId; business roles forbid it.
  // ROLE_SCOPE[role] is undefined for legacy "founders" alias — treat as "business".
  const scope = ROLE_SCOPE[args.role as keyof typeof ROLE_SCOPE] ?? "business";
  if (scope === "outlet" && !args.outletId) {
    throw new ConvexError("OUTLET_REQUIRED_FOR_ROLE");
  }
  if (scope !== "outlet" && args.outletId) {
    throw new ConvexError("OUTLET_NOT_ALLOWED_FOR_ROLE");
  }

  const restoringArchived = target.archivedAt !== undefined;
  if (restoringArchived && !args.restoreIfArchived) {
    throw new ConvexError(
      `Cannot assign a role to an archived chat ('${args.chatId}'). Restore it first.`,
    );
  }

  // Uniqueness check forks by scope:
  //   outlet role  → per (role, outletId) pair via by_role_outlet + JS archivedAt filter
  //   business role → bare by_role + JS filter (archivedAt===undefined && outlet_id===undefined)
  // Never .eq("outlet_id", undefined) — Convex optional-field-filter gotcha.
  let currentHolder: Doc<"telegramChats"> | null = null;
  if (scope === "outlet") {
    const rows = await ctx.db
      .query("telegramChats")
      .withIndex("by_role_outlet", (q) =>
        q.eq("role", args.role!).eq("outlet_id", args.outletId!),
      )
      .collect();
    currentHolder = rows.filter((r) => r.archivedAt === undefined)[0] ?? null;
  } else {
    // Business role: only the row with no outlet_id is the "holder" for this role.
    const rows = await ctx.db
      .query("telegramChats")
      .withIndex("by_role", (q) => q.eq("role", args.role!))
      .collect();
    currentHolder =
      rows.filter((r) => r.archivedAt === undefined && r.outlet_id === undefined)[0] ?? null;
  }

  if (currentHolder && currentHolder._id !== target._id) {
    if (!args.forceReassign) {
      throw new ConvexError(
        `Role '${args.role}' already held by chat '${currentHolder.chatId}'. Pass forceReassign: true to override.`,
      );
    }
    // On force-reassign, strip role + outlet_id from the displaced holder.
    await ctx.db.patch(currentHolder._id, { role: undefined, outlet_id: undefined });
  }

  await ctx.db.patch(target._id, {
    role: args.role,
    outlet_id: scope === "outlet" ? args.outletId : undefined,
    ...(restoringArchived ? { archivedAt: undefined } : {}),
  });
}

export async function archiveChatImpl(ctx: MutationCtx, chatId: string): Promise<void> {
  const row = await ctx.db
    .query("telegramChats")
    .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
    .unique();
  if (!row) throw new ConvexError(`No registered Telegram chat with id '${chatId}'`);
  // Clear outlet_id too — archiving is a full de-assignment (mirrors role:null in
  // assignRoleImpl). Leaving a stale outlet_id on an archived row would be a
  // dangling key once Task 9 made the field load-bearing.
  await ctx.db.patch(row._id, { archivedAt: Date.now(), role: undefined, outlet_id: undefined });
}

export async function restoreChatImpl(ctx: MutationCtx, chatId: string): Promise<void> {
  const row = await ctx.db
    .query("telegramChats")
    .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
    .unique();
  if (!row) throw new ConvexError(`No registered Telegram chat with id '${chatId}'`);
  await ctx.db.patch(row._id, { archivedAt: undefined });
}

export async function sendTestMessageImpl(ctx: ActionCtx, chatId: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const text = `🧪 Test from ${TELEGRAM_BOT_USERNAME} — wiring works!`;
  try {
    await sendTelegramHtml(botToken, chatId, text);
    await ctx.runMutation(internal.telegram.chatRegistry.internal.clearLastError, { chatId });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.length > 200 ? raw.slice(0, 199) + "…" : raw;
    await ctx.runMutation(internal.telegram.chatRegistry.internal.recordLastError, { chatId, message });
    throw err;
  }
}

// ─── SeedResult type (shared) ─────────────────────────────────────────────────

export type SeedResult =
  | { status: "inserted"; chatId: string; title: string; role: string }
  | { status: "graduated-dormant"; chatId: string; title: string; role: string }
  | { status: "already-exists-same-role"; chatId: string; title: string; role: string };

// ─── getChatIdByRole ──────────────────────────────────────────────────────────

// Shared bare-role resolution (JS post-filter on archivedAt + outlet_id absent — the
// optional-field-filter gotcha; never .eq(field, undefined)). Returns chatId | null.
async function _resolveBareRoleChatId(ctx: QueryCtx, role: string): Promise<string | null> {
  // Use the bare by_role index then post-filter in JS on archivedAt === undefined.
  // .eq("archivedAt", undefined) appears to work in convex-test but diverges in
  // prod (Convex optional-field filter gotcha — see MEMORY.md). JS post-filter is
  // the proven-safe pattern; the historical by_role_archived compound index was
  // dropped in v0.5.1 once the test was rewritten to match this same pattern.
  // outlet_id absent check: same gotcha — never .eq("outlet_id", undefined).
  const rows = await ctx.db
    .query("telegramChats")
    .withIndex("by_role", (q) => q.eq("role", role))
    .collect();
  const active = rows.filter((r) => r.archivedAt === undefined && r.outlet_id === undefined);
  return active[0]?.chatId ?? null;
}

export const getChatIdByRole = internalQuery({
  args: { role: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const hit = await _resolveBareRoleChatId(ctx, args.role);
    if (hit) return hit;

    if (
      process.env.TELEGRAM_FALLBACK_ROLE === args.role &&
      process.env.TELEGRAM_CHAT_ID
    ) {
      return process.env.TELEGRAM_CHAT_ID;
    }

    throw new Error(`No Telegram chat assigned to role '${args.role}'`);
  },
});

export const getChatIdByRoleBareOrNull = internalQuery({
  args: { role: v.string() },
  handler: (ctx, args) => _resolveBareRoleChatId(ctx, args.role), // no env fallback, no throw
});

export const getChatIdByRoleAndOutlet = internalQuery({
  args: { role: v.string(), outletId: v.id("outlets") },
  handler: async (ctx, args): Promise<string | null> => {
    // Concrete outlet_id equality is safe (not the undefined-filter gotcha).
    // Only JS-filter archivedAt (optional field — never .eq("archivedAt", undefined)).
    const rows = await ctx.db
      .query("telegramChats")
      .withIndex("by_role_outlet", (q) => q.eq("role", args.role).eq("outlet_id", args.outletId))
      .collect();
    const active = rows.filter((r) => r.archivedAt === undefined);
    return active[0]?.chatId ?? null;
  },
});

// ─── touchChatLastSeen ────────────────────────────────────────────────────────

export const touchChatLastSeen = internalMutation({
  args: { chatId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("telegramChats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .unique();
    if (!row) return;
    if (row.archivedAt !== undefined) return;
    await ctx.db.patch(row._id, { lastSeenAt: Date.now() });
  },
});

// ─── registerChat (/register handler) ────────────────────────────────────────

export const registerChat = internalAction({
  args: {
    chatId: v.string(),
    chatType: v.union(
      v.literal("private"),
      v.literal("group"),
      v.literal("supergroup"),
    ),
    title: v.string(),
    registeredBy: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");

    const result = await ctx.runMutation(
      internal.telegram.chatRegistry.internal.upsertChatRow,
      args,
    );

    const safeTitle = escapeHtml(args.title);
    let html: string;
    if (result.status === "inserted") {
      html = `✅ Chat registered as <b>${safeTitle}</b> (${args.chatType}). Assign a role at ${TELEGRAM_ADMIN_URL}`;
    } else if (result.status === "dormant") {
      html = `ℹ️ Already registered (no role assigned yet). Assign at ${TELEGRAM_ADMIN_URL}`;
    } else {
      html = `ℹ️ Already registered as role <b>${escapeHtml(result.role)}</b>. Change at ${TELEGRAM_ADMIN_URL}`;
    }
    await sendTelegramHtml(token, args.chatId, html);
  },
});

/** @internal Atomic read+write backing registerChat's three-state branch. */
export const upsertChatRow = internalMutation({
  args: {
    chatId: v.string(),
    chatType: v.union(
      v.literal("private"),
      v.literal("group"),
      v.literal("supergroup"),
    ),
    title: v.string(),
    registeredBy: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    { status: "inserted" } | { status: "dormant" } | { status: "live"; role: string }
  > => {
    const existing = await ctx.db
      .query("telegramChats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .unique();
    const now = Date.now();
    if (!existing) {
      await ctx.db.insert("telegramChats", {
        chatId: args.chatId,
        chatType: args.chatType,
        title: args.title,
        registeredBy: args.registeredBy,
        registeredAt: now,
        lastSeenAt: now,
      });
      return { status: "inserted" };
    }
    await ctx.db.patch(existing._id, { lastSeenAt: now });
    if (existing.role) return { status: "live", role: existing.role };
    return { status: "dormant" };
  },
});

// ─── replyStartHelp (/start handler) ──────────────────────────────────────────

export const replyStartHelp = internalAction({
  args: { chatId: v.string() },
  handler: async (_ctx, args): Promise<void> => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
    await sendTelegramHtml(
      token,
      args.chatId,
      `Hi! I'm ${escapeHtml(TELEGRAM_BOT_USERNAME)}. Send /register@${escapeHtml(TELEGRAM_BOT_USERNAME)} to register this chat.`,
    );
  },
});

// ─── management: internal* surface ────────────────────────────────────────────

export const listChats = internalQuery({
  args: { includeArchived: v.boolean() },
  handler: (ctx, args) => listChatsImpl(ctx, args.includeArchived),
});

export const assignRole = internalMutation({
  args: assignRoleArgs,
  handler: (ctx, args) => assignRoleImpl(ctx, args),
});

export const archiveChat = internalMutation({
  args: { chatId: v.string() },
  handler: (ctx, args) => archiveChatImpl(ctx, args.chatId),
});

export const restoreChat = internalMutation({
  args: { chatId: v.string() },
  handler: (ctx, args) => restoreChatImpl(ctx, args.chatId),
});

// ─── _auditMgrSendTest_internal ────────────────────────────────────────────────

/**
 * Audit a manager-initiated Telegram test send. Called via ctx.runMutation
 * from mgrSendTest (an action — cannot logAudit directly). Emitted AFTER
 * the Telegram send returns OK so failures don't leave false-positive trails;
 * lastError on the row already records the failure case.
 */
export const _auditMgrSendTest_internal = internalMutation({
  args: { staffId: v.id("staff"), chatId: v.string() },
  handler: async (ctx, args) => {
    await logAudit(ctx, {
      actor_id: args.staffId,
      action: "telegram.test_sent",
      entity_type: "telegramChats",
      entity_id: args.chatId,
      source: "booth_inline",
    });
  },
});

// ─── sendTestMessage ──────────────────────────────────────────────────────────

export const sendTestMessage = internalAction({
  args: { chatId: v.string() },
  handler: (ctx, args) => sendTestMessageImpl(ctx, args.chatId),
});

// ─── getChatRow ────────────────────────────────────────────────────────────────

/** @internal Existence lookup for mgrSendTest. */
export const getChatRow = internalQuery({
  args: { chatId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("telegramChats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .unique();
  },
});

// ─── recordLastError / clearLastError ─────────────────────────────────────────

/** @internal Writes lastError on send failure. */
export const recordLastError = internalMutation({
  args: { chatId: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("telegramChats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, { lastError: { at: Date.now(), message: args.message } });
  },
});

/** @internal Clears lastError after a successful send. */
export const clearLastError = internalMutation({
  args: { chatId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("telegramChats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .unique();
    if (!row || row.lastError === undefined) return;
    await ctx.db.patch(row._id, { lastError: undefined });
  },
});

// ─── seedChatFromEnv (one-shot migration bootstrap) ───────────────────────────

export const seedChatFromEnv = internalAction({
  args: { role: v.string() },
  handler: async (ctx, args): Promise<SeedResult> => {
    assertKnownRole(args.role);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN env var missing");
    if (!chatId) throw new Error("TELEGRAM_CHAT_ID env var missing");

    const res = await fetch(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`,
    );
    const json = (await res.json()) as {
      ok: boolean;
      result?: { type: string; title?: string };
      description?: string;
    };
    if (!res.ok || !json.ok || !json.result) {
      throw new Error(`Telegram getChat failed: ${res.status} ${json.description ?? "unknown"}`);
    }
    const rawType = json.result.type;
    if (rawType !== "private" && rawType !== "group" && rawType !== "supergroup") {
      throw new Error(`Unsupported chat type from Telegram: ${rawType}`);
    }
    const title = json.result.title ?? "(untitled)";

    return await ctx.runMutation(internal.telegram.chatRegistry.internal.seedFromEnvWrite, {
      chatId,
      chatType: rawType,
      title,
      role: args.role,
    });
  },
});

/** @internal The 4-state branch for seedChatFromEnv. */
export const seedFromEnvWrite = internalMutation({
  args: {
    chatId: v.string(),
    chatType: v.union(v.literal("private"), v.literal("group"), v.literal("supergroup")),
    title: v.string(),
    role: v.string(),
  },
  handler: async (ctx, args): Promise<SeedResult> => {
    assertKnownRole(args.role);
    const now = Date.now();
    const existing = await ctx.db
      .query("telegramChats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .unique();

    if (!existing) {
      await ctx.db.insert("telegramChats", {
        chatId: args.chatId,
        chatType: args.chatType,
        title: args.title,
        role: args.role,
        registeredAt: now,
        lastSeenAt: now,
      });
      return { status: "inserted", chatId: args.chatId, title: args.title, role: args.role };
    }
    if (existing.role === undefined) {
      await ctx.db.patch(existing._id, { role: args.role, lastSeenAt: now, archivedAt: undefined });
      return { status: "graduated-dormant", chatId: args.chatId, title: existing.title, role: args.role };
    }
    if (existing.role === args.role) {
      return { status: "already-exists-same-role", chatId: args.chatId, title: existing.title, role: args.role };
    }
    throw new ConvexError(
      `Chat ${args.chatId} already registered with role '${existing.role}'. Reassign via the mgr UI.`,
    );
  },
});

// convex/telegram/chatRegistry.ts
//
// ── Self-registration registry (v0.4) ────────────────────────────────────────
// Ported from convex-telegram-bot-starter with the following Frollie-specific
// adaptations:
//   • admin* public surface replaced by mgr* (manager-session gated).
//   • requireAdminKey(adminKey) → await requireManagerSession(ctx, sessionId).
//   • sessionId: v.id("staff_sessions") replaces adminKey: v.string().
//   • isKnownTelegramRole validation added to mgrAssignRole.
//   • Import paths adjusted for Frollie's module layout.
//   • mgr* mutations (mgrAssignRole / mgrArchiveChat / mgrRestoreChat) accept
//     `idempotencyKey: v.string()` and wrap their handler in withIdempotency
//     so a retry replays the cached response instead of double-mutating
//     (ADR-013). mgrListChats (query) and mgrSendTest (action) intentionally
//     stay un-keyed — queries are read-only and the action's atomic commit
//     lives in clearLastError/recordLastError downstream.
//   • mgrSendTest is an action and so cannot read ctx.db directly — it gates
//     authz by calling auth._requireManagerSession_internal via ctx.runQuery
//     BEFORE the external Telegram send.
//
// Impl cores (listChatsImpl, assignRoleImpl, archiveChatImpl, restoreChatImpl,
// sendTestMessageImpl) remain private — the mgr* and internal* surfaces share
// them by calling them with native signatures (e.g. archiveChatImpl(ctx, chatId)).

import { v, ConvexError } from "convex/values";
import {
  internalQuery,
  internalMutation,
  internalAction,
  query,
  mutation,
  action,
  type QueryCtx,
  type MutationCtx,
  type ActionCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { sendTelegramHtml, escapeHtml } from "../lib/telegramHtml";
import { requireManagerSession } from "../auth/sessions";
import { withIdempotency } from "../idempotency/internal";
import {
  KNOWN_TELEGRAM_ROLES,
  isKnownTelegramRole,
  TELEGRAM_ADMIN_URL,
  TELEGRAM_BOT_USERNAME,
} from "./config";

// ─── role guard ──────────────────────────────────────────────────────────────

/** Throws ConvexError if `role` is not in KNOWN_TELEGRAM_ROLES. */
function assertKnownRole(role: string): void {
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

// ─── getChatIdByRole ─────────────────────────────────────────────────────────

export const getChatIdByRole = internalQuery({
  args: { role: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const row = await ctx.db
      .query("telegramChats")
      .withIndex("by_role_archived", (q) =>
        q.eq("role", args.role).eq("archivedAt", undefined),
      )
      .first();
    if (row) return row.chatId;

    if (
      process.env.TELEGRAM_FALLBACK_ROLE === args.role &&
      process.env.TELEGRAM_CHAT_ID
    ) {
      return process.env.TELEGRAM_CHAT_ID;
    }

    throw new Error(`No Telegram chat assigned to role '${args.role}'`);
  },
});

// ─── touchChatLastSeen ───────────────────────────────────────────────────────

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
      internal.telegram.chatRegistry.upsertChatRow,
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

// ─── replyStartHelp (/start handler) ─────────────────────────────────────────

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

// ─── management: shared impls ────────────────────────────────────────────────

async function listChatsImpl(
  ctx: QueryCtx,
  includeArchived: boolean,
): Promise<Doc<"telegramChats">[]> {
  const all = await ctx.db.query("telegramChats").collect();
  return includeArchived ? all : all.filter((r) => r.archivedAt === undefined);
}

async function assignRoleImpl(
  ctx: MutationCtx,
  args: {
    chatId: string;
    role: string | null;
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
    await ctx.db.patch(target._id, { role: undefined });
    return;
  }

  const restoringArchived = target.archivedAt !== undefined;
  if (restoringArchived && !args.restoreIfArchived) {
    throw new ConvexError(
      `Cannot assign a role to an archived chat ('${args.chatId}'). Restore it first.`,
    );
  }

  const currentHolder = await ctx.db
    .query("telegramChats")
    .withIndex("by_role_archived", (q) =>
      q.eq("role", args.role!).eq("archivedAt", undefined),
    )
    .first();
  if (currentHolder && currentHolder._id !== target._id) {
    if (!args.forceReassign) {
      throw new ConvexError(
        `Role '${args.role}' already held by chat '${currentHolder.chatId}'. Pass forceReassign: true to override.`,
      );
    }
    await ctx.db.patch(currentHolder._id, { role: undefined });
  }
  await ctx.db.patch(target._id, {
    role: args.role,
    ...(restoringArchived ? { archivedAt: undefined } : {}),
  });
}

async function archiveChatImpl(ctx: MutationCtx, chatId: string): Promise<void> {
  const row = await ctx.db
    .query("telegramChats")
    .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
    .unique();
  if (!row) throw new ConvexError(`No registered Telegram chat with id '${chatId}'`);
  await ctx.db.patch(row._id, { archivedAt: Date.now(), role: undefined });
}

async function restoreChatImpl(ctx: MutationCtx, chatId: string): Promise<void> {
  const row = await ctx.db
    .query("telegramChats")
    .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
    .unique();
  if (!row) throw new ConvexError(`No registered Telegram chat with id '${chatId}'`);
  await ctx.db.patch(row._id, { archivedAt: undefined });
}

const assignRoleArgs = {
  chatId: v.string(),
  role: v.union(v.string(), v.null()),
  forceReassign: v.optional(v.boolean()),
  restoreIfArchived: v.optional(v.boolean()),
} as const;

// ─── management: internal* surface ───────────────────────────────────────────

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

// ─── management: mgr* surface (manager-session gated) ────────────────────────

export const mgrListChats = query({
  args: { sessionId: v.id("staff_sessions"), includeArchived: v.boolean() },
  handler: async (ctx, args) => {
    await requireManagerSession(ctx, args.sessionId);
    return listChatsImpl(ctx, args.includeArchived);
  },
});

// withIdempotency serializes the handler return via JSON.stringify so the cache
// row's `response_blob` is non-null. The impls return void, so the wrappers
// return `{ ok: true }` — small, JSON-safe, and gives clients a uniform shape.
type MgrOpResult = { ok: true };

export const mgrAssignRole = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    ...assignRoleArgs,
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      chatId: string;
      role: string | null;
      forceReassign?: boolean;
      restoreIfArchived?: boolean;
    },
    MgrOpResult
  >("telegram.mgrAssignRole", async (ctx, args) => {
    await requireManagerSession(ctx, args.sessionId);
    if (args.role !== null && !isKnownTelegramRole(args.role)) {
      throw new ConvexError(
        `Unknown telegram role: '${args.role}'. Add it to KNOWN_TELEGRAM_ROLES in convex/telegram/config.ts.`,
      );
    }
    await assignRoleImpl(ctx, {
      chatId: args.chatId,
      role: args.role,
      forceReassign: args.forceReassign,
      restoreIfArchived: args.restoreIfArchived,
    });
    return { ok: true as const };
  }),
});

export const mgrArchiveChat = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    chatId: v.string(),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      chatId: string;
    },
    MgrOpResult
  >("telegram.mgrArchiveChat", async (ctx, args) => {
    await requireManagerSession(ctx, args.sessionId);
    await archiveChatImpl(ctx, args.chatId);
    return { ok: true as const };
  }),
});

export const mgrRestoreChat = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    chatId: v.string(),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      chatId: string;
    },
    MgrOpResult
  >("telegram.mgrRestoreChat", async (ctx, args) => {
    await requireManagerSession(ctx, args.sessionId);
    await restoreChatImpl(ctx, args.chatId);
    return { ok: true as const };
  }),
});

// ─── sendTestMessage ─────────────────────────────────────────────────────────

async function sendTestMessageImpl(ctx: ActionCtx, chatId: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const text = `🧪 Test from ${TELEGRAM_BOT_USERNAME} — wiring works!`;
  try {
    await sendTelegramHtml(botToken, chatId, text);
    await ctx.runMutation(internal.telegram.chatRegistry.clearLastError, { chatId });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.length > 200 ? raw.slice(0, 199) + "…" : raw;
    await ctx.runMutation(internal.telegram.chatRegistry.recordLastError, { chatId, message });
    throw err;
  }
}

export const sendTestMessage = internalAction({
  args: { chatId: v.string() },
  handler: (ctx, args) => sendTestMessageImpl(ctx, args.chatId),
});

export const mgrSendTest = action({
  args: { sessionId: v.id("staff_sessions"), chatId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    // Actions cannot call ctx.db directly — gate authz by running the
    // session-check internalQuery FIRST. Throws MANAGER_ONLY / NO_SESSION
    // before any external Telegram call so a stale UI can't fire test sends.
    await ctx.runQuery(
      internal.auth.internal._requireManagerSession_internal,
      { sessionId: args.sessionId },
    );
    // Existence check mirrors the internal path (clear error message if absent).
    const row = await ctx.runQuery(internal.telegram.chatRegistry.getChatRow, {
      chatId: args.chatId,
    });
    if (!row) throw new ConvexError(`No registered Telegram chat with id '${args.chatId}'`);
    await sendTestMessageImpl(ctx, args.chatId);
  },
});

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

type SeedResult =
  | { status: "inserted"; chatId: string; title: string; role: string }
  | { status: "graduated-dormant"; chatId: string; title: string; role: string }
  | { status: "already-exists-same-role"; chatId: string; title: string; role: string };

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

    return await ctx.runMutation(internal.telegram.chatRegistry.seedFromEnvWrite, {
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

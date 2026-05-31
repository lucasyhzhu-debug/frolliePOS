// convex/telegram/chatRegistry/public.ts
//
// ── Self-registration registry — public (mgr*) surface ───────────────────────
// Manager-session-gated query / mutations / action callable via api.*.
// All heavy lifting delegated to the shared impl helpers in internal.ts.
//
// Ported from convex/telegram/chatRegistry.ts (v0.4 flat file) as part of the
// v0.5.0 ADR-034 module-shape split. No behavior change.
//
// NOTE: The 3 mgr* mutations (mgrAssignRole, mgrArchiveChat, mgrRestoreChat)
// will surface new authCheck lint warnings from the v0.5.0 idempotency-required
// rule. That is EXPECTED — Wave 2 Task 6 (authcheck-migrate) fixes them.

import { v, ConvexError } from "convex/values";
import {
  query,
  mutation,
  action,
} from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { requireManagerSession } from "../../auth/sessions";
import { withIdempotency } from "../../idempotency/internal";
import { logAudit } from "../../audit/internal";
import { isKnownTelegramRole } from "../config";
import {
  listChatsImpl,
  assignRoleArgs,
  assignRoleImpl,
  archiveChatImpl,
  restoreChatImpl,
  sendTestMessageImpl,
} from "./internal";

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
    // authCheck below has already validated; re-read for typed staffId on audit.
    const { staffId } = await requireManagerSession(ctx, args.sessionId);
    if (args.role !== null && !isKnownTelegramRole(args.role)) {
      throw new ConvexError(
        `Unknown telegram role: '${args.role}'. Add it to KNOWN_TELEGRAM_ROLES in convex/telegram/config.ts.`,
      );
    }
    // Capture the row's prior role + the displaced row's prior role (if any)
    // for the audit before/after. assignRoleImpl re-queries internally.
    const target = await ctx.db
      .query("telegramChats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .unique();
    const previousRole = target?.role ?? null;
    let displacedFromChatId: string | undefined;
    if (args.role !== null) {
      // Broader index + JS post-filter on archivedAt === undefined (prod gotcha pattern).
      const roleRows = await ctx.db
        .query("telegramChats")
        .withIndex("by_role", (q) => q.eq("role", args.role!))
        .collect();
      const holder = roleRows.filter((r) => r.archivedAt === undefined)[0];
      if (holder && holder.chatId !== args.chatId) displacedFromChatId = holder.chatId;
    }

    await assignRoleImpl(ctx, {
      chatId: args.chatId,
      role: args.role,
      forceReassign: args.forceReassign,
      restoreIfArchived: args.restoreIfArchived,
    });

    // Audit AFTER impl succeeds — assignment changes which Telegram chat receives
    // approval messages, so misroutes need attribution (ADR-007 + rule #2).
    await logAudit(ctx, {
      actor_id: staffId,
      action: "telegram.role_assigned",
      entity_type: "telegramChats",
      entity_id: args.chatId,
      before_state: { role: previousRole },
      after_state: { role: args.role },
      source: "booth_inline",
      metadata: {
        ...(displacedFromChatId ? { displaced_from_chat_id: displacedFromChatId } : {}),
        ...(args.forceReassign ? { force_reassign: true } : {}),
        ...(args.restoreIfArchived ? { restored_from_archive: true } : {}),
      },
    });
    return { ok: true as const };
  }, {
    authCheck: async (ctx, args) => {
      await requireManagerSession(ctx, args.sessionId);
    },
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
    const { staffId } = await requireManagerSession(ctx, args.sessionId);
    const target = await ctx.db
      .query("telegramChats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .unique();
    // Idempotent re-archive: if already archived, return without re-patching
    // archivedAt or emitting a false-transition audit row. archiveChatImpl
    // would otherwise overwrite archivedAt with a fresh Date.now() and the
    // audit would claim archived:false → true even when no transition happened.
    if (target?.archivedAt !== undefined) {
      return { ok: true as const };
    }
    const previousRole = target?.role ?? null;
    await archiveChatImpl(ctx, args.chatId);
    await logAudit(ctx, {
      actor_id: staffId,
      action: "telegram.chat_archived",
      entity_type: "telegramChats",
      entity_id: args.chatId,
      before_state: { role: previousRole, archived: false },
      after_state: { role: null, archived: true },
      source: "booth_inline",
    });
    return { ok: true as const };
  }, {
    authCheck: async (ctx, args) => {
      await requireManagerSession(ctx, args.sessionId);
    },
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
    const { staffId } = await requireManagerSession(ctx, args.sessionId);
    const target = await ctx.db
      .query("telegramChats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .unique();
    // Idempotent re-restore: if already not-archived, return without emitting
    // a false-transition audit row (mirror of mgrArchiveChat).
    if (target === null || target.archivedAt === undefined) {
      return { ok: true as const };
    }
    await restoreChatImpl(ctx, args.chatId);
    await logAudit(ctx, {
      actor_id: staffId,
      action: "telegram.chat_restored",
      entity_type: "telegramChats",
      entity_id: args.chatId,
      before_state: { archived: true },
      after_state: { archived: false },
      source: "booth_inline",
    });
    return { ok: true as const };
  }, {
    authCheck: async (ctx, args) => {
      await requireManagerSession(ctx, args.sessionId);
    },
  }),
});

export const mgrSendTest = action({
  args: { sessionId: v.id("staff_sessions"), chatId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    // Actions cannot call ctx.db directly — gate authz by running the
    // session-check internalQuery FIRST. Throws MANAGER_ONLY / NO_SESSION
    // before any external Telegram call so a stale UI can't fire test sends.
    const { staffId } = await ctx.runQuery(
      internal.auth.internal._requireManagerSession_internal,
      { sessionId: args.sessionId },
    );
    // Existence check mirrors the internal path (clear error message if absent).
    const row = await ctx.runQuery(internal.telegram.chatRegistry.internal.getChatRow, {
      chatId: args.chatId,
    });
    if (!row) throw new ConvexError(`No registered Telegram chat with id '${args.chatId}'`);
    await sendTestMessageImpl(ctx, args.chatId);
    // Audit only on successful send — failures leave a trail via recordLastError
    // on the chat row itself, so no audit-vs-state divergence.
    await ctx.runMutation(internal.telegram.chatRegistry.internal._auditMgrSendTest_internal, {
      staffId,
      chatId: args.chatId,
    });
  },
});

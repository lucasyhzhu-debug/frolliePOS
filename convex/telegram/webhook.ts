// convex/telegram/webhook.ts
import { v } from "convex/values";
import { httpAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { constantTimeEqual } from "../lib/constantTimeEqual";
import {
  buildCommandMatcher,
  type CommandRegistration,
  type MessageContext,
} from "./commands";

interface WebhookResult { status: number; body: string }

export interface WebhookDeps {
  /** R5: atomic dedupe. Returns true iff THIS call inserted the row. */
  recordIfNew: (updateId: number) => Promise<boolean>;
  /** Matcher built from the app's command registrations. */
  match: (text: string) => { command: CommandRegistration } | null;
  /**
   * Optional (v2): called best-effort for every NON-command message (any text
   * that isn't a known slash command, plus non-text updates). Wire this to
   * touchChatLastSeen when using the self-registration registry so the admin UI
   * shows live "last seen" stamps. Omit it for the simple single-chat setup.
   * Never deduped, never blocks the 200 ACK.
   */
  onNonCommandMessage?: (msg: MessageContext) => Promise<void>;
}

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number; type?: string; title?: string };
    from?: { id?: number };
  };
}

/** Coerce Telegram's chat.type string to our union, defaulting to "group". */
function normalizeChatType(t: string | undefined): MessageContext["chatType"] {
  return t === "private" || t === "group" || t === "supergroup" ? t : "group";
}

/**
 * Pure handler — no Convex runtime dependency. The httpAction wires `ctx` into
 * `deps`. Exported separately so it's unit-testable without convex-test.
 */
export async function decideWebhookOutcome(input: {
  providedSecret: string | null;
  expectedSecret: string | undefined;
  body: TelegramUpdate;
  deps: WebhookDeps;
}): Promise<WebhookResult> {
  // Auth — 401 before any state change.
  if (!input.expectedSecret || !input.providedSecret) {
    return { status: 401, body: "unauthorized" };
  }
  if (!constantTimeEqual(input.providedSecret, input.expectedSecret)) {
    return { status: 401, body: "unauthorized" };
  }

  const updateId = input.body.update_id;
  const msg = input.body.message;
  if (typeof updateId !== "number") return { status: 200, body: "ok" };
  if (!msg) return { status: 200, body: "ok" };

  const chatIdNum = msg.chat?.id;
  if (typeof chatIdNum !== "number") return { status: 200, body: "ok" };

  const ctx: MessageContext = {
    chatId: String(chatIdNum),
    chatType: normalizeChatType(msg.chat?.type),
    title: msg.chat?.title ?? "(untitled)",
    fromId: msg.from?.id,
    text: typeof msg.text === "string" ? msg.text : "",
  };

  // Best-effort lastSeen stamp — non-critical, never blocks the 200 ACK.
  const tryTouch = async () => {
    if (!input.deps.onNonCommandMessage) return;
    try { await input.deps.onNonCommandMessage(ctx); } catch { /* best-effort */ }
  };

  // Non-text update (sticker, photo, …) — best-effort touch, no dedupe.
  if (typeof msg.text !== "string") {
    await tryTouch();
    return { status: 200, body: "ok" };
  }

  const match = input.deps.match(ctx.text);
  if (!match) {
    // Unknown slash command → silent 200, no touch (typo, not chat activity).
    // Regular text → best-effort lastSeen stamp.
    if (!ctx.text.trim().startsWith("/")) await tryTouch();
    return { status: 200, body: "ok" };
  }

  const isNew = await input.deps.recordIfNew(updateId);
  if (!isNew) return { status: 200, body: "ok" };

  // C3: never return non-200 once we've committed the dedupe row. If dispatch
  // throws, retries see the row exists and skip — turning a transient error into
  // a permanent 500 loop. ACK 200 and log instead.
  try {
    await match.command.dispatch(ctx);
  } catch (err) {
    console.warn("[telegram] dispatch failed after recordIfNew committed", err);
  }
  return { status: 200, body: "ok" };
}

// ── Convex glue: atomic dedupe + httpAction ──────────────────────────────────

export const recordIfNew = internalMutation({
  args: { updateId: v.number() },
  handler: async (ctx, args): Promise<boolean> => {
    const existing = await ctx.db
      .query("telegramUpdates")
      .withIndex("by_update_id", (q) => q.eq("updateId", args.updateId))
      .unique();
    if (existing) return false;
    await ctx.db.insert("telegramUpdates", {
      updateId: args.updateId,
      receivedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Build the httpAction. Example apps call this once at boot, passing a factory
 * that — given the request-scoped `Scheduler` — returns the command registry.
 * The factory pattern is required because `dispatch` typically calls
 * `scheduler.runAfter(...)`, and `ctx.scheduler` is only valid INSIDE the
 * httpAction (not at module scope).
 *
 * The second arg opts into the self-registration registry: pass `true` to wire
 * non-command messages to touchChatLastSeen. Leave it off for the simple setup.
 */
import type { Scheduler } from "convex/server";

export function buildHandleTelegramWebhook(
  buildRegistrations: (scheduler: Scheduler) => CommandRegistration[],
  options?: { trackLastSeen?: boolean },
) {
  return httpAction(async (ctx, request) => {
    let body: TelegramUpdate;
    try {
      body = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const registrations = buildRegistrations(ctx.scheduler);
    const match = buildCommandMatcher(registrations);
    const outcome = await decideWebhookOutcome({
      providedSecret: request.headers.get("X-Telegram-Bot-Api-Secret-Token"),
      expectedSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
      body,
      deps: {
        recordIfNew: (updateId) =>
          ctx.runMutation(internal.telegram.webhook.recordIfNew, { updateId }),
        match,
        onNonCommandMessage: options?.trackLastSeen
          ? async (m) => {
              await ctx.runMutation(internal.telegram.chatRegistry.touchChatLastSeen, { chatId: m.chatId });
            }
          : undefined,
      },
    });
    return new Response(outcome.body, { status: outcome.status });
  });
}

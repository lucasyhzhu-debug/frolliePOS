// convex/telegram/config.ts
// Frollie POS — Telegram role allowlist and bot metadata.
// This is the ONLY file adapted for self-registration; chatRegistry.ts ships verbatim.

export const KNOWN_TELEGRAM_ROLES = ["managers", "owners", "inventory", "ops"] as const;

export type TelegramRole = (typeof KNOWN_TELEGRAM_ROLES)[number];

// Transitional alias: the founders chat is rebound to `owners` by the backfill
// (Task 12). Accept `"founders"` as a known role through the migration window so a
// resolver/FE rollback doesn't orphan the chat; drop it in a later cleanup.
const LEGACY_ROLE_ALIASES = ["founders"] as const;

export function isKnownTelegramRole(s: string): s is TelegramRole {
  return (KNOWN_TELEGRAM_ROLES as readonly string[]).includes(s)
    || (LEGACY_ROLE_ALIASES as readonly string[]).includes(s);
}

// Single source of truth for routing scope. The resolver and the mgr admin
// validation both read this. owners/ops = business-wide (no outlet_id);
// managers/inventory = per-outlet.
export const ROLE_SCOPE = {
  owners: "business",
  ops: "business",
  managers: "outlet",
  inventory: "outlet",
} as const satisfies Record<TelegramRole, "business" | "outlet">;

// Guard process access so this module stays browser-safe — the frontend
// imports `KNOWN_TELEGRAM_ROLES` from here for the /mgr/telegram-chats UI,
// and browsers have no `process` global. Convex (server) gets the real
// env values; Vite (client) falls back to the defaults.
const envOrUndef = (typeof process !== "undefined" ? process.env : undefined) ?? {};

export const TELEGRAM_ADMIN_URL =
  envOrUndef.TELEGRAM_ADMIN_URL ?? "http://localhost:5173/mgr/telegram-chats";

export const TELEGRAM_BOT_USERNAME =
  envOrUndef.TELEGRAM_BOT_USERNAME ?? "FrolliePOS_Bot";

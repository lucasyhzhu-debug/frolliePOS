// convex/telegram/config.ts
// Frollie POS — Telegram role allowlist and bot metadata.
// This is the ONLY file adapted for self-registration; chatRegistry.ts ships verbatim.

export const KNOWN_TELEGRAM_ROLES = ["managers", "founders", "inventory"] as const;

export type TelegramRole = (typeof KNOWN_TELEGRAM_ROLES)[number];

export function isKnownTelegramRole(s: string): s is TelegramRole {
  return (KNOWN_TELEGRAM_ROLES as readonly string[]).includes(s);
}

// Guard process access so this module stays browser-safe — the frontend
// imports `KNOWN_TELEGRAM_ROLES` from here for the /mgr/telegram-chats UI,
// and browsers have no `process` global. Convex (server) gets the real
// env values; Vite (client) falls back to the defaults.
const envOrUndef = (typeof process !== "undefined" ? process.env : undefined) ?? {};

export const TELEGRAM_ADMIN_URL =
  envOrUndef.TELEGRAM_ADMIN_URL ?? "http://localhost:5173/mgr/telegram-chats";

export const TELEGRAM_BOT_USERNAME =
  envOrUndef.TELEGRAM_BOT_USERNAME ?? "FrolliePOS_Bot";

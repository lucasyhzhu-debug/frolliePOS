// convex/telegram/config.ts
// Frollie POS — Telegram role allowlist and bot metadata.
// This is the ONLY file adapted for self-registration; chatRegistry.ts ships verbatim.

export const KNOWN_TELEGRAM_ROLES = ["managers", "founders"] as const;

export type TelegramRole = (typeof KNOWN_TELEGRAM_ROLES)[number];

export function isKnownTelegramRole(s: string): s is TelegramRole {
  return (KNOWN_TELEGRAM_ROLES as readonly string[]).includes(s);
}

export const TELEGRAM_ADMIN_URL =
  process.env.TELEGRAM_ADMIN_URL ?? "http://localhost:5173/mgr/telegram-chats";

export const TELEGRAM_BOT_USERNAME =
  process.env.TELEGRAM_BOT_USERNAME ?? "FrolliePOS_Bot";

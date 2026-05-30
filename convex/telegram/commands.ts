// convex/telegram/commands.ts

/**
 * The parsed message context handed to a command's `dispatch`. v2 added this so
 * registry commands like `/register` can read which chat sent them. Commands that
 * don't need it (e.g. `/ping`) simply ignore the argument — a zero-parameter
 * `dispatch: async () => {…}` is still assignable to this signature.
 */
export interface MessageContext {
  /** chat.id as a string (sidesteps the -100… supergroup number range). */
  chatId: string;
  /** Normalised chat type (anything unexpected is coerced to "group"). */
  chatType: "private" | "group" | "supergroup";
  /** chat.title, or "(untitled)" for private chats / missing titles. */
  title: string;
  /** Telegram user id of the sender, if present. */
  fromId: number | undefined;
  /** The raw message text that matched the command. */
  text: string;
}

/**
 * Registration for a Telegram slash command. The webhook routes matched commands
 * to `dispatch`. Dispatch is async — the implementation typically schedules
 * an internalAction via `ctx.scheduler.runAfter(0, internal.X.Y, args)`, but
 * the registry is agnostic to that detail (only depends on a Promise return).
 */
export interface CommandRegistration {
  /** The command name WITHOUT the leading slash (e.g. "ping", "pack", "register"). */
  name: string;
  /**
   * Called when the command matches, with the parsed message context. Must not
   * throw — wrap your runtime errors (the webhook logs dispatch failures but
   * always ACKs 200 to avoid Telegram's retry loop).
   */
  dispatch: (msg: MessageContext) => Promise<void>;
}

export interface CommandMatch {
  command: CommandRegistration;
}

/**
 * Build a strict-mode command matcher. Returns a function that accepts the raw
 * message text and returns the matched command (or null). Strict mode = no
 * trailing args allowed; "/ping now" does NOT match the "ping" command. This
 * mirrors the Frollie pack-list bot's intentional choice (trailing args almost
 * always indicate user typos, not parameter intent — and v1 commands take no
 * parameters). If you want lenient matching in v2, swap the regex to a
 * head-only match (`^\\/${name}(@[A-Za-z0-9_]+)?\\b`).
 *
 * MATCHING IS CASE-SENSITIVE. `/PING` will NOT match a registration for
 * "ping" — this follows Telegram's convention (the in-app command list always
 * sends lowercase) and keeps the matcher predictable. If you want case-
 * insensitive matching, lowercase `text` before passing in OR add the `i`
 * regex flag at construction time.
 */
export function buildCommandMatcher(
  registrations: CommandRegistration[],
): (text: string) => CommandMatch | null {
  const compiled = registrations.map((c) => ({
    command: c,
    regex: new RegExp(`^\\/${escapeRegex(c.name)}(@[A-Za-z0-9_]+)?$`),
  }));
  return (text: string) => {
    const trimmed = text.trim();
    for (const { command, regex } of compiled) {
      if (regex.test(trimmed)) return { command };
    }
    return null;
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

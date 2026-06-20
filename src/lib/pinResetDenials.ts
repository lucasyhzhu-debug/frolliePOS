import { SHOWN_PIN_RESET_DENIALS_KEY } from "@/lib/storage-keys";

function read(): string[] {
  try {
    const raw = localStorage.getItem(SHOWN_PIN_RESET_DENIALS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** True if this denial requestId has already been shown to the staffer. */
export function hasShownDenial(requestId: string): boolean {
  return read().includes(requestId);
}

/** Cap the retained set so it can't grow unboundedly over the booth's lifetime.
 *  Denials are rare and the server only surfaces ones inside a ~10-min window,
 *  so the most-recent 100 ids are always more than enough to dedup against. */
const MAX_RETAINED = 100;

/** Record that this denial requestId has been shown (idempotent). */
export function markDenialShown(requestId: string): void {
  const ids = read();
  if (ids.includes(requestId)) return;
  ids.push(requestId);
  if (ids.length > MAX_RETAINED) ids.splice(0, ids.length - MAX_RETAINED);
  try {
    localStorage.setItem(SHOWN_PIN_RESET_DENIALS_KEY, JSON.stringify(ids));
  } catch {
    // quota / private-mode write failure — skip; the toast may re-fire on a
    // later remount, which is strictly better than throwing out of the effect.
  }
}

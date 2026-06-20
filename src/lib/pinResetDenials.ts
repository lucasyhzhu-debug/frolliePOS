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

/** Record that this denial requestId has been shown (idempotent). */
export function markDenialShown(requestId: string): void {
  const ids = read();
  if (ids.includes(requestId)) return;
  ids.push(requestId);
  localStorage.setItem(SHOWN_PIN_RESET_DENIALS_KEY, JSON.stringify(ids));
}

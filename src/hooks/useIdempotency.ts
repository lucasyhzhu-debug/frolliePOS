import { useEffect, useState } from "react";
import { openDB, type IDBPDatabase } from "idb";

/**
 * IDB-persisted idempotency key generator. ADR-013.
 *
 * ## Why IDB?
 * The v0.2 implementation used `useMemo` — keys lived only in component memory.
 * A full-page reload mid-mutation (e.g. F5 during a Xendit payment) generated a
 * fresh key on the next render. The server treated that as a *new* mutation and
 * issued a second charge. IDB survives page reloads so the same intent within its
 * 24-hour TTL window always resolves to the same key, and the server's dedupe
 * table returns the cached result rather than executing the mutation again.
 *
 * ## Contract for callers — IMPORTANT
 * `useIdempotency(intent)` now returns `string | undefined`. It is `undefined`
 * during the first render while the async IDB read is in flight. Callers MUST
 * guard `if (!key) return;` before passing the key to any mutation or action.
 * In practice the IDB round-trip resolves in < 1 ms (it's a local read), so the
 * button is only unguarded for a single paint cycle.
 *
 * ## TTL
 * Keys expire after 24 hours (`TTL_MS`). The server also deduplicates for 24 h
 * via `pos_idempotency` (ADR-013). When the key expires in IDB a new UUID is
 * generated — this is intentional: a 24 h old in-flight mutation should not be
 * considered a duplicate of a fresh attempt.
 *
 * ## Intent string
 * Callers own the intent string. Use a natural composite key that uniquely
 * identifies "what the user is trying to do right now":
 *   - `"login:${staffId}:${deviceId}"` — PIN login attempt
 *   - `"activate:${deviceId}"` — device activation
 *   - `"logout:${sessionId}"` — session logout
 * Include IDs so switching accounts or devices gets a fresh key automatically.
 *
 * ## clearIntent
 * Call `clearIntent(intent)` when the user explicitly retries after a failure
 * they want re-executed (e.g. user edits the cart and retries payment). This
 * deletes the IDB row; the next `useIdempotency(intent)` call generates a new
 * UUID so the server does not treat it as a duplicate.
 */

const DB_NAME = "frollie-idem";
const STORE = "keys";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface IdemRow {
  key: string;
  expires_at: number;
}

// Module-level singleton so every hook instance in the same JS context shares
// one open connection rather than racing to open multiple.
let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

/**
 * For tests only — resets the cached dbPromise so each test gets a clean DB
 * connection after `indexedDB.deleteDatabase(...)`.
 */
export function __resetForTests(): void {
  dbPromise = null;
}

/**
 * Returns the persisted key for `intent`, or creates a new one if absent or
 * expired. The key is formatted `"${intent}:${crypto.randomUUID()}"`.
 */
async function getOrCreate(intent: string): Promise<string> {
  const db = await getDb();
  const row = (await db.get(STORE, intent)) as IdemRow | undefined;
  if (row && row.expires_at > Date.now()) {
    return row.key;
  }
  const key = `${intent}:${crypto.randomUUID()}`;
  await db.put(STORE, { key, expires_at: Date.now() + TTL_MS } satisfies IdemRow, intent);
  return key;
}

/**
 * Mounted `useIdempotency(intent)` hooks register a rotate callback here so
 * `clearIntent(intent)` can refresh their in-memory key WITHOUT a remount.
 *
 * Why this is load-bearing: the hook reads its key once (effect keyed on the
 * stable `intent`). Deleting the IDB row alone does NOT change the value the
 * mounted hook already holds — and the server's `pos_idempotency` row for that
 * key survives for 24h. So a long-lived screen that fires the same intent twice
 * (e.g. a manager editing several products in one `/mgr/products` session) would
 * reuse the spent key, the server would REPLAY the first call's cached response,
 * and the 2nd+ mutation would silently no-op. Notifying mounted hooks here makes
 * every existing `clearIntent` call site behave the way its authors assumed:
 * "the next attempt gets a fresh key."
 */
const rotateListeners = new Map<string, Set<() => void>>();

/**
 * Deletes the stored key for `intent`, then rotates the key on any currently
 * mounted `useIdempotency(intent)` hook so the next mutation on the same screen
 * (no remount) uses a fresh UUID — the server then treats it as a new request
 * instead of replaying the cached response.
 */
export async function clearIntent(intent: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, intent);
  // Notify AFTER the row is gone so each hook's getOrCreate mints a fresh UUID.
  const listeners = rotateListeners.get(intent);
  if (listeners) for (const cb of listeners) cb();
}

/**
 * React hook. Returns the IDB-persisted idempotency key for `intent`, or
 * `undefined` while the initial async IDB read is in flight.
 *
 * Callers MUST guard: `if (!key) return;` before using the key.
 *
 * A `clearIntent(intent)` call rotates this key in place (no remount needed):
 * `key` drops to `undefined` for one paint while the fresh UUID is minted, so
 * the standard `if (!key) return` guard also disables the control mid-rotation.
 */
export function useIdempotency(intent: string): string | undefined {
  const [key, setKey] = useState<string | undefined>(undefined);
  // Bumped by clearIntent (via the rotate subscription) to force regeneration.
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getOrCreate(intent).then((k) => {
      if (!cancelled) setKey(k);
    });
    return () => {
      cancelled = true;
    };
  }, [intent, rotation]);

  // Subscribe to clearIntent(intent) so a same-mount retry rotates the key.
  useEffect(() => {
    const rotate = () => {
      setKey(undefined); // re-guard callers until the fresh key resolves
      setRotation((r) => r + 1);
    };
    let set = rotateListeners.get(intent);
    if (!set) {
      set = new Set();
      rotateListeners.set(intent, set);
    }
    set.add(rotate);
    return () => {
      set!.delete(rotate);
      if (set!.size === 0) rotateListeners.delete(intent);
    };
  }, [intent]);

  return key;
}

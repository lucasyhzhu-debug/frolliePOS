import { useEffect, useState } from "react";
import { openDB, type IDBPDatabase } from "idb";
import { DEVICE_ID_KEY } from "@/lib/storage-keys";


const DB_NAME = "frollie-device";
const DB_VERSION = 1;
const STORE = "kv";
const IDB_KEY = "device-id";

let dbPromise: Promise<IDBPDatabase> | null = null;
function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) { if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); },
    });
  }
  return dbPromise;
}

/**
 * Stable per-installation device UUID. Strategic foundations §6 specifies
 * localStorage + IndexedDB. v0.2 honors both: IDB is authoritative; localStorage
 * is the fast path that survives most clears.
 *
 * Returns `null` while the IDB reconcile is in flight — callers must handle null
 * (show loading / skip queries) rather than consuming a transient UUID that may
 * get swapped once IDB resolves.
 */
export function useDeviceId(): string | null {
  // Start null — no synchronous UUID generation. The effect resolves the
  // authoritative id from IDB (and localStorage) before calling setId.
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await getDb();
        const idbId = (await db.get(STORE, IDB_KEY)) as string | undefined;
        const lsId = typeof localStorage !== "undefined"
          ? localStorage.getItem(DEVICE_ID_KEY)
          : null;

        let finalId: string;

        if (idbId) {
          // IDB is authoritative.
          finalId = idbId;
          if (lsId !== idbId) {
            try { localStorage.setItem(DEVICE_ID_KEY, finalId); } catch { /* private mode */ }
          }
        } else if (lsId) {
          // localStorage has a value but IDB doesn't — backfill IDB.
          finalId = lsId;
          await db.put(STORE, finalId, IDB_KEY);
        } else {
          // First ever install — generate, write both.
          finalId = crypto.randomUUID();
          try { localStorage.setItem(DEVICE_ID_KEY, finalId); } catch { /* private mode */ }
          await db.put(STORE, finalId, IDB_KEY);
        }

        if (!cancelled) setId(finalId);
      } catch (e) {
        console.warn("[useDeviceId] IDB unavailable", e);
        // Graceful fallback: use localStorage or generate ephemeral id.
        if (!cancelled) {
          const lsId = typeof localStorage !== "undefined"
            ? localStorage.getItem(DEVICE_ID_KEY)
            : null;
          if (lsId) {
            setId(lsId);
          } else {
            const fresh = crypto.randomUUID();
            try { localStorage.setItem(DEVICE_ID_KEY, fresh); } catch { /* */ }
            setId(fresh);
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return id;
}

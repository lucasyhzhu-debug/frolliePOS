import { useEffect, useState } from "react";
import { openDB, type IDBPDatabase } from "idb";

const LS_KEY = "frollie-device-id";
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
 * localStorage + IndexedDB. v0.2 honors both: localStorage is the fast path,
 * IDB is the backup that survives "Clear browsing data" clearing only
 * localStorage.
 */
export function useDeviceId(): string {
  // Synchronous: read localStorage immediately so the first render has a value.
  // The async IDB read backfills in case localStorage was empty.
  const [id, setId] = useState<string>(() => {
    const ls = typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null;
    if (ls) return ls;
    const fresh = crypto.randomUUID();
    try { localStorage.setItem(LS_KEY, fresh); } catch { /* private mode */ }
    return fresh;
  });

  // On mount: check IDB. If IDB has a previous id and localStorage was empty
  // (so we just generated a fresh one in useState), swap to the IDB id.
  // Also write the current id back to IDB if missing.
  useEffect(() => {
    (async () => {
      try {
        const db = await getDb();
        const idbId = (await db.get(STORE, IDB_KEY)) as string | undefined;
        const ls = localStorage.getItem(LS_KEY);

        if (idbId && idbId !== id) {
          // IDB has the authoritative id; the value generated in useState
          // was a transient guess. Restore the IDB id and rewrite localStorage.
          setId(idbId);
          try { localStorage.setItem(LS_KEY, idbId); } catch { /* */ }
        } else if (!idbId) {
          // First mount ever — write to IDB.
          await db.put(STORE, ls ?? id, IDB_KEY);
        }
      } catch (e) {
        console.warn("[useDeviceId] IDB unavailable", e);
      }
    })();
    // Run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return id;
}

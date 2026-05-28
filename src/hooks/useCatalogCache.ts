import { useEffect, useRef, useState } from "react";
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "frollie-cache";
const DB_VERSION = 1;
const STORE = "catalog";
const KEY = "snapshot";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

/** Test-only — resets the cached connection so tests can re-init IDB. */
export function __resetForTests() {
  dbPromise = null;
}

/**
 * IDB-backed snapshot of the live `api.catalog.public.catalog` query.
 *
 * - On mount, hydrates `snapshot` from IDB (cold-start works offline).
 * - When `live` changes to a non-undefined value (the Convex query resolves),
 *   writes that payload to IDB AND swaps it in as the current snapshot.
 * - The caller should consume `snapshot ?? live` so the live value wins
 *   on subsequent mounts.
 *
 * This is the v0.2 implementation of ADR-025 "catalog — stale-while-revalidate"
 * for the Convex WebSocket model: workbox can't cache WS frames, so the cache
 * lives in IDB instead.
 *
 * Race guard (Fix 12): Effect 1 (IDB read) must NOT overwrite Effect 2's fresh
 * live snapshot if Effect 2 fired first. liveSeenRef tracks whether a live value
 * has been written; Effect 1 skips setSnapshot when the ref is already true.
 */
export function useCatalogCache<T>(live: T | undefined): {
  hydrated: boolean;
  snapshot: T | null;
} {
  const [hydrated, setHydrated] = useState(false);
  const [snapshot, setSnapshot] = useState<T | null>(null);

  // Tracks whether Effect 2 has set a fresh live value, so Effect 1's async
  // IDB read doesn't stomp it if IDB resolves after Effect 2.
  const liveSeenRef = useRef(false);

  // Effect 1: hydrate from IDB on mount (runs once).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await getDb();
        const val = (await db.get(STORE, KEY)) as T | undefined;
        // Only set if Effect 2 hasn't already provided a fresher live value.
        if (!cancelled && val && !liveSeenRef.current) setSnapshot(val);
      } catch (e) {
        // IDB failures are non-fatal — fall back to live-only.
        console.warn("[useCatalogCache] IDB read failed", e);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Effect 2: write fresh payload to IDB + swap snapshot whenever live updates.
  useEffect(() => {
    if (!live) return;
    liveSeenRef.current = true;
    setSnapshot(live);
    (async () => {
      try {
        const db = await getDb();
        await db.put(STORE, live, KEY);
      } catch (e) {
        console.warn("[useCatalogCache] IDB write failed", e);
      }
    })();
  }, [live]);

  return { hydrated, snapshot };
}

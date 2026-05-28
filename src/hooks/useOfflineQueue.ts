import { useCallback, useEffect, useState } from "react";
import { openDB, type IDBPDatabase } from "idb";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * IDB-backed queue for offline `commitCart(intent=draft)` payloads.
 *
 * ## Why this exists
 * Draft commits (saving a cart without charging) need to survive network
 * outages. When the device is offline, `enqueue` stores the payload in IDB
 * so it can be `flush`ed once connectivity is restored.
 *
 * ## Charge is online-only
 * The CHARGE path (Xendit invoice creation) is never queued here — it requires
 * a live network connection. Only `intent=draft` commits are queued.
 *
 * ## Idempotency dedup
 * Items are keyed by `idempotencyKey`. Re-enqueueing the same key is a no-op
 * (IDB `put` overwrites). If a flush races the original online path, the
 * server's `withIdempotency` wrapper deduplicates and returns the cached
 * result rather than creating a duplicate transaction.
 *
 * ## Flush semantics
 * `flush` calls the executor for every queued item via `Promise.allSettled`.
 * Items whose executor call resolves successfully are deleted from IDB.
 * Items whose executor call rejects are retained for the next flush attempt.
 * If any item failed, `flush` throws `"Some queued items failed to flush"`.
 */

const DB_NAME = "frollie-offline";
const STORE = "draft-queue";

export interface QueuedDraft {
  idempotencyKey: string;
  sessionId: Id<"staff_sessions">;
  lines: Array<{ productId: Id<"pos_products">; qty: number }>;
  voucherCode?: string;
  enqueued_at: number;
}

// Module-level singleton so every hook instance in the same JS context shares
// one open connection rather than racing to open multiple.
let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "idempotencyKey" });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * For tests only — resets the cached dbPromise so each test gets a clean DB
 * connection after clearing the IDB store.
 */
export function __resetForTests(): void {
  dbPromise = null;
}

export interface UseOfflineQueueResult {
  /** Count of items currently waiting in the queue. */
  pending: number;
  /**
   * Add a draft to the queue. If an item with the same `idempotencyKey`
   * already exists it is overwritten (idempotent re-enqueue).
   */
  enqueue: (item: Omit<QueuedDraft, "enqueued_at">) => Promise<void>;
  /**
   * Attempt to send all queued items via `executor`. Successfully-sent items
   * are removed from IDB. Failed items are retained for the next flush.
   * Throws `"Some queued items failed to flush"` if any executor call rejects.
   */
  flush: () => Promise<void>;
}

/**
 * React hook. Returns `{ pending, enqueue, flush }` backed by an IDB store.
 *
 * @param executor  Called with each queued draft during `flush`. Should call
 *                  `commitCart` (or equivalent) on the Convex backend.
 */
export function useOfflineQueue(
  executor: (draft: QueuedDraft) => Promise<Id<"pos_transactions">>,
): UseOfflineQueueResult {
  const [pending, setPending] = useState(0);

  const refreshCount = useCallback(async () => {
    const db = await getDb();
    const count = await db.count(STORE);
    setPending(count);
  }, []);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  const enqueue = useCallback(
    async (item: Omit<QueuedDraft, "enqueued_at">) => {
      const db = await getDb();
      const row: QueuedDraft = { ...item, enqueued_at: Date.now() };
      await db.put(STORE, row);
      await refreshCount();
    },
    [refreshCount],
  );

  const flush = useCallback(async () => {
    const db = await getDb();
    const items: QueuedDraft[] = await db.getAll(STORE);

    const results = await Promise.allSettled(
      items.map(async (item) => {
        await executor(item);
        await db.delete(STORE, item.idempotencyKey);
      }),
    );

    await refreshCount();

    const anyFailed = results.some((r) => r.status === "rejected");
    if (anyFailed) {
      throw new Error("Some queued items failed to flush");
    }
  }, [executor, refreshCount]);

  return { pending, enqueue, flush };
}

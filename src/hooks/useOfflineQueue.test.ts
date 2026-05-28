import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { openDB } from "idb";
import { useOfflineQueue, __resetForTests } from "./useOfflineQueue";
import type { Id } from "../../convex/_generated/dataModel";

// fake-indexeddb/auto is imported globally in vitest.setup.ts — no import needed here.

const DB_NAME = "frollie-offline";
const STORE = "draft-queue";

/**
 * Clear all rows in the IDB store without deleting the database.
 * Opening and clearing (rather than deleteDatabase + reopen) avoids the
 * version-change transaction race that makes fake-indexeddb unreliable.
 */
async function clearStore() {
  __resetForTests();
  const db = await openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE))
        d.createObjectStore(STORE, { keyPath: "idempotencyKey" });
    },
  });
  await db.clear(STORE);
  db.close();
  __resetForTests();
}

const FAKE_SESSION = "session_abc123" as Id<"staff_sessions">;
const FAKE_PRODUCT = "product_xyz789" as Id<"pos_products">;

const SAMPLE_DRAFT = {
  idempotencyKey: "draft:test:1",
  sessionId: FAKE_SESSION,
  lines: [{ productId: FAKE_PRODUCT, qty: 2 }],
};

describe("useOfflineQueue", () => {
  beforeEach(async () => {
    await clearStore();
  });

  it("enqueue stores a payload + idempotencyKey + ts → pending becomes 1", async () => {
    const executor = vi.fn().mockResolvedValue("txn_123" as Id<"pos_transactions">);
    const { result } = renderHook(() => useOfflineQueue(executor));

    // Initial pending should be 0.
    await waitFor(() => expect(result.current.pending).toBe(0));

    await act(async () => {
      await result.current.enqueue(SAMPLE_DRAFT);
    });

    await waitFor(() => expect(result.current.pending).toBe(1));
  });

  it("flush runs each queued item via the executor and clears on success → executor called once, pending 0", async () => {
    const executor = vi.fn().mockResolvedValue("txn_123" as Id<"pos_transactions">);
    const { result } = renderHook(() => useOfflineQueue(executor));

    await waitFor(() => expect(result.current.pending).toBe(0));

    await act(async () => {
      await result.current.enqueue(SAMPLE_DRAFT);
    });
    await waitFor(() => expect(result.current.pending).toBe(1));

    await act(async () => {
      await result.current.flush();
    });

    expect(executor).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.pending).toBe(0));
  });

  it("flush retains failed items (executor throws) → pending stays 1", async () => {
    const executor = vi.fn().mockRejectedValue(new Error("network error"));
    const { result } = renderHook(() => useOfflineQueue(executor));

    await waitFor(() => expect(result.current.pending).toBe(0));

    await act(async () => {
      await result.current.enqueue(SAMPLE_DRAFT);
    });
    await waitFor(() => expect(result.current.pending).toBe(1));

    await act(async () => {
      try {
        await result.current.flush();
      } catch {
        // Expected: flush throws when some items fail.
      }
    });

    expect(executor).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.pending).toBe(1));
  });
});

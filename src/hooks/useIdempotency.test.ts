import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { openDB } from "idb";
import { useIdempotency, clearIntent, __resetForTests } from "./useIdempotency";

// fake-indexeddb/auto is imported globally in vitest.setup.ts — no import needed here.

const DB_NAME = "frollie-idem";
const STORE = "keys";

/**
 * Clear all rows in the IDB store without deleting the database.
 * Opening and clearing (rather than deleteDatabase + reopen) avoids the
 * version-change transaction race that makes fake-indexeddb unreliable.
 */
async function clearStore() {
  // Reset the module-level singleton first so getDb() opens fresh.
  __resetForTests();
  const db = await openDB(DB_NAME, 1, {
    upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); },
  });
  await db.clear(STORE);
  db.close();
  // Reset again so the hook's next getDb() call re-opens its own handle.
  __resetForTests();
}

describe("useIdempotency", () => {
  beforeEach(async () => {
    await clearStore();
  });

  it("returns undefined on first render, then resolves to a key", async () => {
    const { result } = renderHook(() => useIdempotency("login:citra"));

    // First render is always undefined — IDB is async.
    expect(result.current).toBeUndefined();

    // After the IDB effect settles it should be a non-empty string.
    await waitFor(() => expect(result.current).toBeDefined());
    expect(typeof result.current).toBe("string");
    expect(result.current!.length).toBeGreaterThan(0);
  });

  it("returns a stable key for the same intent across mounts", async () => {
    // First mount — wait for key to resolve.
    const { result: r1, unmount } = renderHook(() => useIdempotency("sale:123"));
    await waitFor(() => expect(r1.current).toBeDefined());
    const key1 = r1.current!;
    unmount();

    // Reset the singleton so the second mount opens a fresh connection,
    // but do NOT clear the store — we want IDB persistence to kick in.
    __resetForTests();

    // Second mount — same intent should return the same key from IDB.
    const { result: r2 } = renderHook(() => useIdempotency("sale:123"));
    await waitFor(() => expect(r2.current).toBeDefined());
    expect(r2.current).toBe(key1);
  });

  it("returns the same key across re-renders for the same intent", async () => {
    const { result, rerender } = renderHook(
      ({ intent }) => useIdempotency(intent),
      { initialProps: { intent: "login:citra" } },
    );
    await waitFor(() => expect(result.current).toBeDefined());
    const k1 = result.current!;

    rerender({ intent: "login:citra" });
    // Key must not change on re-render with same intent.
    expect(result.current).toBe(k1);
  });

  it("returns different keys for different intents", async () => {
    const { result: r1 } = renderHook(() => useIdempotency("login:citra"));
    const { result: r2 } = renderHook(() => useIdempotency("login:bayu"));

    await waitFor(() => expect(r1.current).toBeDefined());
    await waitFor(() => expect(r2.current).toBeDefined());

    expect(r1.current).not.toBe(r2.current);
  });

  it("returns a different key when intent changes", async () => {
    const { result, rerender } = renderHook(
      ({ intent }) => useIdempotency(intent),
      { initialProps: { intent: "login:citra" } },
    );
    await waitFor(() => expect(result.current).toBeDefined());
    const k1 = result.current!;

    rerender({ intent: "login:bayu" });
    await waitFor(() => expect(result.current).not.toBe(k1));
    expect(result.current).toBeDefined();
  });

  it("clearIntent removes the key — next call returns a fresh one", async () => {
    const { result: r1, unmount } = renderHook(() => useIdempotency("sale:456"));
    await waitFor(() => expect(r1.current).toBeDefined());
    const key1 = r1.current!;
    unmount();

    // Clear the intent.
    await act(async () => {
      await clearIntent("sale:456");
    });
    __resetForTests();

    // Remount — should get a NEW key.
    const { result: r2 } = renderHook(() => useIdempotency("sale:456"));
    await waitFor(() => expect(r2.current).toBeDefined());
    expect(r2.current).not.toBe(key1);
  });

  // 24h-expiry test: manually insert a row with an expired timestamp, then
  // verify that useIdempotency replaces it with a fresh key.
  it("replaces an expired key with a fresh one", async () => {
    const intent = "sale:789";
    const expiredKey = `${intent}:expired-uuid`;

    // Pre-populate IDB with an already-expired row.
    const db = await openDB(DB_NAME, 1, {
      upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); },
    });
    await db.put(STORE, { key: expiredKey, expires_at: Date.now() - 1 }, intent);
    db.close();
    __resetForTests();

    const { result } = renderHook(() => useIdempotency(intent));
    await waitFor(() => expect(result.current).toBeDefined());

    // Must NOT reuse the expired key.
    expect(result.current).not.toBe(expiredKey);
    // Must be a fresh key that starts with the intent prefix.
    expect(result.current!.startsWith(intent)).toBe(true);
  });
});

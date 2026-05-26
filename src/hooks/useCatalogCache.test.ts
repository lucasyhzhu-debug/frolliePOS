import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { openDB } from "idb";
import { useCatalogCache, __resetForTests } from "./useCatalogCache";

const DB = "frollie-cache";
const STORE = "catalog";

async function clearIdb() {
  const db = await openDB(DB, 1, {
    upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); },
  });
  await db.clear(STORE);
  db.close();
}

describe("useCatalogCache", () => {
  beforeEach(async () => {
    __resetForTests();
    await clearIdb();
  });

  it("returns null snapshot when IDB is empty", async () => {
    const { result } = renderHook(() => useCatalogCache(undefined));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.snapshot).toBeNull();
  });

  it("writes the fresh payload to IDB and reads it back on next mount", async () => {
    const fresh = { products: [{ _id: "p1", name: "X" }], skus: [], components: [], stockLevels: [] };
    const { result, rerender, unmount } = renderHook(({ live }) => useCatalogCache(live), {
      initialProps: { live: undefined as typeof fresh | undefined },
    });

    await waitFor(() => expect(result.current.hydrated).toBe(true));

    rerender({ live: fresh });
    await waitFor(() => expect(result.current.snapshot).toEqual(fresh));
    unmount();

    __resetForTests();
    const { result: r2 } = renderHook(() => useCatalogCache(undefined));
    await waitFor(() => expect(r2.current.hydrated).toBe(true));
    expect(r2.current.snapshot).toEqual(fresh);
  });

  it("Effect 2 (live) wins over Effect 1 (IDB stale) in race (Fix 12)", async () => {
    // Pre-populate IDB with a stale snapshot.
    const stale = { products: [{ _id: "stale", name: "Stale" }], skus: [], components: [], stockLevels: [] };
    const db = await openDB(DB, 1);
    await db.put(STORE, stale, "snapshot");
    db.close();

    __resetForTests();

    // Mount with a fresh live value already available on first render.
    const fresh = { products: [{ _id: "fresh", name: "Fresh" }], skus: [], components: [], stockLevels: [] };
    const { result } = renderHook(() => useCatalogCache(fresh));

    // After both effects settle, snapshot must be FRESH — Effect 2 wins.
    // If Effect 1 stomped Effect 2, snapshot would be STALE.
    await waitFor(() => expect(result.current.snapshot).toEqual(fresh));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    // Confirm stale never leaked through.
    expect(result.current.snapshot).not.toEqual(stale);
  });
});

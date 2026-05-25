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
});

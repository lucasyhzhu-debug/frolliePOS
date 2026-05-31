import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { openDB } from "idb";
import { DEVICE_ID_KEY } from "@/lib/storage-keys";
import { useDeviceId } from "./useDeviceId";

const DB = "frollie-device";
const STORE = "kv";

async function clearAll() {
  localStorage.clear();
  const db = await openDB(DB, 1, {
    upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); },
  });
  await db.clear(STORE);
  db.close();
}

describe("useDeviceId", () => {
  beforeEach(async () => { await clearAll(); });

  it("returns null initially, then a UUID after IDB resolves (Fix 8)", async () => {
    const { result } = renderHook(() => useDeviceId());

    // Initial render must be null — no synchronous UUID generation.
    expect(result.current).toBeNull();

    // After the async IDB effect settles, it should be a valid UUID.
    await waitFor(() => expect(result.current).toMatch(/^[0-9a-f-]{36}$/));
  });

  it("generates a UUID on first mount + persists it in localStorage + IDB", async () => {
    const { result, unmount } = renderHook(() => useDeviceId());
    await waitFor(() => expect(result.current).toMatch(/^[0-9a-f-]{36}$/));
    const id1 = result.current as string;
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBe(id1);

    const db = await openDB(DB, 1);
    expect(await db.get(STORE, "device-id")).toBe(id1);
    db.close();

    unmount();
    const { result: result2 } = renderHook(() => useDeviceId());
    await waitFor(() => expect(result2.current).toBe(id1));
  });

  it("recovers the id from IDB when localStorage is cleared", async () => {
    const { result, unmount } = renderHook(() => useDeviceId());
    await waitFor(() => expect(result.current).toMatch(/^[0-9a-f-]{36}$/));
    const id1 = result.current as string;
    unmount();

    // Simulate a localStorage wipe (browser data cleared)
    localStorage.clear();

    const { result: result2 } = renderHook(() => useDeviceId());
    await waitFor(() => expect(result2.current).toBe(id1));
  });
});

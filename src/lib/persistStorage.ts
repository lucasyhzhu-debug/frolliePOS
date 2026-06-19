/**
 * Ask the browser to mark this origin's storage as *persistent* so it is not
 * evicted between sessions.
 *
 * Why this exists: the device identity (`useDeviceId`) lives in IndexedDB +
 * localStorage. By default a desktop browser keeps that storage in the
 * "best-effort" bucket, which it may evict on close / under storage pressure /
 * in some privacy configurations. When it does, the next visit mints a fresh
 * device UUID that no longer matches the `registered_devices` row, forcing a
 * re-activation even though the server-side registration never expired.
 *
 * `navigator.storage.persist()` moves the origin to the "persistent" bucket.
 * Installed PWAs (the booth Android device) are usually granted this
 * automatically — which is why the booth never reactivates but a desktop tab
 * does. Calling it explicitly closes that gap for browser-tab usage.
 *
 * Fire-and-forget, feature-detected, never throws. A user who has an explicit
 * "clear data on close" setting can still wipe storage — persistence reduces
 * automatic eviction, it does not override a deliberate manual clear.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) {
      return false;
    }
    // Already persistent → don't re-request (avoids a needless prompt on
    // browsers that gate persist() behind a permission).
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Centralised localStorage key namespace. Every key the app sets in
 * window.localStorage MUST be declared here so the namespace is grep-able
 * and collisions are impossible.
 */
export const SESSION_KEY = "frollie-session-id";
export const LAST_STAFF_KEY = "frollie-last-staff";
export const DEVICE_ID_KEY = "frollie-device-id";

/**
 * Dev-only fixed device-id VALUE (not a localStorage key). Under the Vite dev
 * server, `useDeviceId` returns this instead of a random per-install UUID so the
 * id matches the `registered_devices` row pre-seeded by `seed:reset`, letting
 * dev / Chrome-MCP loads skip the /activate gate. Keep in sync with the literal
 * in convex/seed/internal.ts (the two runtimes cannot share a module).
 */
export const DEV_DEVICE_ID = "dev-booth-device";

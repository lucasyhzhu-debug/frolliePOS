/**
 * Centralised localStorage key namespace. Every key the app sets in
 * window.localStorage MUST be declared here so the namespace is grep-able
 * and collisions are impossible.
 */
export const SESSION_KEY = "frollie-session-id";
export const LAST_STAFF_KEY = "frollie-last-staff";
export const DEVICE_ID_KEY = "frollie-device-id";

/**
 * Remembered-device quick-PIN token (v2.0 owner-auth WS5, ADR-052). The
 * high-entropy rememberToken returned ONCE by `registerRememberedDevice`,
 * persisted so a later cockpit login can take the quick-PIN fast path instead of
 * a Telegram OTP. Only the token's sha256 hash is stored server-side; this is the
 * raw token, scoped to this device. */
export const REMEMBER_DEVICE_TOKEN_KEY = "frollie-remember-device-token";

/** Set of PIN-reset-denial requestIds already toasted, so the notice fires
 *  once per denial and never re-fires on a component remount (issue #11). */
export const SHOWN_PIN_RESET_DENIALS_KEY = "frollie-shown-pin-reset-denials";

/**
 * Dev-only fixed device-id VALUE (not a localStorage key). Under the Vite dev
 * server, `useDeviceId` returns this instead of a random per-install UUID so the
 * id matches the `registered_devices` row pre-seeded by `seed:reset`, letting
 * dev / Chrome-MCP loads skip the /activate gate. Keep in sync with the literal
 * in convex/seed/internal.ts (the two runtimes cannot share a module).
 */
export const DEV_DEVICE_ID = "dev-booth-device";

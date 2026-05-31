/**
 * Centralised localStorage key namespace. Every key the app sets in
 * window.localStorage MUST be declared here so the namespace is grep-able
 * and collisions are impossible.
 */
export const SESSION_KEY = "frollie-session-id";
export const LAST_STAFF_KEY = "frollie-last-staff";
export const DEVICE_ID_KEY = "frollie-device-id";

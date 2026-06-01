import { ConvexError } from "convex/values";

/**
 * Extract a human-readable message from an unknown error thrown by a Convex
 * call site. ConvexError wraps a `.data` payload (string or arbitrary value);
 * everything else falls through Error.message / String(...).
 *
 * Standardised here so every UI surface that funnels backend errors into a
 * toast formats them consistently. Add format branches here, not at call sites.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    return typeof err.data === "string" ? err.data : String(err.data);
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

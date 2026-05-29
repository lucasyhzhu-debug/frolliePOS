import { describe, it, expect } from "vitest";
import {
  isTransientError,
  resilientRetryDelayMs,
  RESILIENT_MAX_ATTEMPTS,
} from "./cronRetry";

describe("isTransientError", () => {
  it("true for the canonical 'no available workers' message", () => {
    expect(
      isTransientError(
        new Error("There are no available workers to process the request"),
      ),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(
      isTransientError(new Error("THERE ARE NO AVAILABLE WORKERS right now")),
    ).toBe(true);
  });

  it("false for a non-transient Error", () => {
    expect(isTransientError(new Error("Telegram 403 Forbidden"))).toBe(false);
  });

  it("false for a non-Error value like a (non-matching) string", () => {
    // A plain string is stringified, not message-extracted; a string without the
    // transient substring is not transient.
    expect(isTransientError("Telegram 403 Forbidden")).toBe(false);
  });

  it("false for undefined", () => {
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe("resilientRetryDelayMs", () => {
  it("60s before retry 1 (attempt 0)", () => {
    expect(resilientRetryDelayMs(0)).toBe(60000);
  });

  it("120s before retry 2 (attempt 1)", () => {
    expect(resilientRetryDelayMs(1)).toBe(120000);
  });
});

describe("RESILIENT_MAX_ATTEMPTS", () => {
  it("is 3 (initial + 2 retries)", () => {
    expect(RESILIENT_MAX_ATTEMPTS).toBe(3);
  });
});

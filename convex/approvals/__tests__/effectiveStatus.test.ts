import { describe, test, expect } from "vitest";
import { effectiveStatus, TOKEN_PIN_ATTEMPT_CAP } from "../lib";

const NOW = 1_700_000_000_000;

describe("effectiveStatus", () => {
  test("pending + not expired → pending", () => {
    expect(effectiveStatus({ status: "pending", token_expires_at: NOW + 60_000 }, NOW)).toBe("pending");
  });

  test("pending + token_expires_at === now → expired (boundary)", () => {
    expect(effectiveStatus({ status: "pending", token_expires_at: NOW }, NOW)).toBe("expired");
  });

  test("pending + token_expires_at < now → expired", () => {
    expect(effectiveStatus({ status: "pending", token_expires_at: NOW - 1 }, NOW)).toBe("expired");
  });

  test("resolved + expired-by-time → resolved (terminal wins)", () => {
    expect(effectiveStatus({ status: "resolved", token_expires_at: NOW - 60_000 }, NOW)).toBe("resolved");
  });

  test("denied + expired-by-time → denied (terminal wins)", () => {
    expect(effectiveStatus({ status: "denied", token_expires_at: NOW - 60_000 }, NOW)).toBe("denied");
  });

  test("default now arg matches explicit Date.now() within tolerance", () => {
    const row = { status: "pending" as const, token_expires_at: Date.now() + 60_000 };
    expect(effectiveStatus(row)).toBe("pending");
  });
});

describe("TOKEN_PIN_ATTEMPT_CAP", () => {
  test("is 5", () => {
    expect(TOKEN_PIN_ATTEMPT_CAP).toBe(5);
  });
});

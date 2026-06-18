import { describe, it, expect } from "vitest";
import { KNOWN_TELEGRAM_ROLES, isKnownTelegramRole } from "../config";

describe("telegram roles", () => {
  it("includes ops", () => {
    expect(KNOWN_TELEGRAM_ROLES).toContain("ops");
    expect(isKnownTelegramRole("ops")).toBe(true);
  });
});

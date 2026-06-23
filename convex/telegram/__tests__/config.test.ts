import { expect, test } from "vitest";
import { KNOWN_TELEGRAM_ROLES, ROLE_SCOPE, isKnownTelegramRole } from "../config";

test("owners replaces founders; founders kept as transitional alias", () => {
  expect(KNOWN_TELEGRAM_ROLES).toContain("owners");
  expect(KNOWN_TELEGRAM_ROLES).not.toContain("founders");
  expect(isKnownTelegramRole("owners")).toBe(true);
  expect(isKnownTelegramRole("founders")).toBe(true); // legacy alias through migration window
  expect(isKnownTelegramRole("nope")).toBe(false);
});

test("ROLE_SCOPE marks owners/ops business, managers/inventory outlet", () => {
  expect(ROLE_SCOPE.owners).toBe("business");
  expect(ROLE_SCOPE.ops).toBe("business");
  expect(ROLE_SCOPE.managers).toBe("outlet");
  expect(ROLE_SCOPE.inventory).toBe("outlet");
});

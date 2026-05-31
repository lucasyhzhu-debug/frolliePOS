import { describe, test, expect, beforeEach } from "vitest";
import { rememberLastStaff, getLastStaff, forgetLastStaff } from "../useLastStaff";
import { LAST_STAFF_KEY } from "@/lib/storage-keys";

describe("useLastStaff", () => {
  beforeEach(() => localStorage.clear());

  test("rememberLastStaff writes the id to localStorage", () => {
    rememberLastStaff("kn7staff0000000000000000000000" as any);
    expect(localStorage.getItem(LAST_STAFF_KEY)).toBe("kn7staff0000000000000000000000");
  });

  test("getLastStaff returns the stored id", () => {
    rememberLastStaff("kn7staff0000000000000000000000" as any);
    expect(getLastStaff()).toBe("kn7staff0000000000000000000000");
  });

  test("getLastStaff returns null when nothing stored", () => {
    expect(getLastStaff()).toBeNull();
  });

  test("forgetLastStaff clears the key", () => {
    rememberLastStaff("kn7staff0000000000000000000000" as any);
    forgetLastStaff();
    expect(localStorage.getItem(LAST_STAFF_KEY)).toBeNull();
  });
});

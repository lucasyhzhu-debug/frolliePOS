import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFieldErrors } from "../useFieldErrors";

describe("useFieldErrors", () => {
  it("(a) mergeErrors then clearFieldError empties errors", () => {
    const { result } = renderHook(() => useFieldErrors());

    act(() => {
      result.current.mergeErrors("add.", { "add.x": "E" });
    });
    expect(result.current.errors["add.x"]).toBe("E");

    act(() => {
      result.current.clearFieldError("add.x");
    });
    expect(result.current.errors).toEqual({});
  });

  it("(b) clearErrors('add.') drops only add.* keys, leaving meta.*", () => {
    const { result } = renderHook(() => useFieldErrors());

    act(() => {
      result.current.mergeErrors("add.", { "add.x": "E1" });
      result.current.mergeErrors("meta.", { "meta.y": "E2" });
    });
    expect(result.current.errors["add.x"]).toBe("E1");
    expect(result.current.errors["meta.y"]).toBe("E2");

    act(() => {
      result.current.clearErrors("add.");
    });
    expect(result.current.errors["add.x"]).toBeUndefined();
    expect(result.current.errors["meta.y"]).toBe("E2");
  });

  it("(c) applyErrors with empty next returns false and sets no errors", () => {
    const { result } = renderHook(() => useFieldErrors());
    let returned: boolean | undefined;

    act(() => {
      returned = result.current.applyErrors("add.", {}, {});
    });
    expect(returned).toBe(false);
    expect(result.current.errors).toEqual({});
  });

  it("(d) applyErrors with errors returns true and sets error state", () => {
    const { result } = renderHook(() => useFieldErrors());
    let returned: boolean | undefined;

    act(() => {
      returned = result.current.applyErrors(
        "add.",
        { "add.x": "E" },
        { "add.x": "some-id" },
      );
    });
    expect(returned).toBe(true);
    expect(result.current.errors["add.x"]).toBe("E");
  });
});

import { useState } from "react";

/**
 * Per-field inline-validation error state for forms migrated to <FieldMessage>
 * (ADR-048). Keys are namespaced by dialog (e.g. "add.price", "meta.name").
 *  - clearFieldError(k): drop one field's error (call from an input's onChange)
 *  - clearErrors(prefix?): drop a dialog's errors on open/close (no arg = all)
 *  - mergeErrors(prefix, next): replace a dialog's errors with `next`
 *  - applyErrors(prefix, next, focusMap): mergeErrors + focus the first errored
 *    field (in focusMap key order) + return true if there were any errors
 */
export function useFieldErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const clearFieldError = (k: string) =>
    setErrors((e) => {
      if (!(k in e)) return e;
      const { [k]: _omit, ...rest } = e;
      return rest;
    });

  const clearErrors = (prefix?: string) =>
    setErrors((e) =>
      prefix
        ? Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(prefix)))
        : {},
    );

  const mergeErrors = (prefix: string, next: Record<string, string>) =>
    setErrors((e) => ({
      ...Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(prefix))),
      ...next,
    }));

  const applyErrors = (
    prefix: string,
    next: Record<string, string>,
    focusMap: Record<string, string>,
  ): boolean => {
    mergeErrors(prefix, next);
    if (Object.keys(next).length === 0) return false;
    const firstBad = Object.keys(focusMap).find((k) => next[k]);
    if (firstBad) {
      const el = document.getElementById(focusMap[firstBad]);
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    }
    return true;
  };

  return { errors, setErrors, clearFieldError, clearErrors, mergeErrors, applyErrors };
}

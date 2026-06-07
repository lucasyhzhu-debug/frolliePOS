import { expect, type Page } from "@playwright/test";

/**
 * Open a Radix Select (combobox role) and pick an option, hardening against the
 * mobile/touch flake where the portal hasn't fully closed before the next
 * interaction (see docs/postmortems/2026-06-issue-43-e2e-skip-triage.md — the
 * spoilage fills raced the Select's `hasTouch` close).
 *
 * - `triggerName` / `optionName`: optional accessible-name matchers. When a name
 *   is omitted the first combobox / option is used (matches the spoilage SKU
 *   select, which has a single combobox and picks the first SKU).
 * - `settleMatcher`: when provided, waits for the trigger to display the picked
 *   value before returning, so the portal is closed and controlled inputs
 *   filled afterward are deterministic. Omit when the caller doesn't need the
 *   settle (e.g. the next step is its own awaited assertion).
 */
export async function selectFromRadixCombobox(
  page: Page,
  opts: {
    triggerName?: RegExp | string;
    optionName?: RegExp | string;
    settleMatcher?: RegExp | string;
  } = {},
): Promise<void> {
  const trigger = opts.triggerName
    ? page.getByRole("combobox", { name: opts.triggerName })
    : page.getByRole("combobox").first();
  await trigger.click();

  const option = opts.optionName
    ? page.getByRole("option", { name: opts.optionName })
    : page.getByRole("option").first();
  await option.click();

  if (opts.settleMatcher !== undefined) {
    await expect(trigger).toContainText(opts.settleMatcher);
  }
}

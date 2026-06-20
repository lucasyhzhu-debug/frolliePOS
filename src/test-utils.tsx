// Test helper: render a component inside LocaleProvider so components that call
// useT()/useLocale() don't throw. Locale defaults to English (the app default)
// because test sessions typically carry no staff.locale — matching the i18n
// "English default" contract. Re-exports everything from Testing Library so
// tests can `import { renderWithLocale, screen, ... } from "@/test-utils"`.
import type { ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n";

export function renderWithLocale(ui: ReactElement, options?: RenderOptions) {
  return render(<LocaleProvider>{ui}</LocaleProvider>, options);
}

export * from "@testing-library/react";

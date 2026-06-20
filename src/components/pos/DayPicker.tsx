/**
 * Manager-side WIB day picker. Used by /history and /mgr/dashboard.
 *
 * value === undefined → "today" (the backend defaults to server-today WIB).
 * onChange(undefined) — reset chip ("Hari ini") restores that default.
 *
 * Extracted in the v0.5.3a simplify wave so the same input + reset affordance
 * isn't duplicated across two routes.
 */
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";

interface DayPickerProps {
  value: string | undefined; // "YYYY-MM-DD" or undefined
  onChange: (next: string | undefined) => void;
  /** Optional input id for label association. */
  id?: string;
  /** Optional data-testid on the <input>; reset button gets `${testId}-reset`. */
  testId?: string;
  /** Override the label slot; defaults to "Tanggal". */
  label?: ReactNode;
}

export function DayPicker({ value, onChange, id, testId, label }: DayPickerProps) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor={id}
        className="text-xs font-medium text-muted-foreground"
      >
        {label ?? t("dayPicker.label")}
      </label>
      <input
        id={id}
        type="date"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-testid={testId}
      />
      {value !== undefined && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          aria-label={t("dayPicker.resetAriaLabel")}
          className="text-xs text-muted-foreground underline"
        >
          {t("dayPicker.today")}
        </button>
      )}
    </div>
  );
}

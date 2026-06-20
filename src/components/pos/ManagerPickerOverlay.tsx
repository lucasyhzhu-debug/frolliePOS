import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/lib/i18n";

export type Manager = { name: string; code: string };

interface Props {
  open: boolean;
  /** undefined = loading; [] = empty state; populated = render list */
  managers: Manager[] | undefined;
  onPick: (m: Manager) => void;
  onCancel: () => void;
}

/**
 * Shared manager-picker overlay used by manager-PIN gated flows
 * (sale/charge.tsx manager override + refund/detail.tsx inline refund).
 *
 * Renders a sticky bottom sheet (mobile) / centered card (sm+) listing every
 * active manager. Caller controls visibility via `open`; on pick, owner state
 * usually transitions to a PIN sheet. data-testid contract is preserved from
 * the prior inline implementations — existing route tests query
 * `manager-picker` + `pick-manager-<code>` and must continue to work.
 */
export function ManagerPickerOverlay({ open, managers, onPick, onCancel }: Props) {
  const t = useT();
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      data-testid="manager-picker"
    >
      <Card className="w-full max-w-sm p-5 pb-6">
        <h3 className="mb-4 text-center text-base font-semibold">{t("mgrPicker.title")}</h3>
        {managers === undefined ? (
          <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t("mgrPicker.loading")}</span>
          </div>
        ) : managers.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("mgrPicker.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {managers.map((m) => (
              <Button
                key={m.code}
                variant="outline"
                className="justify-between"
                data-testid={`pick-manager-${m.code}`}
                onClick={() => onPick(m)}
              >
                <span>{m.name}</span>
                <span className="text-xs text-muted-foreground">{m.code}</span>
              </Button>
            ))}
          </div>
        )}
        <Button variant="ghost" className="mt-4 w-full" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </Card>
    </div>
  );
}

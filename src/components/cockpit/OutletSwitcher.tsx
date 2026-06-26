/**
 * src/components/cockpit/OutletSwitcher.tsx
 * Owner cockpit — outlet scope dropdown (v1.3.0 Task 8).
 *
 * Renders in the cockpit header chrome (wired in via CockpitShell). Selecting
 * an item calls `setCurrentOutlet` from OutletContext, which updates the scope
 * for all cockpit screens and persists to localStorage.
 *
 * Uses semantic tokens only (ADR-047) so the .theme-owner amber re-tints it
 * automatically alongside the rest of the cockpit plane.
 */
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOutletContext } from "@/contexts/OutletContext";
import { useT } from "@/lib/i18n";

export function OutletSwitcher() {
  const t = useT();
  const { outlets, currentOutletId, setCurrentOutlet } = useOutletContext();

  const allOutletsLabel = t("cockpitOutletSwitcher.allOutlets");

  const currentLabel =
    currentOutletId === "all"
      ? allOutletsLabel
      : (outlets?.find((o) => o._id === currentOutletId)?.name ??
        allOutletsLabel);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-sm font-medium text-foreground"
        >
          <span className="max-w-[160px] truncate">{currentLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuItem
          onSelect={() => setCurrentOutlet("all")}
          data-selected={currentOutletId === "all" ? "true" : undefined}
        >
          <span className="flex-1">{allOutletsLabel}</span>
          {currentOutletId === "all" && (
            <Check className="ml-2 h-3.5 w-3.5 shrink-0 text-foreground" />
          )}
        </DropdownMenuItem>
        {outlets?.map((outlet) => (
          <DropdownMenuItem
            key={outlet._id}
            onSelect={() => setCurrentOutlet(outlet._id)}
            data-selected={currentOutletId === outlet._id ? "true" : undefined}
          >
            <span className="flex-1 truncate">{outlet.name}</span>
            <span className="ml-3 shrink-0 text-xs text-muted-foreground">
              {outlet.code}
            </span>
            {currentOutletId === outlet._id && (
              <Check className="ml-2 h-3.5 w-3.5 shrink-0 text-foreground" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

interface StaffListItemProps {
  name: string;
  role: "staff" | "manager";
  onClick: () => void;
}

export function StaffListItem({ name, role, onClick }: StaffListItemProps) {
  const t = useT();
  const roleLabel = role === "manager" ? t("staffItem.roleManager") : t("staffItem.roleStaff");
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3",
        "shadow-sm transition-colors hover:bg-accent",
      )}
    >
      <span className="grid h-10 w-10 place-items-center rounded-full bg-secondary text-sm font-medium">
        {name[0]}
      </span>
      <div className="flex-1 text-left">
        <div className="text-base font-medium leading-tight">{name}</div>
        <div className="text-xs text-muted-foreground">{roleLabel}</div>
      </div>
      <span aria-hidden className="text-muted-foreground">→</span>
    </button>
  );
}

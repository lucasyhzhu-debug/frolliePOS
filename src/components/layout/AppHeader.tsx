import { useNavigate } from "react-router";
import { useSession } from "@/hooks/useSession";
import { ConnDot } from "@/components/layout/ConnDot";
import { PrinterSheet } from "@/components/pos/PrinterSheet";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";

export interface AppHeaderProps {
  title: string;
  backTo?: string;
  onBack?: () => void | Promise<void>;
  rightSlot?: React.ReactNode;
  hideBack?: boolean;
}

export function AppHeader({ title, backTo = "/", onBack, rightSlot, hideBack }: AppHeaderProps) {
  const navigate = useNavigate();
  const session = useSession();

  const handleBack = async () => {
    if (onBack) await onBack();
    else navigate(backTo);
  };

  return (
    <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-border bg-background/95 px-3 backdrop-blur">
      {hideBack ? (
        <div className="w-16" />
      ) : (
        <Button variant="ghost" size="sm" onClick={handleBack} aria-label="Home">
          <ChevronLeft className="size-4" /> Home
        </Button>
      )}
      <h1 className="text-sm font-medium">{title}</h1>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {rightSlot}
        {/* Global printer chip — shared connection (PrinterProvider), so staff
            connect once at shift start from any screen. */}
        {session.status === "active" && <PrinterSheet />}
        {session.status === "active" && <span>{session.staff.name}</span>}
        <ConnDot />
      </div>
    </header>
  );
}

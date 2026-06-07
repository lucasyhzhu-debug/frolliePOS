import { Link, Navigate } from "react-router";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Card } from "@/components/ui/card";
import { useSession } from "@/hooks/useSession";

interface NavCard {
  to: string;
  label: string;
  hint: string;
  glyph: string;
  /** When true, `to` is an external/static URL opened in a new tab via <a>,
   *  not a React Router route. Used for the static presentation deck. */
  external?: boolean;
}

const NAV_CARDS: NavCard[] = [
  { to: "/mgr/dashboard", label: "Dashboard", hint: "Today at a glance", glyph: "◉" },
  { to: "/mgr/products", label: "Products", hint: "Add, edit, price, archive", glyph: "▣" },
  { to: "/mgr/staff", label: "Staff", hint: "Add, rename, role, PIN", glyph: "◔" },
  { to: "/mgr/vouchers", label: "Vouchers", hint: "Create, edit, redemptions", glyph: "%" },
  { to: "/mgr/spoilage", label: "Spoilage", hint: "Log damaged / spoiled stock", glyph: "⨯" },
  { to: "/mgr/receipt", label: "Receipt", hint: "Branding + footer", glyph: "≡" },
  { to: "/mgr/telegram-chats", label: "Telegram chats", hint: "Bot registry + roles", glyph: "✈" },
  { to: "/mgr/refunds-pending", label: "Refunds pending", hint: "Awaiting settlement", glyph: "↻" },
  { to: "/mgr/stock", label: "Stock drift", hint: "Cron-detected ledger gaps", glyph: "Δ" },
  { to: "/mgr/device-setup", label: "Device setup", hint: "Aktivasi perangkat baru", glyph: "⊕" },
  { to: "/mgr/audit", label: "Audit log", hint: "Append-only activity trail", glyph: "❡" },
  {
    to: "/presentation/frolliepos-talk.html",
    label: "Presentation",
    hint: "Frollie POS conference talk",
    glyph: "▶",
    external: true,
  },
];

export default function MgrHome() {
  const session = useSession();

  if (session.status === "loading") {
    return (
      <SpokeLayout title="Manager home">
        <main className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </main>
      </SpokeLayout>
    );
  }

  if (session.status !== "active" || session.staff.role !== "manager") {
    return <Navigate to="/" replace />;
  }

  return (
    <SpokeLayout title="Manager home" backTo="/">
      <div className="flex flex-1 flex-col gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          Pick a manager surface.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {NAV_CARDS.map((c) => {
            const inner = (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl leading-none text-muted-foreground">
                    {c.glyph}
                  </span>
                  <span className="text-sm font-medium leading-tight">
                    {c.label}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{c.hint}</p>
              </>
            );
            return (
              <Card key={c.to} className="p-0 transition-colors hover:bg-accent">
                {c.external ? (
                  <a
                    href={c.to}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-3"
                  >
                    {inner}
                  </a>
                ) : (
                  <Link to={c.to} className="block p-3">
                    {inner}
                  </Link>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </SpokeLayout>
  );
}

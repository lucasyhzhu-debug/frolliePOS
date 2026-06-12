import { Link, useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSession, clearSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import { useCatalogCache } from "@/hooks/useCatalogCache";
import { useRecountNudge } from "@/hooks/useRecountNudge";
import { useAwaitingPaymentRecovery } from "@/hooks/useAwaitingPaymentRecovery";
import { ConnDot } from "@/components/layout/ConnDot";
import { PrinterSheet } from "@/components/pos/PrinterSheet";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Tile {
  id: string;
  group: "sell" | "stock" | "you" | "mgr";
  label: string;
  hint: string;
  to: string;
  primary?: boolean;
  badge?: number;
  warn?: boolean;
  mgrOnly?: boolean;
  glyph: string;
}

const TILES: Tile[] = [
  { id: "sale", group: "sell", label: "New sale", hint: "start a cart", to: "/sale", primary: true, glyph: "◉" },
  { id: "saved", group: "sell", label: "Saved carts", hint: "resume a saved cart", to: "/sale/drafts", glyph: "◇" },
  { id: "hist", group: "sell", label: "History", hint: "today's sales", to: "/history", glyph: "≡" },
  { id: "refund", group: "sell", label: "Refund", hint: "today's refundable", to: "/refund", glyph: "↩" },
  { id: "stock-check", group: "stock", label: "Stock check", hint: "inventory + recount", to: "/stock", glyph: "◐" },
  { id: "sett", group: "you", label: "Settlements", hint: "payouts ke BCA", to: "/settlements", glyph: "$" },
  { id: "lock", group: "you", label: "Lock + handoff", hint: "end your shift", to: "/lock", glyph: "◎" },
  { id: "account", group: "you", label: "Change PIN", hint: "ubah PIN Anda", to: "/account", glyph: "⚷" },
  { id: "mgr", group: "mgr", label: "Manager home", hint: "live + approvals", to: "/mgr", mgrOnly: true, glyph: "★" },
  { id: "telegram-chats", group: "mgr", label: "Telegram chats", hint: "bot registry + roles", to: "/mgr/telegram-chats", mgrOnly: true, glyph: "✈" },
];

const GROUP_LABELS = { sell: "SELL", stock: "STOCK", you: "YOU", mgr: "MANAGER" } as const;

export default function HomeRoute() {
  const navigate = useNavigate();
  const session = useSession();
  const liveCatalog = useQuery(api.catalog.public.catalog, {});
  const { snapshot } = useCatalogCache(liveCatalog);
  const catalog = snapshot ?? liveCatalog;
  const logout = useMutation(api.auth.public.logout);
  const logoutKey = useIdempotency(`logout:${session.sessionId ?? "none"}`);
  const nudge = useRecountNudge();
  const recovery = useAwaitingPaymentRecovery();

  if (session.status !== "active") return null; // RootLayout redirected

  const isManager = session.staff.role === "manager";

  const handleLock = async () => {
    if (!session.sessionId) return;
    if (!logoutKey) return; // IDB not yet resolved — guard ADR-013
    await logout({ sessionId: session.sessionId, idempotencyKey: logoutKey });
    clearSession();
    navigate("/login", { replace: true });
  };

  const grouped = (["sell", "stock", "you", "mgr"] as const).map((g) => ({
    group: g,
    tiles: TILES.filter((t) => t.group === g),
  }));

  return (
    <main className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold leading-tight">
            Frollie <span className="text-sm font-normal text-muted-foreground">· {session.staff.name}</span>
          </h1>
          <p className="text-xs text-muted-foreground">
            {catalog == null ? "Loading catalog…" : `${catalog.products.length} products · ${catalog.skus.length} SKUs`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PrinterSheet />
          <ConnDot />
        </div>
      </header>

      {nudge && (
        <Link
          to="/stock/recount"
          className="block rounded-md bg-amber-50 p-3 text-center text-sm text-amber-800"
        >
          Saatnya menghitung ulang stok — ketuk untuk mulai
        </Link>
      )}

      {recovery.latest && (
        <Link
          to={`/sale/charge/${recovery.latest._id}`}
          className="block rounded-md bg-amber-50 p-3 text-center text-sm text-amber-800"
          data-testid="awaiting-recovery-banner"
        >
          {recovery.count} pembayaran belum selesai — ketuk untuk lanjutkan
        </Link>
      )}

      <div className="flex-1 space-y-4">
        {grouped.map(({ group, tiles }) => (
          <section key={group}>
            <h2 className="mb-2 text-xs font-medium tracking-widest text-muted-foreground">
              {GROUP_LABELS[group]}
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {tiles.map((t) => {
                const disabled = t.mgrOnly && !isManager;
                return (
                  <Card
                    key={t.id}
                    className={cn(
                      "relative p-3 transition-colors",
                      disabled ? "opacity-50" : "hover:bg-accent",
                      t.primary && "ring-2 ring-primary",
                    )}
                  >
                    {disabled ? (
                      <div>
                        <TileBody tile={t} />
                        <Badge variant="secondary" className="absolute bottom-1 right-1 text-[10px]">mgr only</Badge>
                      </div>
                    ) : (
                      <Link to={t.to} className="block">
                        <TileBody tile={t} />
                      </Link>
                    )}
                  </Card>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="flex gap-2 pt-2">
        <Button variant="outline" className="flex-1" onClick={handleLock}>
          Lock
        </Button>
        <Button className="flex-[2]" asChild>
          <Link to="/sale">+ New sale</Link>
        </Button>
      </div>
    </main>
  );
}

function TileBody({ tile }: { tile: Tile }) {
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className={cn("text-2xl leading-none", tile.primary ? "text-primary" : "text-muted-foreground")}>
          {tile.glyph}
        </span>
        <span className="text-sm font-medium leading-tight">{tile.label}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{tile.hint}</p>
    </>
  );
}

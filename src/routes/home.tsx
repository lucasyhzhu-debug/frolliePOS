import { Link, useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useCatalogCache } from "@/hooks/useCatalogCache";
import { useRecountNudge } from "@/hooks/useRecountNudge";
import { useAwaitingPaymentRecovery } from "@/hooks/useAwaitingPaymentRecovery";
import { ConnDot } from "@/components/layout/ConnDot";
import { PrinterSheet } from "@/components/pos/PrinterSheet";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Flag, Lock } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { gridContainerVariants, gridItemVariants } from "@/lib/motion";

interface Tile {
  id: string;
  group: "sell" | "stock" | "you" | "mgr";
  label: string;
  hint: string;
  to: string;
  mgrOnly?: boolean;
  glyph: string;
  photoUrl?: string; // reserved for #3 — product/initials image slot
}

const TILES: Tile[] = [
  { id: "saved", group: "sell", label: "Saved carts", hint: "resume a saved cart", to: "/sale/drafts", glyph: "◇" },
  { id: "hist", group: "sell", label: "History", hint: "today's sales", to: "/history", glyph: "≡" },
  { id: "refund", group: "sell", label: "Refund", hint: "today's refundable", to: "/refund", glyph: "↩" },
  { id: "stock-check", group: "stock", label: "Stock check", hint: "inventory + recount", to: "/stock", glyph: "◐" },
  { id: "account", group: "you", label: "Change PIN", hint: "ubah PIN Anda", to: "/account", glyph: "⚷" },
  { id: "sett", group: "mgr", label: "Settlements", hint: "payouts ke BCA", to: "/settlements", mgrOnly: true, glyph: "$" },
  { id: "mgr", group: "mgr", label: "Manager home", hint: "live + approvals", to: "/mgr", mgrOnly: true, glyph: "★" },
  { id: "telegram-chats", group: "mgr", label: "Telegram chats", hint: "bot registry + roles", to: "/mgr/telegram-chats", mgrOnly: true, glyph: "✈" },
];

const GROUP_LABELS = { sell: "SELL", stock: "STOCK", you: "YOU", mgr: "MANAGER" } as const;

// Shared with the warning banners below — single source for the dark-safe
// warning-tone treatment so the recount + recovery banners stay in sync.
const BANNER_CLS =
  "block rounded-md bg-warning/15 text-warning border border-warning/30 p-3 text-center text-sm";

export default function HomeRoute() {
  const navigate = useNavigate();
  const session = useSession();
  const liveCatalog = useQuery(api.catalog.public.catalog, {});
  const { snapshot } = useCatalogCache(liveCatalog);
  const catalog = snapshot ?? liveCatalog;
  const nudge = useRecountNudge();
  const recovery = useAwaitingPaymentRecovery();
  const reduce = useReducedMotion() ?? false;

  if (session.status !== "active") return null; // RootLayout redirected

  const isManager = session.staff.role === "manager";

  const grouped = (["sell", "stock", "you", "mgr"] as const)
    .map((g) => ({
      group: g,
      tiles: TILES.filter((t) => t.group === g && (!t.mgrOnly || isManager)),
    }))
    .filter((x) => x.tiles.length > 0);

  // Resolve motion variants once per render (reused across all tiles).
  const containerV = gridContainerVariants(reduce);
  const itemV = gridItemVariants(reduce);

  return (
    <div className="flex flex-1 flex-col">
      {/* App bar */}
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Akhiri shift"
            title="Akhiri shift"
            onClick={() => navigate("/shift/end")}
          >
            <Flag className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Lock and hand off"
            onClick={() => navigate("/lock")}
          >
            <Lock className="size-5" />
          </Button>
        </div>

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold leading-tight truncate">
            Frollie{" "}
            <span className="font-normal text-muted-foreground">· {session.staff.name}</span>
          </h1>
          <p className="text-[10px] text-muted-foreground leading-none mt-0.5">
            <span className="uppercase tracking-widest">v{__APP_VERSION__}</span>
            {catalog != null && (
              <span className="ml-2 normal-case">
                {catalog.products.length} products · {catalog.skus.length} SKUs
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-1">
          <PrinterSheet />
          <ConnDot />
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-4 p-4 overflow-y-auto">
        {/* Banners */}
        {nudge && (
          <Link to="/stock/recount" className={BANNER_CLS}>
            Saatnya menghitung ulang stok — ketuk untuk mulai
          </Link>
        )}

        {recovery.latest && (
          <Link
            to={`/sale/charge/${recovery.latest._id}`}
            className={BANNER_CLS}
            data-testid="awaiting-recovery-banner"
          >
            {recovery.count} pembayaran belum selesai — ketuk untuk lanjutkan
          </Link>
        )}

        {/* Hero: New sale CTA */}
        <Card className="overflow-hidden">
          <Link
            to="/sale"
            className="flex min-h-[40vh] flex-col items-center justify-center gap-3 bg-primary p-6 text-primary-foreground"
          >
            {/* Photo slot placeholder — reserved for #3 */}
            <div className="size-9 rounded-full bg-primary-foreground/20 flex items-center justify-center">
              <span className="text-2xl leading-none">◉</span>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold leading-tight">New sale</p>
              <p className="mt-1 text-sm text-primary-foreground/80">start a cart</p>
            </div>
          </Link>
        </Card>

        {/* Tile groups */}
        <motion.div
          className="space-y-4"
          variants={containerV}
          initial="hidden"
          animate="show"
        >
          {grouped.map(({ group, tiles }) => (
            <section key={group}>
              <h2 className="mb-2 text-xs font-medium tracking-widest text-muted-foreground">
                {GROUP_LABELS[group]}
              </h2>
              <div className="grid grid-cols-2 gap-2">
                {tiles.map((t) => (
                  <motion.div key={t.id} variants={itemV}>
                    <Card className="relative p-3 transition-colors hover:bg-accent">
                      <Link to={t.to} className="block">
                        <TileBody tile={t} />
                      </Link>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </section>
          ))}
        </motion.div>
      </main>
    </div>
  );
}

function TileBody({ tile }: { tile: Tile }) {
  return (
    <div className="flex items-center gap-2">
      {/* Photo slot placeholder — reserved for #3 */}
      <div className="size-9 rounded-full bg-muted flex items-center justify-center shrink-0">
        <span className="text-xl leading-none text-muted-foreground">{tile.glyph}</span>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-tight truncate">{tile.label}</p>
        <p className="text-xs text-muted-foreground truncate">{tile.hint}</p>
      </div>
    </div>
  );
}

import { Link, useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useCatalogCache } from "@/hooks/useCatalogCache";
import { useRecountNudge } from "@/hooks/useRecountNudge";
import { useAwaitingPaymentRecovery } from "@/hooks/useAwaitingPaymentRecovery";
import { ConnDot } from "@/components/layout/ConnDot";
import { PrinterSheet } from "@/components/pos/PrinterSheet";
import { InstallPrompt } from "@/components/pos/InstallPrompt";
import { LocaleToggle } from "@/components/pos/LocaleToggle";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Lock } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { gridContainerVariants, gridItemVariants } from "@/lib/motion";
import { useT, type TranslationKey } from "@/lib/i18n";

interface Tile {
  id: string;
  group: "sell" | "stock" | "you" | "mgr";
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  to: string;
  mgrOnly?: boolean;
  glyph: string;
  photoUrl?: string; // reserved for #3 — product/initials image slot
}

const TILES: Tile[] = [
  { id: "saved", group: "sell", labelKey: "home.tileSavedCartsLabel", hintKey: "home.tileSavedCartsHint", to: "/sale/drafts", glyph: "◇" },
  { id: "hist", group: "sell", labelKey: "home.tileHistoryLabel", hintKey: "home.tileHistoryHint", to: "/history", glyph: "≡" },
  { id: "refund", group: "sell", labelKey: "home.tileRefundLabel", hintKey: "home.tileRefundHint", to: "/refund", glyph: "↩" },
  { id: "stock-check", group: "stock", labelKey: "home.tileStockLabel", hintKey: "home.tileStockHint", to: "/stock", glyph: "◐" },
  { id: "account", group: "you", labelKey: "home.changePin", hintKey: "home.changePinHint", to: "/account", glyph: "⚷" },
  { id: "sett", group: "mgr", labelKey: "home.tileSettlementsLabel", hintKey: "home.tileSettlementsHint", to: "/settlements", mgrOnly: true, glyph: "$" },
  { id: "mgr", group: "mgr", labelKey: "home.tileMgrLabel", hintKey: "home.tileMgrHint", to: "/mgr", mgrOnly: true, glyph: "★" },
  { id: "telegram-chats", group: "mgr", labelKey: "home.tileTelegramLabel", hintKey: "home.tileTelegramHint", to: "/mgr/telegram-chats", mgrOnly: true, glyph: "✈" },
];

// Shared with the warning banners below — single source for the dark-safe
// warning-tone treatment so the recount + recovery banners stay in sync.
const BANNER_CLS =
  "block rounded-md bg-warning/15 text-warning border border-warning/30 p-3 text-center text-sm";

export default function HomeRoute() {
  const navigate = useNavigate();
  const session = useSession();
  const t = useT();
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
      tiles: TILES.filter((tile) => tile.group === g && (!tile.mgrOnly || isManager)),
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
            aria-label={t("home.lock")}
            title={t("home.lock")}
            onClick={() => navigate("/lock")}
          >
            <Lock className="size-5" />
          </Button>
        </div>

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold leading-tight truncate">
            {"Frollie"}{" "}
            <span className="font-normal text-muted-foreground">· {session.staff.name}</span>
          </h1>
          <p className="text-[10px] text-muted-foreground leading-none mt-0.5">
            <span className="uppercase tracking-widest">v{__APP_VERSION__}</span>
            {catalog != null && (
              <span className="ml-2 normal-case">
                {t("home.catalogSummary_other", { count: catalog.products.length, skus: catalog.skus.length })}
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
        <InstallPrompt />

        {nudge && (
          <Link to="/stock/recount" className={BANNER_CLS}>
            {t("home.recountNudge")}
          </Link>
        )}

        {recovery.latest && (
          <Link
            to={`/sale/charge/${recovery.latest._id}`}
            className={BANNER_CLS}
            data-testid="awaiting-recovery-banner"
          >
            {t("home.awaitingPayment_other", { count: recovery.count })}
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
              <p className="text-2xl font-bold leading-tight">{t("home.newSale")}</p>
              <p className="mt-1 text-sm text-primary-foreground/80">{t("home.startCart")}</p>
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
                {t(`home.group.${group}` as const)}
              </h2>
              <div className="grid grid-cols-2 gap-2">
                {tiles.map((tile) => (
                  <motion.div key={tile.id} variants={itemV}>
                    <Card className="relative p-3 transition-colors hover:bg-accent">
                      <Link to={tile.to} className="block"><TileBody tile={tile} /></Link>
                    </Card>
                  </motion.div>
                ))}
                {group === "you" && <LocaleToggle />}
              </div>
            </section>
          ))}
        </motion.div>

        {/* End-of-shift actions. Promoted from the old app-bar Flag icon, which
            sat next to Lock and was constantly mistaken for it — a Lock leaves
            the booth open and sends NO founders summary, so staff who meant to
            sign off were silently skipping the Telegram notification. These are
            the only two paths that send the shift-end summary. */}
        <section className="space-y-2 pt-2">
          <h2 className="mb-2 text-xs font-medium tracking-widest text-muted-foreground">
            {t("home.group.shift")}
          </h2>
          <Button
            variant="outline"
            className="h-auto w-full py-4 flex flex-col items-start text-left"
            onClick={() => navigate("/shift/end?mode=close")}
          >
            <span className="font-semibold text-base">{t("shiftEnd.closeBooth")}</span>
            <span className="text-xs text-muted-foreground mt-1 whitespace-normal">
              {t("shiftEnd.closeBoothDesc")}
            </span>
          </Button>
          <Button
            variant="outline"
            className="h-auto w-full py-4 flex flex-col items-start text-left"
            onClick={() => navigate("/shift/end?mode=handover")}
          >
            <span className="font-semibold text-base">{t("shiftEnd.handoverTitle")}</span>
            <span className="text-xs text-muted-foreground mt-1 whitespace-normal">
              {t("shiftEnd.handoverDesc")}
            </span>
          </Button>
        </section>
      </main>
    </div>
  );
}

function TileBody({ tile }: { tile: Tile }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      {/* Photo slot placeholder — reserved for #3 */}
      <div className="size-9 rounded-full bg-muted flex items-center justify-center shrink-0">
        <span className="text-xl leading-none text-muted-foreground">{tile.glyph}</span>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-tight truncate">{t(tile.labelKey)}</p>
        <p className="text-xs text-muted-foreground truncate">{t(tile.hintKey)}</p>
      </div>
    </div>
  );
}

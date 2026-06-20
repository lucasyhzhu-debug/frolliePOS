import { Link, Navigate } from "react-router";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Card } from "@/components/ui/card";
import { useSession } from "@/hooks/useSession";
import { useT } from "@/lib/i18n";

interface NavCard {
  to: string;
  labelKey: string;
  hintKey: string;
  glyph: string;
  /** When true, `to` is an external/static URL opened in a new tab via <a>,
   *  not a React Router route. Used for the static presentation deck. */
  external?: boolean;
}

const NAV_CARDS: NavCard[] = [
  { to: "/mgr/dashboard", labelKey: "mgrHome.navDashboard", hintKey: "mgrHome.navDashboardHint", glyph: "◉" },
  { to: "/mgr/products", labelKey: "mgrHome.navProducts", hintKey: "mgrHome.navProductsHint", glyph: "▣" },
  { to: "/mgr/staff", labelKey: "mgrHome.navStaff", hintKey: "mgrHome.navStaffHint", glyph: "◔" },
  { to: "/mgr/vouchers", labelKey: "mgrHome.navVouchers", hintKey: "mgrHome.navVouchersHint", glyph: "%" },
  { to: "/mgr/spoilage", labelKey: "mgrHome.navSpoilage", hintKey: "mgrHome.navSpoilageHint", glyph: "⨯" },
  { to: "/mgr/receipt", labelKey: "mgrHome.navReceipt", hintKey: "mgrHome.navReceiptHint", glyph: "≡" },
  { to: "/mgr/telegram-chats", labelKey: "mgrHome.navTelegramChats", hintKey: "mgrHome.navTelegramChatsHint", glyph: "✈" },
  { to: "/mgr/refunds-pending", labelKey: "mgrHome.navRefundsPending", hintKey: "mgrHome.navRefundsPendingHint", glyph: "↻" },
  { to: "/mgr/stock", labelKey: "mgrHome.navStockDrift", hintKey: "mgrHome.navStockDriftHint", glyph: "Δ" },
  { to: "/mgr/device-setup", labelKey: "mgrHome.navDeviceSetup", hintKey: "mgrHome.navDeviceSetupHint", glyph: "⊕" },
  { to: "/mgr/audit", labelKey: "mgrHome.navAuditLog", hintKey: "mgrHome.navAuditLogHint", glyph: "❡" },
  {
    to: "/presentation/frolliepos-talk.html",
    labelKey: "mgrHome.navPresentation",
    hintKey: "mgrHome.navPresentationHint",
    glyph: "▶",
    external: true,
  },
  {
    to: "/presentation/force-times-direction.html",
    labelKey: "mgrHome.navForceDirection",
    hintKey: "mgrHome.navForceDirectionHint",
    glyph: "↗",
    external: true,
  },
];

export default function MgrHome() {
  const session = useSession();
  const t = useT();

  if (session.status === "loading") {
    return (
      <SpokeLayout title={t("mgrHome.title")}>
        <main className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        </main>
      </SpokeLayout>
    );
  }

  if (session.status !== "active" || session.staff.role !== "manager") {
    return <Navigate to="/" replace />;
  }

  return (
    <SpokeLayout title={t("mgrHome.title")} backTo="/">
      <div className="flex flex-1 flex-col gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          {t("mgrHome.subtitle")}
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
                    {t(c.labelKey as Parameters<typeof t>[0])}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t(c.hintKey as Parameters<typeof t>[0])}</p>
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

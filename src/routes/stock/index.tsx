import { useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { useT } from "@/lib/i18n";

export default function StockScreen() {
  const t = useT();
  const session = useSession();
  const sessionId = session.status === "active" ? session.sessionId : null;
  const rows = useQuery(api.inventory.public.listInventory, sessionId ? { sessionId } : "skip");

  return (
    <SpokeLayout title={t("stock.title")}>
      {rows === undefined ? (
        <p className="p-4 text-muted-foreground">{t("common.loading")}</p>
      ) : rows.length === 0 ? (
        <div className="m-4 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {t("stock.noSkus")}
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.skuId}>
              <Link to={`/stock/${r.skuId}`} className="flex items-center justify-between p-4">
                <span className="font-medium">{r.name}</span>
                <span className={r.status === "negative" ? "text-error font-semibold" : r.status === "low" ? "text-warning font-semibold" : ""}>
                  {t("stock.onHandPcs", { qty: String(r.on_hand) })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="p-4">
        <Link to="/stock/recount" className="block w-full rounded-md bg-primary py-3 text-center text-primary-foreground">
          {t("stock.recountButton")}
        </Link>
      </div>
    </SpokeLayout>
  );
}

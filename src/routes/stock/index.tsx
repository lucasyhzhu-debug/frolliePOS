import { useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { SpokeLayout } from "@/components/layout/SpokeLayout";

export default function StockScreen() {
  const session = useSession();
  const sessionId = session.status === "active" ? session.sessionId : null;
  const rows = useQuery(api.inventory.public.listInventory, sessionId ? { sessionId } : "skip");

  return (
    <SpokeLayout title="Stok">
      {rows === undefined ? (
        <p className="p-4 text-muted-foreground">Memuat…</p>
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.skuId}>
              <Link to={`/stock/${r.skuId}`} className="flex items-center justify-between p-4">
                <span className="font-medium">{r.name}</span>
                <span className={r.status === "negative" ? "text-red-600 font-semibold" : r.status === "low" ? "text-amber-600 font-semibold" : ""}>
                  {r.on_hand} pcs
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="p-4">
        <Link to="/stock/recount" className="block w-full rounded-md bg-primary py-3 text-center text-primary-foreground">
          Hitung ulang stok
        </Link>
      </div>
    </SpokeLayout>
  );
}

import { useState } from "react";
import { useParams } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { SpokeLayout } from "@/components/layout/SpokeLayout";

export default function SkuDetailScreen() {
  const { skuId } = useParams();
  const session = useSession();
  const sessionId = session.status === "active" ? session.sessionId : null;
  const role = session.status === "active" ? session.staff.role : null;
  const detail = useQuery(
    api.inventory.public.getSkuDetail,
    sessionId && skuId ? { sessionId, skuId: skuId as Id<"pos_inventory_skus"> } : "skip",
  );
  const setThreshold = useMutation(api.inventory.public.setLowThreshold);
  const intent = sessionId && skuId ? `setLowThreshold:${sessionId}:${skuId}` : "setLowThreshold:none";
  const key = useIdempotency(intent);
  const [lt, setLt] = useState("");

  async function save() {
    if (!sessionId || !skuId || !key) return;
    try {
      await setThreshold({
        idempotencyKey: key,
        sessionId,
        skuId: skuId as Id<"pos_inventory_skus">,
        lowThreshold: Number(lt),
      });
      await clearIntent(intent);
      toast.success("Ambang stok disimpan");
    } catch {
      toast.error("Hanya manajer");
    }
  }

  if (detail === undefined) {
    return (
      <SpokeLayout title="Stok" backTo="/stock">
        <p className="p-4 text-muted-foreground">Memuat…</p>
      </SpokeLayout>
    );
  }

  return (
    <SpokeLayout title={detail.name} backTo="/stock">
      <div className="space-y-1 p-4">
        <p>
          Sisa: <b>{detail.on_hand}</b> pcs
        </p>
        <p>Ambang stok rendah: {detail.low_threshold}</p>
      </div>
      {role === "manager" && (
        <div className="flex gap-2 p-4">
          <input
            inputMode="numeric"
            value={lt}
            onChange={(e) => setLt(e.target.value.replace(/[^0-9]/g, ""))}
            className="w-24 rounded-md border p-2"
            placeholder="cth. 20"
          />
          <button
            disabled={lt === "" || !key}
            onClick={save}
            className="rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50"
          >
            Simpan
          </button>
        </div>
      )}
      <ul className="divide-y">
        {detail.movements.map((m) => (
          <li key={m._id} className="flex justify-between p-3 text-sm">
            <span>{m.source}</span>
            <span className={m.qty < 0 ? "text-red-600" : "text-emerald-600"}>
              {m.qty > 0 ? "+" : ""}
              {m.qty}
            </span>
          </li>
        ))}
      </ul>
    </SpokeLayout>
  );
}

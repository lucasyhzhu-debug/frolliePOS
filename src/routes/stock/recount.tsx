import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { SpokeLayout } from "@/components/layout/SpokeLayout";

export default function RecountScreen() {
  const session = useSession();
  const sessionId = session.status === "active" ? session.sessionId : null;
  const rows = useQuery(api.inventory.public.listInventory, sessionId ? { sessionId } : "skip");
  const recount = useMutation(api.inventory.public.recordRecount);
  const intent = sessionId ? `recount:${sessionId}` : "recount:none";
  const key = useIdempotency(intent);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit() {
    if (!sessionId || !key) return;
    const payload = Object.entries(counts)
      .filter(([, v]) => v !== "")
      .map(([skuId, v]) => ({ skuId: skuId as Id<"pos_inventory_skus">, entered: Number(v) }));
    if (payload.length === 0) {
      toast.error("Belum ada hitungan");
      return;
    }
    setBusy(true);
    try {
      const res = await recount({ idempotencyKey: key, sessionId, counts: payload });
      toast.success(`${res.changed} SKU diperbarui`);
      await clearIntent(intent);
      navigate("/stock");
    } catch {
      toast.error("Gagal menyimpan hitungan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SpokeLayout title="Hitung ulang stok" backTo="/stock">
      <ul className="divide-y">
        {(rows ?? []).map((r) => {
          const entered = counts[r.skuId] ?? "";
          const delta = entered === "" ? null : Number(entered) - r.on_hand;
          return (
            <li key={r.skuId} className="flex items-center justify-between p-4">
              <div>
                <p className="font-medium">{r.name}</p>
                <p className="text-sm text-muted-foreground">Sistem: {r.on_hand}</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  inputMode="numeric"
                  className="w-20 rounded-md border p-2 text-right"
                  value={entered}
                  onChange={(e) =>
                    setCounts((c) => ({ ...c, [r.skuId]: e.target.value.replace(/[^0-9]/g, "") }))
                  }
                />
                {delta != null && delta !== 0 && (
                  <span className={delta < 0 ? "text-red-600 text-sm" : "text-emerald-600 text-sm"}>
                    {delta > 0 ? "+" : ""}
                    {delta}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="p-4">
        <button
          disabled={busy || !key}
          onClick={submit}
          className="w-full rounded-md bg-primary py-3 text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Menyimpan…" : "Simpan hitungan"}
        </button>
      </div>
    </SpokeLayout>
  );
}

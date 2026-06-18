import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("DUPLICATE_SKU")) toast.error("SKU duplikat dalam satu hitungan");
      else if (msg.includes("NEGATIVE_COUNT") || msg.includes("NON_INTEGER_COUNT"))
        toast.error("Hitungan harus bilangan bulat ≥ 0");
      else toast.error("Gagal menyimpan hitungan");
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
                <Input
                  inputMode="numeric"
                  className="w-20 text-right"
                  value={entered}
                  onChange={(e) =>
                    setCounts((c) => ({ ...c, [r.skuId]: e.target.value.replace(/[^0-9]/g, "") }))
                  }
                />
                {delta != null && delta !== 0 && (
                  <span className={delta < 0 ? "text-error text-sm" : "text-success text-sm"}>
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
        <Button
          disabled={busy || !key}
          onClick={submit}
          size="lg"
          className="w-full"
        >
          {busy ? "Menyimpan…" : "Simpan hitungan"}
        </Button>
      </div>
    </SpokeLayout>
  );
}

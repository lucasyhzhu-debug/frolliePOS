import { useState } from "react";
import { useParams } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export function humanizeThresholdError(e: unknown, t: ReturnType<typeof useT>): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("MANAGER_ONLY")) return t("stockDetail.errManagerOnly");
  if (msg.includes("NEGATIVE_THRESHOLD") || msg.includes("NON_INTEGER_THRESHOLD"))
    return t("stockDetail.errInvalidValue");
  return t("stockDetail.errSaveFailed");
}

export default function SkuDetailScreen() {
  const t = useT();
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
      toast.success(t("stockDetail.thresholdSaved"));
    } catch (err) {
      toast.error(humanizeThresholdError(err, t));
    }
  }

  if (detail === undefined) {
    return (
      <SpokeLayout title={t("stock.title")} backTo="/stock">
        <p className="p-4 text-muted-foreground">{t("common.loading")}</p>
      </SpokeLayout>
    );
  }

  return (
    <SpokeLayout title={detail.name} backTo="/stock">
      <div className="space-y-1 p-4">
        <p>
          {t("stockDetail.remaining")}: <b>{detail.on_hand}</b> {t("stockDetail.pcs")}
        </p>
        <p>{t("stockDetail.lowThreshold")}: {detail.low_threshold}</p>
      </div>
      {role === "manager" && (
        <div className="flex gap-2 p-4">
          <Input
            inputMode="numeric"
            value={lt}
            onChange={(e) => setLt(e.target.value.replace(/[^0-9]/g, ""))}
            className="w-24"
            placeholder={t("stockDetail.thresholdPlaceholder")}
          />
          <Button disabled={lt === "" || !key} onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      )}
      <ul className="divide-y">
        {detail.movements.map((m) => (
          <li key={m._id} className="flex justify-between p-3 text-sm">
            <span>{m.source}</span>
            <span className={m.qty < 0 ? "text-error" : "text-success"}>
              {m.qty > 0 ? "+" : ""}
              {m.qty}
            </span>
          </li>
        ))}
      </ul>
    </SpokeLayout>
  );
}

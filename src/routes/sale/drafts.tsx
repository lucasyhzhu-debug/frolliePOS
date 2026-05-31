import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useCart } from "@/hooks/useCart";
import { useCatalogCache } from "@/hooks/useCatalogCache";
import { rp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { toast } from "sonner";

/**
 * Per-draft idempotency keys: hooks cannot be called inside a loop or map.
 * Since drafts are user-initiated one-at-a-time actions, we generate a fresh
 * crypto.randomUUID() at click time. The server deduplicates via pos_idempotency
 * (ADR-013) — a fresh key per user click is safe and correct; only network
 * retries / page-reload replays need a stable key, and those are handled by the
 * server's 24-hour dedupe window keyed to the result of the first winning call.
 */

export default function SaleDrafts() {
  const navigate = useNavigate();
  const session = useSession();

  // Catalog — needed to restore unitPrice when resuming a draft (resumeDraft
  // only returns {productId, qty}; the CartLine type requires unitPrice).
  const liveCatalog = useQuery(api.catalog.public.catalog, {});
  const { snapshot } = useCatalogCache(liveCatalog);
  const catalog = snapshot ?? liveCatalog;
  const products = catalog?.products ?? [];

  const drafts = useQuery(
    api.transactions.public.listDrafts,
    session.status === "active" ? { sessionId: session.sessionId } : "skip",
  );

  const resumeDraft = useMutation(api.transactions.public.resumeDraft);
  const deleteDraft = useMutation(api.transactions.public.deleteDraft);
  const { loadFromDraft } = useCart();

  // ---- handlers ----

  const handleResume = async (draftId: string) => {
    if (session.status !== "active") return;
    const idempotencyKey = crypto.randomUUID();
    try {
      const result = await resumeDraft({
        sessionId: session.sessionId,
        draftId: draftId as Parameters<typeof resumeDraft>[0]["draftId"],
        idempotencyKey,
      });
      // Map lines to CartLine — restore unitPrice from catalog snapshot.
      // Falls back to 0 if the product is no longer in the catalog (deactivated
      // after the draft was saved); the cart will show 0 and the user can remove
      // the line before charging.
      const cartLines = result.lines.map((l) => {
        const product = products.find((p) => p._id === l.productId);
        return {
          productId: l.productId,
          qty: l.qty,
          unitPrice: product?.price_idr ?? 0,
        };
      });
      loadFromDraft(cartLines, result.voucherCode);
      toast.success("Draft loaded");
      navigate("/sale");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not resume draft";
      toast.error(msg);
    }
  };

  const handleDelete = async (draftId: string) => {
    if (session.status !== "active") return;
    const idempotencyKey = crypto.randomUUID();
    try {
      await deleteDraft({
        sessionId: session.sessionId,
        draftId: draftId as Parameters<typeof deleteDraft>[0]["draftId"],
        idempotencyKey,
      });
      toast.success("Draft deleted");
      // listDrafts is a live query — list re-renders reactively.
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not delete draft";
      toast.error(msg);
    }
  };

  // ---- render guards ----

  if (session.status === "loading") {
    return (
      <main className="flex flex-1 flex-col p-4">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </main>
    );
  }
  if (session.status !== "active") return null;

  return (
    <SpokeLayout title="Saved drafts" backTo="/sale">
      <section className="flex-1 overflow-y-auto p-4">
        {drafts == null ? (
          <div className="text-sm text-muted-foreground">Loading drafts…</div>
        ) : drafts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No saved drafts
          </div>
        ) : (
          <ul className="space-y-3">
            {drafts.map((draft) => {
              const createdAt = new Date(draft.created_at);
              const timeLabel = createdAt.toLocaleTimeString("id-ID", {
                hour: "2-digit",
                minute: "2-digit",
              });
              const dateLabel = createdAt.toLocaleDateString("id-ID", {
                day: "numeric",
                month: "short",
              });
              return (
                <li key={draft._id}>
                  <Card className="flex items-center justify-between gap-3 px-4 py-3">
                    {/* Draft info */}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium tabular-nums">
                        {rp(draft.total)}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {dateLabel} · {timeLabel}
                        {draft.voucher_code_snapshot
                          ? ` · ${draft.voucher_code_snapshot}`
                          : null}
                      </p>
                    </div>
                    {/* Actions */}
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(draft._id)}
                      >
                        Delete
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleResume(draft._id)}
                      >
                        Resume
                      </Button>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </SpokeLayout>
  );
}

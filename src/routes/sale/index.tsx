import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { usePathChangeBlocker } from "@/hooks/usePathChangeBlocker";
import { useCart } from "@/hooks/useCart";
import { useCatalogCache } from "@/hooks/useCatalogCache";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { rp } from "@/lib/format";
import { hasFlag, NEG_STOCK } from "../../../convex/transactions/flags";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { AbandonCartDialog } from "@/components/pos/AbandonCartDialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function Sale() {
  const navigate = useNavigate();
  const session = useSession();

  // Catalog
  const liveCatalog = useQuery(api.catalog.public.catalog, {});
  const { snapshot } = useCatalogCache(liveCatalog);
  const catalog = snapshot ?? liveCatalog;
  const products = catalog?.products ?? [];

  // Cart state
  const { lines, subtotal, voucherCode, addLine, setQty, clear } = useCart();

  // Mutation
  const commitCart = useMutation(api.transactions.public.commitCart);

  // Idempotency keys (IDB-backed, may be undefined for first render)
  const idKeyDraft = useIdempotency(
    `draft:${session.status === "active" ? session.sessionId : "none"}`,
  );
  const idKeyCharge = useIdempotency(
    `charge:${session.status === "active" ? session.sessionId : "none"}`,
  );

  const isEmpty = lines.length === 0;

  // ---- navigation guard ----
  // Block route transitions when the cart has items so the user can save or
  // discard before leaving. `allowWithin: "/sale/"` whitelists in-flow hops
  // (charge / save-draft / voucher) — those clear or commit the cart before
  // navigating, so the guard must only fire when truly leaving the sale flow.
  // Without it, pressing Charge tripped the abandon dialog: handleCharge clears
  // the cart then navigates in the same tick, but `when` (=!isEmpty) is still
  // the pre-clear value at navigate time, so the stale guard blocked the hop.
  const blocker = usePathChangeBlocker(!isEmpty, "/sale/");

  // Secondary guard for hard page-leave (tab close / browser refresh). The
  // beforeunload handler is the only mechanism available for those cases.
  useEffect(() => {
    if (isEmpty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isEmpty]);

  // ---- handlers ----

  const handleSaveDraft = async () => {
    if (session.status !== "active") return;
    if (!idKeyDraft) return;
    if (isEmpty) return;
    try {
      await commitCart({
        sessionId: session.sessionId,
        idempotencyKey: idKeyDraft,
        intent: "draft",
        lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
        voucherCode,
      });
      // Close out this sale's idempotency intent so the NEXT cart gets a fresh
      // key. Without this, the session-scoped key replays this draft's cached
      // result on every subsequent sale in the shift (server dedupe, ADR-013).
      await clearIntent(`draft:${session.sessionId}`);
      clear();
      toast.success("Draft saved");
      navigate("/sale/drafts");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save draft";
      toast.error(msg);
    }
  };

  // ---- blocker-dialog handlers ----
  // These are called from the AbandonCartDialog when the user navigates away
  // with items in the cart. Unlike handleSaveDraft, they do NOT navigate — the
  // blocker's proceed() call navigates to the originally-blocked destination.
  const onBlockerSaveDraft = async () => {
    if (session.status !== "active") return;
    if (!idKeyDraft) return;
    try {
      await commitCart({
        sessionId: session.sessionId,
        idempotencyKey: idKeyDraft,
        intent: "draft",
        lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
        voucherCode,
      });
      await clearIntent(`draft:${session.sessionId}`);
      clear();
      toast.success("Draft saved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save draft";
      toast.error(msg);
      // Re-throw so the dialog doesn't call onProceed on failure.
      throw err;
    }
  };

  const onBlockerDiscard = () => {
    clear();
  };

  const handleCharge = async () => {
    if (session.status !== "active") return;
    if (!idKeyCharge) return;
    if (isEmpty) return;
    try {
      const result = await commitCart({
        sessionId: session.sessionId,
        idempotencyKey: idKeyCharge,
        intent: "charge",
        lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
        voucherCode,
      });
      if (hasFlag(result.flags, NEG_STOCK)) {
        toast.warning("Low stock — sale flagged for manager review");
      }
      // Close out this sale's idempotency intent (see handleSaveDraft) so the
      // next charge mints a fresh key instead of replaying this transaction.
      await clearIntent(`charge:${session.sessionId}`);
      clear();
      navigate(`/sale/charge/${result.transactionId}`, {
        state: result.voucher_rejected ? { voucher_rejected: result.voucher_rejected } : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not start charge";
      toast.error(msg);
    }
  };

  // Not yet active — RootLayout handles redirect; render nothing to avoid flash
  if (session.status === "loading") {
    return (
      <main className="flex flex-1 flex-col p-4">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </main>
    );
  }
  if (session.status !== "active") return null;

  return (
    <SpokeLayout title="New sale">
      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        {/* ---- Product grid ---- */}
        <section className="flex-1 overflow-y-auto p-4">
          <h2 className="mb-3 text-xs font-medium tracking-widest text-muted-foreground">
            PRODUCTS
          </h2>
          {products.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {catalog == null ? "Loading products…" : "No active products."}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {products.map((p) => {
                const line = lines.find((l) => l.productId === p._id);
                return (
                  <Card
                    key={p._id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Add ${p.name} ${p.pack_label}`}
                    onClick={() => addLine(p._id, p.price_idr)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        addLine(p._id, p.price_idr);
                      }
                    }}
                    className={cn(
                      "relative cursor-pointer select-none p-3 transition-colors hover:bg-accent active:scale-95",
                      line && "ring-2 ring-primary",
                    )}
                  >
                    <p className="truncate text-sm font-medium leading-tight">{p.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{rp(p.price_idr)}</p>
                    {line && (
                      <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                        {line.qty}
                      </span>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        {/* ---- Cart panel ---- */}
        <aside className="flex w-full flex-col border-t bg-card lg:w-72 lg:border-l lg:border-t-0">
          <div className="flex items-center justify-between px-4 pt-4">
            <h2 className="text-xs font-medium tracking-widest text-muted-foreground">CART</h2>
            {!isEmpty && (
              <button
                type="button"
                className="text-xs text-destructive underline-offset-2 hover:underline"
                onClick={() => clear()}
              >
                Clear
              </button>
            )}
          </div>

          {/* Line items */}
          <div className="flex-1 overflow-y-auto px-4 py-2">
            {isEmpty ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                Tap a product to add it
              </p>
            ) : (
              <ul className="space-y-2">
                {lines.map((line) => {
                  const product = products.find((p) => p._id === line.productId);
                  const name = product?.name ?? line.productId;
                  return (
                    <li key={line.productId} className="flex items-center gap-2">
                      <span className="flex-1 truncate text-sm">{name}</span>
                      {/* Qty stepper */}
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Decrease qty for ${name}`}
                          className="flex h-6 w-6 items-center justify-center rounded border text-sm leading-none transition-colors hover:bg-accent"
                          onClick={() => setQty(line.productId, line.qty - 1)}
                        >
                          −
                        </button>
                        <span className="w-6 text-center text-sm tabular-nums">{line.qty}</span>
                        <button
                          type="button"
                          aria-label={`Increase qty for ${name}`}
                          className="flex h-6 w-6 items-center justify-center rounded border text-sm leading-none transition-colors hover:bg-accent"
                          onClick={() => setQty(line.productId, line.qty + 1)}
                        >
                          +
                        </button>
                      </div>
                      <span className="w-20 text-right text-xs tabular-nums text-muted-foreground">
                        {rp(line.unitPrice * line.qty)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Voucher + subtotal + actions */}
          <div className="border-t px-4 pb-4 pt-3">
            {/* Voucher link */}
            <button
              type="button"
              className="mb-3 flex w-full items-center justify-between text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => navigate("/sale/voucher")}
            >
              <span>Voucher</span>
              {voucherCode ? (
                <span className="font-medium text-primary">{voucherCode}</span>
              ) : (
                <span className="opacity-50">+ add code</span>
              )}
            </button>

            <Separator className="mb-3" />

            {/* Subtotal */}
            <div className="mb-4 flex items-baseline justify-between">
              <span className="text-sm font-medium">Subtotal</span>
              <span className="text-lg font-semibold tabular-nums">{rp(subtotal)}</span>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                disabled={isEmpty || !idKeyDraft}
                onClick={handleSaveDraft}
              >
                Save draft
              </Button>
              <Button
                className="flex-[2]"
                disabled={isEmpty || !idKeyCharge}
                onClick={handleCharge}
              >
                Charge
              </Button>
            </div>
          </div>
        </aside>
      </div>

      {/* Navigation guard: fires when the user tries to leave with cart items */}
      <AbandonCartDialog
        variant="cart"
        open={blocker.state === "blocked"}
        onCancel={() => blocker.reset?.()}
        onProceed={() => blocker.proceed?.()}
        onSaveDraft={onBlockerSaveDraft}
        onDiscard={onBlockerDiscard}
      />
    </SpokeLayout>
  );
}

/**
 * /mgr/products — manager-gated product administration (v0.5.3b Task 15).
 *
 * Exercises the v0.5.3b catalog admin surface:
 *   - catalog.public.listAllProducts       — read (incl. archived)
 *   - catalog.actions.createProduct        — PIN-gated
 *   - catalog.public.updateProductMeta     — session-gated
 *   - catalog.actions.updateProductPricing — PIN-gated
 *   - catalog.public.setProductComponents  — session-gated (replace-set)
 *   - catalog.public.archiveProduct        — session-gated (soft-delete)
 *
 * Layout/feel mirrors /mgr/staff (Task 14): outer redirect + inner data hooks,
 * SpokeLayout shell, shadcn primitives, PinSheet for PIN-gated actions, one
 * idempotency intent per mutation surface (rotated via clearIntent on success).
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id, Doc } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { PinSheet } from "@/components/pos/PinSheet";
import { rp } from "@/lib/format";
import { toast } from "sonner";

type Product = Doc<"pos_products">;
type Sku = Doc<"pos_inventory_skus">;
type Component = Doc<"pos_product_components">;

type ComponentRow = {
  inventory_sku_id: Id<"pos_inventory_skus"> | "";
  qty: number;
};

type PinAction =
  | {
      kind: "createProduct";
      name: string;
      pack_label: string;
      sku_family: string;
      price_idr: number;
      tax_rate: number;
      sort_order: number;
      initials?: string;
      hue?: number;
      withInventorySku?: boolean;
      inventorySkuLowThreshold?: number;
      inventorySkuComponentQty?: number;
    }
  | {
      kind: "updatePricing";
      productId: Id<"pos_products">;
      productName: string;
      price_idr: number;
      tax_rate: number;
    }
  | {
      kind: "createInventorySku";
      sku: string;
      name: string;
      low_threshold: number;
      code?: string;
      initials?: string;
      hue?: number;
    };

function humanizeCatalogError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (m.includes("PRICE_INVALID")) return "Price must be a non-negative integer.";
  if (m.includes("QTY_INVALID")) return "Qty must be a positive integer.";
  if (m.includes("SKU_NOT_FOUND")) return "Linked SKU not found.";
  if (m.includes("SKU_INACTIVE")) return "Linked SKU is inactive — reactivate it first.";
  if (m.includes("SKU_EXISTS")) return "That SKU already exists.";
  if (m.includes("CODE_EXISTS")) return "That code is already in use.";
  if (m.includes("SKU_INVALID")) return "SKU must be lowercase letters, numbers, or hyphens (max 32).";
  if (m.includes("SKU_FAMILY_NOT_SLUGGABLE")) return "SKU family must be lowercase letters, numbers, or hyphens (max 32) when creating a matching SKU.";
  if (m.includes("LOW_THRESHOLD_INVALID")) return "Low-stock threshold must be a non-negative integer.";
  if (m.includes("PRODUCT_NOT_FOUND")) return "Product not found.";
  if (m.includes("NAME_INVALID")) return "Name must be 1-80 characters.";
  if (m.includes("INVALID_PIN")) return "Wrong manager PIN.";
  if (m.includes("LOCKED_OUT")) return "Too many attempts — locked out for 60s.";
  if (m.includes("SESSION_INVALID")) return "Session expired. Lock and log in again.";
  if (m.includes("NOT_MANAGER")) return "Only managers can do that.";
  return "Something went wrong.";
}

function parseIntStrict(s: string): number | null {
  // Integer-only — reject decimals/scientific/negative input. price_idr is
  // integer rupiah (ADR-015). tax_rate accepts the same integer parser since
  // we constrain UI to 0..11 (whole percents).
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export default function MgrProducts() {
  const navigate = useNavigate();
  const session = useSession();

  if (session.status === "loading") {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (session.status !== "active" || session.staff.role !== "manager") {
    navigate("/", { replace: true });
    return null;
  }

  return <MgrProductsInner sessionId={session.sessionId} />;
}

function MgrProductsInner({ sessionId }: { sessionId: Id<"staff_sessions"> }) {
  const data = useQuery(api.catalog.public.listAllProducts, { sessionId }) as
    | { products: Product[]; skus: Sku[]; components: Component[] }
    | undefined;

  // One idempotency intent per distinct mutation surface.
  const createKey = useIdempotency("catalog.createProduct");
  const metaKey = useIdempotency("catalog.updateMeta");
  const pricingKey = useIdempotency("catalog.updatePricing");
  const componentsKey = useIdempotency("catalog.setComponents");
  const archiveKey = useIdempotency("catalog.archive");
  const createSkuKey = useIdempotency("catalog.createInventorySku");

  const createProduct = useAction(api.catalog.actions.createProduct);
  const createInventorySku = useAction(api.catalog.actions.createInventorySku);
  const updateProductMeta = useMutation(api.catalog.public.updateProductMeta);
  const updateProductPricing = useAction(api.catalog.actions.updateProductPricing);
  const setProductComponents = useMutation(api.catalog.public.setProductComponents);
  const archiveProduct = useMutation(api.catalog.public.archiveProduct);

  // ─── Sorted view ────────────────────────────────────────────────────────────
  const sortedProducts = useMemo(() => {
    if (!data) return undefined;
    return [...data.products].sort((a, b) => a.sort_order - b.sort_order);
  }, [data]);

  const activeSkus = useMemo(() => {
    if (!data) return [];
    return data.skus.filter((s) => s.active);
  }, [data]);

  const nextSortOrder = useMemo(() => {
    if (!data || data.products.length === 0) return 0;
    let max = -Infinity;
    for (const p of data.products) if (p.sort_order > max) max = p.sort_order;
    return Number.isFinite(max) ? max + 1 : 0;
  }, [data]);

  // ─── PIN-gated state ────────────────────────────────────────────────────────
  const [pinAction, setPinAction] = useState<PinAction | null>(null);
  const [pinPending, setPinPending] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>(undefined);

  // ─── Add product dialog ─────────────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addPackLabel, setAddPackLabel] = useState("");
  const [addSkuFamily, setAddSkuFamily] = useState("");
  const [addPrice, setAddPrice] = useState("");
  const [addTax, setAddTax] = useState("0");
  const [addSortOrder, setAddSortOrder] = useState("");
  const [addInitials, setAddInitials] = useState("");
  const [addHue, setAddHue] = useState("");
  const [addWithSku, setAddWithSku] = useState(false);
  const [addSkuComponentQty, setAddSkuComponentQty] = useState("1");
  const [addBundleThreshold, setAddBundleThreshold] = useState("0");

  // ─── Add SKU dialog ─────────────────────────────────────────────────────────
  const [addSkuOpen, setAddSkuOpen] = useState(false);
  const [addSkuSlug, setAddSkuSlug] = useState("");
  const [addSkuName, setAddSkuName] = useState("");
  const [addSkuThreshold, setAddSkuThreshold] = useState("0");
  const [addSkuCode, setAddSkuCode] = useState("");
  const [addSkuInitials, setAddSkuInitials] = useState("");
  const [addSkuHue, setAddSkuHue] = useState("");

  function openAddSku() {
    setAddSkuSlug("");
    setAddSkuName("");
    setAddSkuThreshold("0");
    setAddSkuCode("");
    setAddSkuInitials("");
    setAddSkuHue("");
    setAddSkuOpen(true);
  }

  function submitAddSkuOpenPin() {
    const sku = addSkuSlug.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,32}$/.test(sku)) {
      toast.error("SKU must be lowercase letters, numbers, or hyphens (max 32).");
      return;
    }
    const name = addSkuName.trim();
    if (name.length === 0 || name.length > 80) {
      toast.error("Name must be 1-80 characters.");
      return;
    }
    const low_threshold = parseIntStrict(addSkuThreshold);
    if (low_threshold === null) {
      toast.error("Low-stock threshold must be a non-negative integer.");
      return;
    }
    const code = addSkuCode.trim().length > 0 ? addSkuCode.trim() : undefined;
    const initials = addSkuInitials.trim().length > 0 ? addSkuInitials.trim() : undefined;
    let hue: number | undefined = undefined;
    if (addSkuHue.trim().length > 0) {
      const h = parseIntStrict(addSkuHue);
      if (h === null || h > 360) {
        toast.error("Hue must be an integer between 0 and 360.");
        return;
      }
      hue = h;
    }
    setPinAction({ kind: "createInventorySku", sku, name, low_threshold, code, initials, hue });
    setPinError(undefined);
  }

  function openAdd() {
    setAddName("");
    setAddPackLabel("");
    setAddSkuFamily("");
    setAddPrice("");
    setAddTax("0");
    setAddSortOrder(String(nextSortOrder));
    setAddInitials("");
    setAddHue("");
    setAddWithSku(false);
    setAddSkuComponentQty("1");
    setAddBundleThreshold("0");
    setAddOpen(true);
  }

  function submitAddOpenPin() {
    const name = addName.trim();
    if (name.length === 0 || name.length > 80) {
      toast.error("Name must be 1-80 characters.");
      return;
    }
    const pack_label = addPackLabel.trim();
    if (pack_label.length === 0) {
      toast.error("Pack label is required.");
      return;
    }
    const sku_family = addSkuFamily.trim();
    if (sku_family.length === 0) {
      toast.error("SKU family is required.");
      return;
    }
    const price_idr = parseIntStrict(addPrice);
    if (price_idr === null) {
      toast.error("Price must be a non-negative integer.");
      return;
    }
    const tax_rate = parseIntStrict(addTax);
    if (tax_rate === null || tax_rate > 11) {
      toast.error("Tax rate must be an integer between 0 and 11.");
      return;
    }
    const sort_order = parseIntStrict(addSortOrder);
    if (sort_order === null) {
      toast.error("Sort order must be a non-negative integer.");
      return;
    }
    const initialsRaw = addInitials.trim();
    if (initialsRaw.length > 3) {
      toast.error("Initials must be 1-3 characters.");
      return;
    }
    let hue: number | undefined = undefined;
    if (addHue.trim().length > 0) {
      const h = parseIntStrict(addHue);
      if (h === null || h > 360) {
        toast.error("Hue must be an integer between 0 and 360.");
        return;
      }
      hue = h;
    }

    let withInventorySku: boolean | undefined = undefined;
    let inventorySkuLowThreshold: number | undefined = undefined;
    let inventorySkuComponentQty: number | undefined = undefined;
    if (addWithSku) {
      if (!bundleSlugValid) {
        toast.error("SKU family must be lowercase letters, numbers, or hyphens (max 32) when creating a matching SKU.");
        return;
      }
      const qty = parseIntStrict(addSkuComponentQty);
      if (qty === null || qty < 1) {
        toast.error("Component qty must be a positive integer.");
        return;
      }
      const threshold = parseIntStrict(addBundleThreshold);
      if (threshold === null) {
        toast.error("Low-stock threshold must be a non-negative integer.");
        return;
      }
      withInventorySku = true;
      inventorySkuLowThreshold = threshold;
      inventorySkuComponentQty = qty;
    }

    setPinAction({
      kind: "createProduct",
      name,
      pack_label,
      sku_family,
      price_idr,
      tax_rate,
      sort_order,
      initials: initialsRaw.length > 0 ? initialsRaw : undefined,
      hue,
      withInventorySku,
      inventorySkuLowThreshold,
      inventorySkuComponentQty,
    });
    setPinError(undefined);
  }

  // ─── Edit metadata dialog (no PIN) ──────────────────────────────────────────
  const [metaTarget, setMetaTarget] = useState<Product | null>(null);
  const [metaName, setMetaName] = useState("");
  const [metaPackLabel, setMetaPackLabel] = useState("");
  const [metaSkuFamily, setMetaSkuFamily] = useState("");
  const [metaSortOrder, setMetaSortOrder] = useState("");
  const [metaInitials, setMetaInitials] = useState("");
  const [metaHue, setMetaHue] = useState("");
  const [metaBusy, setMetaBusy] = useState(false);

  function openMetaEdit(p: Product) {
    setMetaTarget(p);
    setMetaName(p.name);
    setMetaPackLabel(p.pack_label);
    setMetaSkuFamily(p.sku_family);
    setMetaSortOrder(String(p.sort_order));
    setMetaInitials(p.initials ?? "");
    setMetaHue(p.hue !== undefined ? String(p.hue) : "");
  }

  function closeMetaEdit() {
    setMetaTarget(null);
  }

  async function commitMetaEdit() {
    if (!metaTarget || !metaKey) return;
    const name = metaName.trim();
    if (name.length === 0 || name.length > 80) {
      toast.error("Name must be 1-80 characters.");
      return;
    }
    const pack_label = metaPackLabel.trim();
    if (pack_label.length === 0) {
      toast.error("Pack label is required.");
      return;
    }
    const sku_family = metaSkuFamily.trim();
    if (sku_family.length === 0) {
      toast.error("SKU family is required.");
      return;
    }
    const sort_order = parseIntStrict(metaSortOrder);
    if (sort_order === null) {
      toast.error("Sort order must be a non-negative integer.");
      return;
    }
    const initialsRaw = metaInitials.trim();
    if (initialsRaw.length > 3) {
      toast.error("Initials must be 1-3 characters.");
      return;
    }
    let hue: number | undefined = undefined;
    if (metaHue.trim().length > 0) {
      const h = parseIntStrict(metaHue);
      if (h === null || h > 360) {
        toast.error("Hue must be an integer between 0 and 360.");
        return;
      }
      hue = h;
    }
    setMetaBusy(true);
    try {
      await updateProductMeta({
        idempotencyKey: metaKey,
        sessionId,
        productId: metaTarget._id,
        name,
        pack_label,
        sort_order,
        sku_family,
        initials: initialsRaw.length > 0 ? initialsRaw : undefined,
        hue,
      });
      toast.success("Saved");
      await clearIntent("catalog.updateMeta");
      closeMetaEdit();
    } catch (err) {
      toast.error(humanizeCatalogError(err));
    } finally {
      setMetaBusy(false);
    }
  }

  // ─── Edit price/tax dialog (PIN) ────────────────────────────────────────────
  const [priceTarget, setPriceTarget] = useState<Product | null>(null);
  const [priceBuf, setPriceBuf] = useState("");
  const [priceTaxBuf, setPriceTaxBuf] = useState("");

  function openPriceEdit(p: Product) {
    setPriceTarget(p);
    setPriceBuf(String(p.price_idr));
    setPriceTaxBuf(String(p.tax_rate));
  }

  function closePriceEdit() {
    setPriceTarget(null);
  }

  function submitPriceOpenPin() {
    if (!priceTarget) return;
    const price_idr = parseIntStrict(priceBuf);
    if (price_idr === null) {
      toast.error("Price must be a non-negative integer.");
      return;
    }
    const tax_rate = parseIntStrict(priceTaxBuf);
    if (tax_rate === null || tax_rate > 11) {
      toast.error("Tax rate must be an integer between 0 and 11.");
      return;
    }
    setPinAction({
      kind: "updatePricing",
      productId: priceTarget._id,
      productName: priceTarget.name,
      price_idr,
      tax_rate,
    });
    setPinError(undefined);
  }

  // ─── Components editor (session, replace-set) ───────────────────────────────
  const [compTarget, setCompTarget] = useState<Product | null>(null);
  const [compRows, setCompRows] = useState<ComponentRow[]>([]);
  const [compBusy, setCompBusy] = useState(false);

  function openComponents(p: Product) {
    if (!data) return;
    const existing = data.components
      .filter((c) => c.product_id === p._id)
      .map<ComponentRow>((c) => ({
        inventory_sku_id: c.inventory_sku_id,
        qty: c.qty,
      }));
    setCompTarget(p);
    setCompRows(existing);
  }

  function closeComponents() {
    setCompTarget(null);
    setCompRows([]);
  }

  function addCompRow() {
    setCompRows((rows) => [...rows, { inventory_sku_id: "", qty: 1 }]);
  }

  function removeCompRow(idx: number) {
    setCompRows((rows) => rows.filter((_, i) => i !== idx));
  }

  function updateCompRow(idx: number, patch: Partial<ComponentRow>) {
    setCompRows((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  }

  async function commitComponents() {
    if (!compTarget || !componentsKey) return;
    // Client-side guard — backend re-validates.
    for (const r of compRows) {
      if (r.inventory_sku_id === "") {
        toast.error("Pick an SKU for every row.");
        return;
      }
      if (!Number.isInteger(r.qty) || r.qty <= 0) {
        toast.error("Qty must be a positive integer.");
        return;
      }
    }
    setCompBusy(true);
    try {
      await setProductComponents({
        idempotencyKey: componentsKey,
        sessionId,
        productId: compTarget._id,
        components: compRows.map((r) => ({
          inventory_sku_id: r.inventory_sku_id as Id<"pos_inventory_skus">,
          qty: r.qty,
        })),
      });
      toast.success("Components saved");
      await clearIntent("catalog.setComponents");
      closeComponents();
    } catch (err) {
      toast.error(humanizeCatalogError(err));
    } finally {
      setCompBusy(false);
    }
  }

  // ─── Archive (session, soft-delete) ─────────────────────────────────────────
  async function archiveOne(p: Product) {
    if (!archiveKey) return;
    if (
      !window.confirm(
        `Archive ${p.name}? Existing receipts unaffected.`,
      )
    ) {
      return;
    }
    try {
      await archiveProduct({
        idempotencyKey: archiveKey,
        sessionId,
        productId: p._id,
      });
      toast.success(`${p.name} archived`);
      await clearIntent("catalog.archive");
    } catch (err) {
      toast.error(humanizeCatalogError(err));
    }
  }

  // ─── PinSheet submit funnel ─────────────────────────────────────────────────
  async function handlePinSubmit(managerPin: string) {
    if (!pinAction) return;
    setPinPending(true);
    setPinError(undefined);
    try {
      switch (pinAction.kind) {
        case "createProduct": {
          if (!createKey) throw new Error("idempotency key not ready");
          const res = await createProduct({
            idempotencyKey: createKey,
            sessionId,
            managerPin,
            sku_family: pinAction.sku_family,
            name: pinAction.name,
            pack_label: pinAction.pack_label,
            price_idr: pinAction.price_idr,
            tax_rate: pinAction.tax_rate,
            sort_order: pinAction.sort_order,
            initials: pinAction.initials,
            hue: pinAction.hue,
            withInventorySku: pinAction.withInventorySku,
            inventorySkuLowThreshold: pinAction.inventorySkuLowThreshold,
            inventorySkuComponentQty: pinAction.inventorySkuComponentQty,
          });
          if (pinAction.withInventorySku && res.inventorySkuId) {
            const slug = pinAction.sku_family.trim().toLowerCase();
            toast.success(
              res.skuCreated
                ? `${pinAction.name} added — ${slug} SKU created, linked at qty ${res.componentQty ?? 1}`
                : `${pinAction.name} added — linked to existing ${slug} SKU at qty ${res.componentQty ?? 1}`,
            );
          } else {
            toast.success(`${pinAction.name} added`);
          }
          setAddOpen(false);
          await clearIntent("catalog.createProduct");
          break;
        }
        case "updatePricing": {
          if (!pricingKey) throw new Error("idempotency key not ready");
          await updateProductPricing({
            idempotencyKey: pricingKey,
            sessionId,
            managerPin,
            productId: pinAction.productId,
            price_idr: pinAction.price_idr,
            tax_rate: pinAction.tax_rate,
          });
          toast.success(`${pinAction.productName} pricing updated`);
          closePriceEdit();
          await clearIntent("catalog.updatePricing");
          break;
        }
        case "createInventorySku": {
          if (!createSkuKey) throw new Error("idempotency key not ready");
          await createInventorySku({
            idempotencyKey: createSkuKey,
            sessionId,
            managerPin,
            sku: pinAction.sku,
            name: pinAction.name,
            low_threshold: pinAction.low_threshold,
            code: pinAction.code,
            initials: pinAction.initials,
            hue: pinAction.hue,
          });
          toast.success(`SKU ${pinAction.sku} added`);
          setAddSkuOpen(false);
          await clearIntent("catalog.createInventorySku");
          break;
        }
      }
      setPinAction(null);
    } catch (err) {
      const msg = humanizeCatalogError(err);
      setPinError(msg);
      toast.error(msg);
    } finally {
      setPinPending(false);
    }
  }

  function handlePinCancel() {
    if (pinPending) return;
    setPinAction(null);
    setPinError(undefined);
  }

  // ─── Render ─────────────────────────────────────────────────────────────────
  const pinTitle =
    pinAction?.kind === "createProduct"
      ? "Add product"
      : pinAction?.kind === "updatePricing"
        ? "Update pricing"
        : pinAction?.kind === "createInventorySku"
          ? "Add SKU"
          : "Manager PIN";

  const pinLabel =
    pinAction?.kind === "createProduct"
      ? `Confirm with your manager PIN to add ${pinAction.name}.`
      : pinAction?.kind === "updatePricing"
        ? `Confirm with your manager PIN to update pricing for ${pinAction.productName}.`
        : pinAction?.kind === "createInventorySku"
          ? `Confirm with your manager PIN to add SKU ${pinAction.sku}.`
          : "Enter manager PIN.";

  // Slug preview for the bundled-SKU checkbox. Derived live from the typed
  // sku_family. Used both as the read-only preview and as the gate for the
  // checkbox: an invalid family disables the checkbox entirely.
  const bundleSlugPreview = addSkuFamily.trim().toLowerCase();
  const bundleSlugValid = /^[a-z0-9-]{1,32}$/.test(bundleSlugPreview);

  // Quick lookup for SKU name display.
  const skuById = useMemo(() => {
    const map = new Map<string, Sku>();
    if (data) for (const s of data.skus) map.set(s._id, s);
    return map;
  }, [data]);

  return (
    <SpokeLayout title="Products" backTo="/">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">
              Add, edit, price, link components, archive.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={openAddSku}>
              Add SKU
            </Button>
            <Button size="sm" onClick={openAdd}>
              Add product
            </Button>
          </div>
        </div>

        {sortedProducts === undefined ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="p-4">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-3 w-20 animate-pulse rounded bg-muted" />
              </Card>
            ))}
          </div>
        ) : sortedProducts.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No products yet — add one above
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedProducts.map((p) => {
              const productComponents = data
                ? data.components.filter((c) => c.product_id === p._id)
                : [];
              return (
                <Card
                  key={p._id}
                  className={`space-y-3 p-4 ${p.active ? "" : "opacity-60"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium leading-tight">
                        {p.name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {p.pack_label} · {p.sku_family} · sort {p.sort_order}
                      </p>
                      <p className="mt-1 text-sm font-mono">
                        {rp(p.price_idr)}
                        <span className="ml-2 text-xs text-muted-foreground">
                          tax {p.tax_rate}%
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!p.active && (
                        <Badge variant="outline" className="text-[10px]">
                          Archived
                        </Badge>
                      )}
                    </div>
                  </div>

                  {productComponents.length > 0 && (
                    <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                      <p className="mb-1 font-medium text-muted-foreground">
                        Components
                      </p>
                      <ul className="space-y-0.5">
                        {productComponents.map((c) => {
                          const sku = skuById.get(c.inventory_sku_id);
                          return (
                            <li
                              key={c._id}
                              className="flex justify-between font-mono"
                            >
                              <span>{sku?.name ?? "—"}</span>
                              <span>×{c.qty}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {p.active && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => openMetaEdit(p)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => openPriceEdit(p)}
                      >
                        Edit price
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => openComponents(p)}
                      >
                        Components
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => archiveOne(p)}
                        disabled={!archiveKey}
                      >
                        Archive
                      </Button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Add product dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          if (!o) setAddOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add product</DialogTitle>
            <DialogDescription>
              Manager PIN required after Continue.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="new-product-name">Name</Label>
              <Input
                id="new-product-name"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                maxLength={80}
                placeholder="e.g. Dubai 8pcs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-pack-label">Pack label</Label>
              <Input
                id="new-pack-label"
                value={addPackLabel}
                onChange={(e) => setAddPackLabel(e.target.value)}
                placeholder="e.g. 8pcs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-family">SKU family</Label>
              <Input
                id="new-sku-family"
                value={addSkuFamily}
                onChange={(e) => setAddSkuFamily(e.target.value)}
                placeholder="e.g. dubai"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-price">Price (Rp)</Label>
              <Input
                id="new-price"
                value={addPrice}
                onChange={(e) =>
                  setAddPrice(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                placeholder="e.g. 75000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-tax">Tax rate (%)</Label>
              <Input
                id="new-tax"
                value={addTax}
                onChange={(e) =>
                  setAddTax(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                placeholder="0"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sort">Sort order</Label>
              <Input
                id="new-sort"
                value={addSortOrder}
                onChange={(e) =>
                  setAddSortOrder(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-initials">Initials (opt)</Label>
              <Input
                id="new-initials"
                value={addInitials}
                onChange={(e) => setAddInitials(e.target.value)}
                maxLength={3}
                placeholder="D8"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-hue">Hue 0-360 (opt)</Label>
              <Input
                id="new-hue"
                value={addHue}
                onChange={(e) =>
                  setAddHue(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                placeholder="e.g. 180"
              />
            </div>
            <div className="col-span-2 mt-2 space-y-2 rounded-md border bg-muted/40 p-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-input"
                  checked={addWithSku}
                  disabled={!bundleSlugValid}
                  onChange={(e) => setAddWithSku(e.target.checked)}
                />
                <span className="flex-1">
                  <span className="font-medium">Also create or link a matching inventory SKU</span>
                  <span className="block text-xs text-muted-foreground">
                    Use this for single-SKU products like "Dubai 1pc" or "Dubai 3pcs".
                    For multi-SKU products like Mixed Box, leave unchecked and add
                    components in the editor afterwards.
                  </span>
                </span>
              </label>
              {addWithSku && (
                <div className="ml-6 space-y-2">
                  <div className="text-xs">
                    <span className="text-muted-foreground">Slug: </span>
                    <span className="font-mono">
                      {bundleSlugValid ? bundleSlugPreview : "(set a SKU family first)"}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="bundle-qty">Component qty</Label>
                      <Input
                        id="bundle-qty"
                        value={addSkuComponentQty}
                        onChange={(e) => setAddSkuComponentQty(e.target.value.replace(/[^\d]/g, ""))}
                        inputMode="numeric"
                        placeholder="1"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="bundle-threshold">Low-stock threshold</Label>
                      <Input
                        id="bundle-threshold"
                        value={addBundleThreshold}
                        onChange={(e) => setAddBundleThreshold(e.target.value.replace(/[^\d]/g, ""))}
                        inputMode="numeric"
                        placeholder="0"
                      />
                    </div>
                  </div>
                </div>
              )}
              {!bundleSlugValid && (
                <p className="text-xs text-muted-foreground">
                  Set a SKU family above (lowercase, numbers, hyphens, max 32) to enable this option.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitAddOpenPin}
              disabled={
                !createKey ||
                addName.trim().length === 0 ||
                (addWithSku &&
                  (!bundleSlugValid ||
                    parseIntStrict(addSkuComponentQty) === null ||
                    parseIntStrict(addBundleThreshold) === null))
              }
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add SKU dialog */}
      <Dialog
        open={addSkuOpen}
        onOpenChange={(o) => {
          if (!o) setAddSkuOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add inventory SKU</DialogTitle>
            <DialogDescription>
              Manager PIN required after Continue.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-slug">SKU (slug)</Label>
              <Input
                id="new-sku-slug"
                value={addSkuSlug}
                onChange={(e) => setAddSkuSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                maxLength={32}
                placeholder="e.g. matcha"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-name">Name</Label>
              <Input
                id="new-sku-name"
                value={addSkuName}
                onChange={(e) => setAddSkuName(e.target.value)}
                maxLength={80}
                placeholder="e.g. Matcha cookies"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-threshold">Low-stock threshold</Label>
              <Input
                id="new-sku-threshold"
                value={addSkuThreshold}
                onChange={(e) => setAddSkuThreshold(e.target.value.replace(/[^\d]/g, ""))}
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-code">Code (opt)</Label>
              <Input
                id="new-sku-code"
                value={addSkuCode}
                onChange={(e) => setAddSkuCode(e.target.value)}
                maxLength={16}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-initials">Initials (opt)</Label>
              <Input
                id="new-sku-initials"
                value={addSkuInitials}
                onChange={(e) => setAddSkuInitials(e.target.value)}
                maxLength={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-hue">Hue 0-360 (opt)</Label>
              <Input
                id="new-sku-hue"
                value={addSkuHue}
                onChange={(e) => setAddSkuHue(e.target.value.replace(/[^\d]/g, ""))}
                inputMode="numeric"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddSkuOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitAddSkuOpenPin}
              disabled={!createSkuKey || addSkuSlug.trim().length === 0 || addSkuName.trim().length === 0}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit metadata dialog (no PIN) */}
      <Dialog
        open={metaTarget !== null}
        onOpenChange={(o) => {
          if (!o) closeMetaEdit();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit product</DialogTitle>
            <DialogDescription>
              Metadata only — price is edited separately with manager PIN.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={metaName}
                onChange={(e) => setMetaName(e.target.value)}
                maxLength={80}
                disabled={metaBusy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-pack-label">Pack label</Label>
              <Input
                id="edit-pack-label"
                value={metaPackLabel}
                onChange={(e) => setMetaPackLabel(e.target.value)}
                disabled={metaBusy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-sku-family">SKU family</Label>
              <Input
                id="edit-sku-family"
                value={metaSkuFamily}
                onChange={(e) => setMetaSkuFamily(e.target.value)}
                disabled={metaBusy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-sort">Sort order</Label>
              <Input
                id="edit-sort"
                value={metaSortOrder}
                onChange={(e) =>
                  setMetaSortOrder(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                disabled={metaBusy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-initials">Initials</Label>
              <Input
                id="edit-initials"
                value={metaInitials}
                onChange={(e) => setMetaInitials(e.target.value)}
                maxLength={3}
                disabled={metaBusy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-hue">Hue 0-360</Label>
              <Input
                id="edit-hue"
                value={metaHue}
                onChange={(e) =>
                  setMetaHue(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                disabled={metaBusy}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={closeMetaEdit}
              disabled={metaBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={commitMetaEdit}
              disabled={metaBusy || !metaKey}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit price/tax dialog (opens PIN) */}
      <Dialog
        open={priceTarget !== null}
        onOpenChange={(o) => {
          if (!o) closePriceEdit();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit price</DialogTitle>
            <DialogDescription>
              {priceTarget?.name ?? ""} — manager PIN required.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="price-buf">Price (Rp)</Label>
              <Input
                id="price-buf"
                value={priceBuf}
                onChange={(e) =>
                  setPriceBuf(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
              />
              {parseIntStrict(priceBuf) !== null && (
                <p className="text-xs text-muted-foreground">
                  {rp(parseIntStrict(priceBuf) as number)}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="price-tax">Tax rate (%)</Label>
              <Input
                id="price-tax"
                value={priceTaxBuf}
                onChange={(e) =>
                  setPriceTaxBuf(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={closePriceEdit}>
              Cancel
            </Button>
            <Button
              onClick={submitPriceOpenPin}
              disabled={
                !pricingKey ||
                parseIntStrict(priceBuf) === null ||
                parseIntStrict(priceTaxBuf) === null
              }
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Components editor (replace-set) */}
      <Dialog
        open={compTarget !== null}
        onOpenChange={(o) => {
          if (!o) closeComponents();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Components</DialogTitle>
            <DialogDescription>
              {compTarget?.name ?? ""} — replace-set; saving overwrites all
              component rows for this product.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {compRows.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                No components — add a row.
              </p>
            ) : (
              compRows.map((row, idx) => (
                <div key={idx} className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">SKU</Label>
                    <Select
                      value={row.inventory_sku_id || undefined}
                      onValueChange={(v) =>
                        updateCompRow(idx, {
                          inventory_sku_id: v as Id<"pos_inventory_skus">,
                        })
                      }
                      disabled={compBusy}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Pick SKU" />
                      </SelectTrigger>
                      <SelectContent>
                        {activeSkus.map((s) => (
                          <SelectItem key={s._id} value={s._id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="w-20 space-y-1">
                    <Label className="text-xs">Qty</Label>
                    <Input
                      value={String(row.qty)}
                      onChange={(e) => {
                        const n = parseIntStrict(
                          e.target.value.replace(/[^\d]/g, ""),
                        );
                        updateCompRow(idx, { qty: n ?? 0 });
                      }}
                      inputMode="numeric"
                      disabled={compBusy}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeCompRow(idx)}
                    disabled={compBusy}
                  >
                    ×
                  </Button>
                </div>
              ))
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={addCompRow}
              disabled={compBusy}
            >
              Add row
            </Button>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={closeComponents}
              disabled={compBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={commitComponents}
              disabled={compBusy || !componentsKey}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PinSheet
        open={pinAction !== null}
        title={pinTitle}
        label={pinLabel}
        pending={pinPending}
        error={pinError}
        onSubmit={handlePinSubmit}
        onCancel={handlePinCancel}
      />
    </SpokeLayout>
  );
}

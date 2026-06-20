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
import { ProductThumb } from "@/components/pos/ProductThumb";
import { downscaleToWebp } from "@/lib/imageDownscale";
import { FieldMessage } from "@/components/ui/field-message";
import { useFieldErrors } from "@/hooks/useFieldErrors";
import { rp, parseIntStrict } from "@/lib/format";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

type Product = Doc<"pos_products"> & { photo_url: string | null };
type Sku = Doc<"pos_inventory_skus">;
type Component = Doc<"pos_product_components">;

type ComponentRow = {
  inventory_sku_id: Id<"pos_inventory_skus"> | "";
  qty: number;
};

type PinAction =
  | {
      kind: "createProduct";
      code: string;
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
  if (m.includes("INVALID_PRODUCT_CODE")) return "Product code must be UPPERCASE_SNAKE (e.g. DUBAI_8PC).";
  if (m.includes("CODE_EXISTS")) return "That code is already in use.";
  if (m.includes("SKU_INVALID")) return "SKU must be lowercase letters, numbers, or hyphens (max 32).";
  if (m.includes("SKU_FAMILY_NOT_SLUGGABLE")) return "SKU family must be lowercase letters, numbers, or hyphens (max 32) when creating a matching SKU.";
  if (m.includes("LOW_THRESHOLD_INVALID")) return "Low-stock threshold must be a non-negative integer.";
  if (m.includes("PRODUCT_NOT_FOUND")) return "Product not found.";
  if (m.includes("NAME_INVALID")) return "Name must be 1-80 characters.";
  if (m.includes("INVALID_PIN")) return "Wrong manager PIN.";
  if (m.includes("LOCKED_OUT")) return "Too many attempts — locked out for 60s.";
  if (m.includes("SESSION_INVALID")) return "Session expired. Lock and log in again.";
  if (m.includes("NOT_MANAGER") || m.includes("MANAGER_SESSION_REQUIRED")) return "Only managers can do that.";
  return "Something went wrong.";
}

// SKU slug contract, mirrors the backend SKU_SLUG_RE (convex/catalog/internal.ts).
// FE/BE duplication across the runtime boundary is expected; named once here so
// the standalone Add-SKU validator and the bundled slug preview can't drift.
const SKU_SLUG_RE = /^[a-z0-9-]{1,32}$/;

// ─── Focus maps (module scope — no closure deps, recreating each render wastes memory) ──
const SKU_FOCUS: Record<string, string> = {
  "sku.slug": "new-sku-slug",
  "sku.name": "new-sku-name",
  "sku.threshold": "new-sku-threshold",
  "sku.hue": "new-sku-hue",
};

const ADD_FOCUS: Record<string, string> = {
  "add.code": "new-product-code",
  "add.name": "new-product-name",
  "add.packLabel": "new-pack-label",
  "add.skuFamily": "new-sku-family",
  "add.price": "new-price",
  "add.tax": "new-tax",
  "add.sortOrder": "new-sort",
  "add.initials": "new-initials",
  "add.hue": "new-hue",
  "add.bundleQty": "bundle-qty",
  "add.bundleThreshold": "bundle-threshold",
};

const META_FOCUS: Record<string, string> = {
  "meta.name": "edit-name",
  "meta.packLabel": "edit-pack-label",
  "meta.skuFamily": "edit-sku-family",
  "meta.sortOrder": "edit-sort",
  "meta.initials": "edit-initials",
  "meta.hue": "edit-hue",
};

const PRICE_FOCUS: Record<string, string> = {
  "price.price": "price-buf",
  "price.tax": "price-tax",
};

export default function MgrProducts() {
  const navigate = useNavigate();
  const session = useSession();
  const t = useT();

  if (session.status === "loading") {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
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

  // ─── Per-field inline error state ───────────────────────────────────────────
  const { errors, clearFieldError, clearErrors, mergeErrors, applyErrors } = useFieldErrors();

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
  const [addProductCode, setAddProductCode] = useState("");
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
    clearErrors("sku.");
    setAddSkuOpen(true);
  }

  // Focus map for Add SKU dialog → SKU_FOCUS at module scope.

  function submitAddSkuOpenPin() {
    const next: Record<string, string> = {};
    const sku = addSkuSlug.trim().toLowerCase();
    if (!SKU_SLUG_RE.test(sku)) next["sku.slug"] = "SKU must be lowercase letters, numbers, or hyphens (max 32).";
    const name = addSkuName.trim();
    if (name.length === 0 || name.length > 80) next["sku.name"] = "Name must be 1-80 characters.";
    const low_threshold = parseIntStrict(addSkuThreshold);
    if (low_threshold === null) next["sku.threshold"] = "Low-stock threshold must be a non-negative integer.";
    const code = addSkuCode.trim().length > 0 ? addSkuCode.trim() : undefined;
    const initials = addSkuInitials.trim().length > 0 ? addSkuInitials.trim() : undefined;
    let hue: number | undefined = undefined;
    if (addSkuHue.trim().length > 0) {
      const h = parseIntStrict(addSkuHue);
      if (h === null || h > 360) next["sku.hue"] = "Hue must be an integer between 0 and 360.";
      else hue = h;
    }
    if (applyErrors("sku.", next, SKU_FOCUS)) return;
    setPinAction({ kind: "createInventorySku", sku, name, low_threshold: low_threshold as number, code, initials, hue });
    setPinError(undefined);
  }

  function openAdd() {
    setAddProductCode("");
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
    clearErrors("add.");
    setAddOpen(true);
  }

  // Slug preview for the bundled-SKU checkbox, derived live from the typed
  // sku_family. Declared here (above its first use in submitAddOpenPin) so the
  // handler doesn't forward-reference a const declared further down the body.
  const bundleSlugPreview = addSkuFamily.trim().toLowerCase();
  const bundleSlugValid = SKU_SLUG_RE.test(bundleSlugPreview);
  // Single source of truth for "the bundled-SKU inputs are submittable", used
  // by the Continue button's disabled gate. submitAddOpenPin re-checks each
  // field individually to surface a specific toast; the button only needs the
  // boolean, so the parse logic lives here once instead of inline in the JSX.
  const bundleInputsValid =
    !addWithSku ||
    (bundleSlugValid &&
      (parseIntStrict(addSkuComponentQty) ?? 0) >= 1 &&
      parseIntStrict(addBundleThreshold) !== null);

  // Focus map for Add product dialog → ADD_FOCUS at module scope.

  function submitAddOpenPin() {
    const next: Record<string, string> = {};
    const code = addProductCode.trim();
    const PRODUCT_CODE_RE = /^[A-Z][A-Z0-9_]*$/;
    if (!PRODUCT_CODE_RE.test(code)) next["add.code"] = "Product code must start with a capital letter and contain only A-Z, 0-9, and _. E.g. DUBAI_8PC";
    const name = addName.trim();
    if (name.length === 0 || name.length > 80) next["add.name"] = "Name must be 1-80 characters.";
    const pack_label = addPackLabel.trim();
    if (pack_label.length === 0) next["add.packLabel"] = "Pack label is required.";
    const sku_family = addSkuFamily.trim();
    if (sku_family.length === 0) next["add.skuFamily"] = "SKU family is required.";
    const price_idr = parseIntStrict(addPrice);
    if (price_idr === null) next["add.price"] = "Price must be a non-negative integer.";
    const tax_rate = parseIntStrict(addTax);
    if (tax_rate === null || tax_rate > 11) next["add.tax"] = "Tax rate must be an integer between 0 and 11.";
    const sort_order = parseIntStrict(addSortOrder);
    if (sort_order === null) next["add.sortOrder"] = "Sort order must be a non-negative integer.";
    const initialsRaw = addInitials.trim();
    if (initialsRaw.length > 3) next["add.initials"] = "Initials must be 1-3 characters.";
    let hue: number | undefined = undefined;
    if (addHue.trim().length > 0) {
      const h = parseIntStrict(addHue);
      if (h === null || h > 360) next["add.hue"] = "Hue must be an integer between 0 and 360.";
      else hue = h;
    }
    let withInventorySku: boolean | undefined = undefined;
    let inventorySkuLowThreshold: number | undefined = undefined;
    let inventorySkuComponentQty: number | undefined = undefined;
    if (addWithSku) {
      if (sku_family.length > 0 && !bundleSlugValid) next["add.skuFamily"] = "SKU family must be lowercase letters, numbers, or hyphens (max 32) when creating a matching SKU.";
      const qty = parseIntStrict(addSkuComponentQty);
      if (qty === null || qty < 1) next["add.bundleQty"] = "Component qty must be a positive integer.";
      const threshold = parseIntStrict(addBundleThreshold);
      if (threshold === null) next["add.bundleThreshold"] = "Low-stock threshold must be a non-negative integer.";
      if (bundleSlugValid && qty !== null && qty >= 1 && threshold !== null) {
        withInventorySku = true;
        inventorySkuLowThreshold = threshold;
        inventorySkuComponentQty = qty;
      }
    }
    if (applyErrors("add.", next, ADD_FOCUS)) return;
    setPinAction({
      kind: "createProduct",
      code,
      name,
      pack_label,
      sku_family,
      price_idr: price_idr as number,
      tax_rate: tax_rate as number,
      sort_order: sort_order as number,
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

  // ─── Photo upload state (meta-edit dialog) ──────────────────────────────────
  const [metaPhotoId, setMetaPhotoId] = useState<Id<"_storage"> | undefined>(undefined);
  const [metaPhotoPreview, setMetaPhotoPreview] = useState<string | null>(null);
  const [metaRemovePhoto, setMetaRemovePhoto] = useState(false);
  const [metaPhotoBusy, setMetaPhotoBusy] = useState(false);
  const photoUploadKey = useIdempotency("catalog.photoUploadUrl");
  const generatePhotoUrl = useMutation(api.catalog.public.generateProductPhotoUploadUrl);

  async function handlePhotoPick(file: File) {
    if (!photoUploadKey) return;
    setMetaPhotoBusy(true);
    try {
      const blob = await downscaleToWebp(file, 400);
      const { uploadUrl } = await generatePhotoUrl({ idempotencyKey: photoUploadKey, sessionId });
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      if (!res.ok) throw new Error("UPLOAD_FAILED");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await clearIntent("catalog.photoUploadUrl"); // rotate so the next upload mints a fresh URL
      // revoke a prior object-url preview before replacing
      if (metaPhotoPreview?.startsWith("blob:")) URL.revokeObjectURL(metaPhotoPreview);
      setMetaPhotoId(storageId);
      setMetaRemovePhoto(false);
      setMetaPhotoPreview(URL.createObjectURL(blob));
    } catch (err) {
      // Rotate the intent on failure too: the minted upload URL may already be
      // consumed/expired, so a retry on the same key must mint a fresh one
      // (mirrors the receipt-logo handler — clears on both success and error).
      await clearIntent("catalog.photoUploadUrl");
      toast.error(humanizeCatalogError(err));
    } finally {
      setMetaPhotoBusy(false);
    }
  }

  // Focus map for Edit metadata dialog → META_FOCUS at module scope.

  function openMetaEdit(p: Product) {
    setMetaTarget(p);
    setMetaName(p.name);
    setMetaPackLabel(p.pack_label);
    setMetaSkuFamily(p.sku_family);
    setMetaSortOrder(String(p.sort_order));
    setMetaInitials(p.initials ?? "");
    setMetaHue(p.hue !== undefined ? String(p.hue) : "");
    setMetaPhotoId(undefined);
    setMetaRemovePhoto(false);
    setMetaPhotoPreview(p.photo_url);
    clearErrors("meta.");
  }

  function closeMetaEdit() {
    if (metaPhotoPreview?.startsWith("blob:")) URL.revokeObjectURL(metaPhotoPreview);
    setMetaPhotoPreview(null);
    setMetaTarget(null);
  }

  async function commitMetaEdit() {
    if (!metaTarget || !metaKey) return;
    const next: Record<string, string> = {};
    const name = metaName.trim();
    if (name.length === 0 || name.length > 80) next["meta.name"] = "Name must be 1-80 characters.";
    const pack_label = metaPackLabel.trim();
    if (pack_label.length === 0) next["meta.packLabel"] = "Pack label is required.";
    const sku_family = metaSkuFamily.trim();
    if (sku_family.length === 0) next["meta.skuFamily"] = "SKU family is required.";
    const sort_order = parseIntStrict(metaSortOrder);
    if (sort_order === null) next["meta.sortOrder"] = "Sort order must be a non-negative integer.";
    const initialsRaw = metaInitials.trim();
    if (initialsRaw.length > 3) next["meta.initials"] = "Initials must be 1-3 characters.";
    let hue: number | undefined = undefined;
    if (metaHue.trim().length > 0) {
      const h = parseIntStrict(metaHue);
      if (h === null || h > 360) next["meta.hue"] = "Hue must be an integer between 0 and 360.";
      else hue = h;
    }
    if (applyErrors("meta.", next, META_FOCUS)) return;
    setMetaBusy(true);
    try {
      await updateProductMeta({
        idempotencyKey: metaKey,
        sessionId,
        productId: metaTarget._id,
        name,
        pack_label,
        sort_order: sort_order as number,
        sku_family,
        initials: initialsRaw.length > 0 ? initialsRaw : undefined,
        hue,
        photo_storage_id: metaRemovePhoto ? null : (metaPhotoId ?? undefined),
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

  // Focus map for Edit price dialog → PRICE_FOCUS at module scope.

  function openPriceEdit(p: Product) {
    setPriceTarget(p);
    setPriceBuf(String(p.price_idr));
    setPriceTaxBuf(String(p.tax_rate));
    clearErrors("price.");
  }

  function closePriceEdit() {
    setPriceTarget(null);
  }

  function submitPriceOpenPin() {
    if (!priceTarget) return;
    const next: Record<string, string> = {};
    const price_idr = parseIntStrict(priceBuf);
    if (price_idr === null) next["price.price"] = "Price must be a non-negative integer.";
    const tax_rate = parseIntStrict(priceTaxBuf);
    if (tax_rate === null || tax_rate > 11) next["price.tax"] = "Tax rate must be an integer between 0 and 11.";
    if (applyErrors("price.", next, PRICE_FOCUS)) return;
    setPinAction({
      kind: "updatePricing",
      productId: priceTarget._id,
      productName: priceTarget.name,
      price_idr: price_idr as number,
      tax_rate: tax_rate as number,
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
    clearErrors("comp.");
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
    clearFieldError(`comp.row${idx}`);
  }

  async function commitComponents() {
    if (!compTarget || !componentsKey) return;
    // Client-side guard — backend re-validates.
    const next: Record<string, string> = {};
    compRows.forEach((r, idx) => {
      if (r.inventory_sku_id === "") {
        next[`comp.row${idx}`] = "Pick an SKU for every row.";
      } else if (!Number.isInteger(r.qty) || r.qty <= 0) {
        next[`comp.row${idx}`] = "Qty must be a positive integer.";
      }
    });
    mergeErrors("comp.", next);
    if (Object.keys(next).length > 0) {
      const firstErrIdx = compRows.findIndex((_, i) => next[`comp.row${i}`] !== undefined);
      if (firstErrIdx !== -1) {
        const el = document.getElementById(`comp-row-qty-${firstErrIdx}`);
        el?.focus();
        el?.scrollIntoView?.({ block: "nearest" });
      }
      return;
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
            code: pinAction.code,
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
  const t = useT();

  const pinTitle =
    pinAction?.kind === "createProduct"
      ? t("mgrProducts.pinTitleAdd")
      : pinAction?.kind === "updatePricing"
        ? t("mgrProducts.pinTitleUpdatePricing")
        : pinAction?.kind === "createInventorySku"
          ? t("mgrProducts.pinTitleAddSku")
          : t("mgrProducts.pinTitleDefault");

  const pinLabel =
    pinAction?.kind === "createProduct"
      ? t("mgrProducts.pinLabelAdd", { name: pinAction.name })
      : pinAction?.kind === "updatePricing"
        ? t("mgrProducts.pinLabelUpdatePricing", { name: pinAction.productName })
        : pinAction?.kind === "createInventorySku"
          ? t("mgrProducts.pinLabelAddSku", { sku: pinAction.sku })
          : t("mgrProducts.pinLabelDefault");

  // Quick lookup for SKU name display.
  const skuById = useMemo(() => {
    const map = new Map<string, Sku>();
    if (data) for (const s of data.skus) map.set(s._id, s);
    return map;
  }, [data]);

  return (
    <SpokeLayout title={t("mgrProducts.title")} backTo="/">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">
              {t("mgrProducts.subtitle")}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={openAddSku}>
              {t("mgrProducts.addSku")}
            </Button>
            <Button size="sm" onClick={openAdd}>
              {t("mgrProducts.addProduct")}
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
              {t("mgrProducts.noProducts")}
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
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <div className="w-10 shrink-0">
                        <ProductThumb
                          photoUrl={p.photo_url}
                          initials={p.initials}
                          hue={p.hue}
                          name={p.name}
                          code={p.code}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium leading-tight">{p.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t("mgrProducts.skuInfoLine", { packLabel: p.pack_label, skuFamily: p.sku_family, sortOrder: p.sort_order })}
                        </p>
                        <p className="mt-1 text-sm font-mono">
                          {rp(p.price_idr)}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t("mgrProducts.taxDisplay", { rate: p.tax_rate })}
                          </span>
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!p.active && (
                        <Badge variant="outline" className="text-[10px]">
                          {t("mgrProducts.archived")}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {productComponents.length > 0 && (
                    <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                      <p className="mb-1 font-medium text-muted-foreground">
                        {t("mgrProducts.componentsLabel")}
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
                        {t("mgrProducts.editBtn")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => openPriceEdit(p)}
                      >
                        {t("mgrProducts.editPriceBtn")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => openComponents(p)}
                      >
                        {t("mgrProducts.componentsBtn")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => archiveOne(p)}
                        disabled={!archiveKey}
                      >
                        {t("mgrProducts.archiveBtn")}
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
            <DialogTitle>{t("mgrProducts.addProductTitle")}</DialogTitle>
            <DialogDescription>
              {t("mgrProducts.pinRequiredAfterContinue")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="new-product-code">{t("mgrProducts.fieldProductCode")}</Label>
              <Input
                id="new-product-code"
                value={addProductCode}
                onChange={(e) => {
                  setAddProductCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""));
                  clearFieldError("add.code");
                }}
                placeholder={t("mgrProducts.placeholderProductCode")}
                aria-invalid={!!errors["add.code"]}
                aria-describedby={errors["add.code"] ? "add.code-error" : undefined}
              />
              {errors["add.code"] && (
                <FieldMessage id="add.code-error">{errors["add.code"]}</FieldMessage>
              )}
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="new-product-name">{t("mgrProducts.fieldName")}</Label>
              <Input
                id="new-product-name"
                value={addName}
                onChange={(e) => {
                  setAddName(e.target.value);
                  clearFieldError("add.name");
                }}
                maxLength={80}
                placeholder={t("mgrProducts.placeholderProductName")}
                aria-invalid={!!errors["add.name"]}
                aria-describedby={errors["add.name"] ? "add.name-error" : undefined}
              />
              {errors["add.name"] && (
                <FieldMessage id="add.name-error">{errors["add.name"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-pack-label">{t("mgrProducts.fieldPackLabel")}</Label>
              <Input
                id="new-pack-label"
                value={addPackLabel}
                onChange={(e) => {
                  setAddPackLabel(e.target.value);
                  clearFieldError("add.packLabel");
                }}
                placeholder={t("mgrProducts.placeholderPackLabel")}
                aria-invalid={!!errors["add.packLabel"]}
                aria-describedby={errors["add.packLabel"] ? "add.packLabel-error" : undefined}
              />
              {errors["add.packLabel"] && (
                <FieldMessage id="add.packLabel-error">{errors["add.packLabel"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-family">{t("mgrProducts.fieldSkuFamily")}</Label>
              <Input
                id="new-sku-family"
                value={addSkuFamily}
                onChange={(e) => {
                  setAddSkuFamily(e.target.value);
                  clearFieldError("add.skuFamily");
                }}
                placeholder={t("mgrProducts.placeholderSkuFamily")}
                aria-invalid={!!errors["add.skuFamily"]}
                aria-describedby={errors["add.skuFamily"] ? "add.skuFamily-error" : undefined}
              />
              {errors["add.skuFamily"] && (
                <FieldMessage id="add.skuFamily-error">{errors["add.skuFamily"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-price">{t("mgrProducts.fieldPrice")}</Label>
              <Input
                id="new-price"
                value={addPrice}
                onChange={(e) => {
                  setAddPrice(e.target.value.replace(/[^\d]/g, ""));
                  clearFieldError("add.price");
                }}
                inputMode="numeric"
                placeholder={t("mgrProducts.placeholderPriceExample")}
                aria-invalid={!!errors["add.price"]}
                aria-describedby={errors["add.price"] ? "add.price-error" : undefined}
              />
              {errors["add.price"] && (
                <FieldMessage id="add.price-error">{errors["add.price"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-tax">{t("mgrProducts.fieldTax")}</Label>
              <Input
                id="new-tax"
                value={addTax}
                onChange={(e) => {
                  setAddTax(e.target.value.replace(/[^\d]/g, ""));
                  clearFieldError("add.tax");
                }}
                inputMode="numeric"
                placeholder="0"
                aria-invalid={!!errors["add.tax"]}
                aria-describedby={errors["add.tax"] ? "add.tax-error" : undefined}
              />
              {errors["add.tax"] && (
                <FieldMessage id="add.tax-error">{errors["add.tax"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sort">{t("mgrProducts.fieldSortOrder")}</Label>
              <Input
                id="new-sort"
                value={addSortOrder}
                onChange={(e) => {
                  setAddSortOrder(e.target.value.replace(/[^\d]/g, ""));
                  clearFieldError("add.sortOrder");
                }}
                inputMode="numeric"
                aria-invalid={!!errors["add.sortOrder"]}
                aria-describedby={errors["add.sortOrder"] ? "add.sortOrder-error" : undefined}
              />
              {errors["add.sortOrder"] && (
                <FieldMessage id="add.sortOrder-error">{errors["add.sortOrder"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-initials">{t("mgrProducts.fieldInitials")}</Label>
              <Input
                id="new-initials"
                value={addInitials}
                onChange={(e) => {
                  setAddInitials(e.target.value);
                  clearFieldError("add.initials");
                }}
                maxLength={3}
                placeholder="D8"
                aria-invalid={!!errors["add.initials"]}
                aria-describedby={errors["add.initials"] ? "add.initials-error" : undefined}
              />
              {errors["add.initials"] && (
                <FieldMessage id="add.initials-error">{errors["add.initials"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-hue">{t("mgrProducts.fieldHue")}</Label>
              <Input
                id="new-hue"
                value={addHue}
                onChange={(e) => {
                  setAddHue(e.target.value.replace(/[^\d]/g, ""));
                  clearFieldError("add.hue");
                }}
                inputMode="numeric"
                placeholder={t("mgrProducts.placeholderHueExample")}
                aria-invalid={!!errors["add.hue"]}
                aria-describedby={errors["add.hue"] ? "add.hue-error" : undefined}
              />
              {errors["add.hue"] && (
                <FieldMessage id="add.hue-error">{errors["add.hue"]}</FieldMessage>
              )}
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
                  <span className="font-medium">{t("mgrProducts.withSkuLabel")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t("mgrProducts.withSkuHint")}
                  </span>
                </span>
              </label>
              {addWithSku && (
                <div className="ml-6 space-y-2">
                  <div className="text-xs">
                    <span className="text-muted-foreground">{t("mgrProducts.slugLabel")} </span>
                    <span className="font-mono">
                      {bundleSlugValid ? bundleSlugPreview : t("mgrProducts.slugPlaceholder")}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="bundle-qty">{t("mgrProducts.fieldComponentQty")}</Label>
                      <Input
                        id="bundle-qty"
                        value={addSkuComponentQty}
                        onChange={(e) => {
                          setAddSkuComponentQty(e.target.value.replace(/[^\d]/g, ""));
                          clearFieldError("add.bundleQty");
                        }}
                        inputMode="numeric"
                        placeholder="1"
                        aria-invalid={!!errors["add.bundleQty"]}
                        aria-describedby={errors["add.bundleQty"] ? "add.bundleQty-error" : undefined}
                      />
                      {errors["add.bundleQty"] && (
                        <FieldMessage id="add.bundleQty-error">{errors["add.bundleQty"]}</FieldMessage>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="bundle-threshold">{t("mgrProducts.fieldLowStockThreshold")}</Label>
                      <Input
                        id="bundle-threshold"
                        value={addBundleThreshold}
                        onChange={(e) => {
                          setAddBundleThreshold(e.target.value.replace(/[^\d]/g, ""));
                          clearFieldError("add.bundleThreshold");
                        }}
                        inputMode="numeric"
                        placeholder="0"
                        aria-invalid={!!errors["add.bundleThreshold"]}
                        aria-describedby={errors["add.bundleThreshold"] ? "add.bundleThreshold-error" : undefined}
                      />
                      {errors["add.bundleThreshold"] && (
                        <FieldMessage id="add.bundleThreshold-error">{errors["add.bundleThreshold"]}</FieldMessage>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {!bundleSlugValid && (
                <p className="text-xs text-muted-foreground">
                  {t("mgrProducts.withSkuDisabledHint")}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={submitAddOpenPin}
              disabled={!createKey || addName.trim().length === 0 || !bundleInputsValid}
            >
              {t("mgrProducts.continueBtn")}
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
            <DialogTitle>{t("mgrProducts.addSkuTitle")}</DialogTitle>
            <DialogDescription>
              {t("mgrProducts.pinRequiredAfterContinue")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-slug">{t("mgrProducts.fieldSkuSlug")}</Label>
              <Input
                id="new-sku-slug"
                value={addSkuSlug}
                onChange={(e) => {
                  setAddSkuSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                  clearFieldError("sku.slug");
                }}
                maxLength={32}
                placeholder={t("mgrProducts.placeholderSkuSlug")}
                aria-invalid={!!errors["sku.slug"]}
                aria-describedby={errors["sku.slug"] ? "sku.slug-error" : undefined}
              />
              {errors["sku.slug"] && (
                <FieldMessage id="sku.slug-error">{errors["sku.slug"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-name">{t("mgrProducts.fieldName")}</Label>
              <Input
                id="new-sku-name"
                value={addSkuName}
                onChange={(e) => {
                  setAddSkuName(e.target.value);
                  clearFieldError("sku.name");
                }}
                maxLength={80}
                placeholder={t("mgrProducts.placeholderSkuName")}
                aria-invalid={!!errors["sku.name"]}
                aria-describedby={errors["sku.name"] ? "sku.name-error" : undefined}
              />
              {errors["sku.name"] && (
                <FieldMessage id="sku.name-error">{errors["sku.name"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-threshold">{t("mgrProducts.fieldLowStockThreshold")}</Label>
              <Input
                id="new-sku-threshold"
                value={addSkuThreshold}
                onChange={(e) => {
                  setAddSkuThreshold(e.target.value.replace(/[^\d]/g, ""));
                  clearFieldError("sku.threshold");
                }}
                inputMode="numeric"
                aria-invalid={!!errors["sku.threshold"]}
                aria-describedby={errors["sku.threshold"] ? "sku.threshold-error" : undefined}
              />
              {errors["sku.threshold"] && (
                <FieldMessage id="sku.threshold-error">{errors["sku.threshold"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-code">{t("mgrProducts.fieldCode")}</Label>
              <Input
                id="new-sku-code"
                value={addSkuCode}
                onChange={(e) => setAddSkuCode(e.target.value)}
                maxLength={16}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-initials">{t("mgrProducts.fieldInitials")}</Label>
              <Input
                id="new-sku-initials"
                value={addSkuInitials}
                onChange={(e) => setAddSkuInitials(e.target.value)}
                maxLength={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sku-hue">{t("mgrProducts.fieldHue")}</Label>
              <Input
                id="new-sku-hue"
                value={addSkuHue}
                onChange={(e) => {
                  setAddSkuHue(e.target.value.replace(/[^\d]/g, ""));
                  clearFieldError("sku.hue");
                }}
                inputMode="numeric"
                aria-invalid={!!errors["sku.hue"]}
                aria-describedby={errors["sku.hue"] ? "sku.hue-error" : undefined}
              />
              {errors["sku.hue"] && (
                <FieldMessage id="sku.hue-error">{errors["sku.hue"]}</FieldMessage>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddSkuOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={submitAddSkuOpenPin}
              disabled={!createSkuKey || addSkuSlug.trim().length === 0 || addSkuName.trim().length === 0}
            >
              {t("mgrProducts.continueBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit metadata dialog (no PIN) */}
      <Dialog
        open={metaTarget !== null}
        onOpenChange={(o) => {
          // Don't let ESC / backdrop close the dialog mid-upload — closing would
          // strand the in-flight handlePhotoPick (leaked object URL + orphan blob).
          if (!o && !metaPhotoBusy) closeMetaEdit();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("mgrProducts.editProductTitle")}</DialogTitle>
            <DialogDescription>
              {t("mgrProducts.editProductDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="edit-name">{t("mgrProducts.fieldName")}</Label>
              <Input
                id="edit-name"
                value={metaName}
                onChange={(e) => {
                  setMetaName(e.target.value);
                  clearFieldError("meta.name");
                }}
                maxLength={80}
                disabled={metaBusy}
                aria-invalid={!!errors["meta.name"]}
                aria-describedby={errors["meta.name"] ? "meta.name-error" : undefined}
              />
              {errors["meta.name"] && (
                <FieldMessage id="meta.name-error">{errors["meta.name"]}</FieldMessage>
              )}
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>{t("mgrProducts.photoLabel")}</Label>
              <div className="flex items-center gap-3">
                <div className="w-16 shrink-0">
                  <ProductThumb
                    photoUrl={metaRemovePhoto ? null : metaPhotoPreview}
                    initials={metaInitials.trim() || undefined}
                    hue={metaHue.trim() ? Number(metaHue) : undefined}
                    name={metaName || metaTarget?.name || ""}
                    code={metaTarget?.code ?? ""}
                  />
                </div>
                <div className="flex-1 space-y-1.5">
                  <input
                    id="edit-photo-input"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={metaBusy || metaPhotoBusy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handlePhotoPick(f);
                      e.target.value = ""; // allow re-pick of the same file
                    }}
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={metaBusy || metaPhotoBusy}
                      onClick={() => document.getElementById("edit-photo-input")?.click()}
                    >
                      {metaPhotoBusy ? t("mgrProducts.photoUploading") : t("mgrProducts.uploadPhoto")}
                    </Button>
                    {(metaPhotoPreview || metaTarget?.photo_url) && !metaRemovePhoto && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={metaBusy || metaPhotoBusy}
                        onClick={() => {
                          if (metaPhotoPreview?.startsWith("blob:")) URL.revokeObjectURL(metaPhotoPreview);
                          setMetaPhotoPreview(null);
                          setMetaPhotoId(undefined);
                          setMetaRemovePhoto(true);
                        }}
                      >
                        {t("mgrProducts.removePhoto")}
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{t("mgrProducts.photoHint")}</p>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-pack-label">{t("mgrProducts.fieldPackLabel")}</Label>
              <Input
                id="edit-pack-label"
                value={metaPackLabel}
                onChange={(e) => {
                  setMetaPackLabel(e.target.value);
                  clearFieldError("meta.packLabel");
                }}
                disabled={metaBusy}
                aria-invalid={!!errors["meta.packLabel"]}
                aria-describedby={errors["meta.packLabel"] ? "meta.packLabel-error" : undefined}
              />
              {errors["meta.packLabel"] && (
                <FieldMessage id="meta.packLabel-error">{errors["meta.packLabel"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-sku-family">{t("mgrProducts.fieldSkuFamily")}</Label>
              <Input
                id="edit-sku-family"
                value={metaSkuFamily}
                onChange={(e) => {
                  setMetaSkuFamily(e.target.value);
                  clearFieldError("meta.skuFamily");
                }}
                disabled={metaBusy}
                aria-invalid={!!errors["meta.skuFamily"]}
                aria-describedby={errors["meta.skuFamily"] ? "meta.skuFamily-error" : undefined}
              />
              {errors["meta.skuFamily"] && (
                <FieldMessage id="meta.skuFamily-error">{errors["meta.skuFamily"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-sort">{t("mgrProducts.fieldSortOrder")}</Label>
              <Input
                id="edit-sort"
                value={metaSortOrder}
                onChange={(e) => {
                  setMetaSortOrder(e.target.value.replace(/[^\d]/g, ""));
                  clearFieldError("meta.sortOrder");
                }}
                inputMode="numeric"
                disabled={metaBusy}
                aria-invalid={!!errors["meta.sortOrder"]}
                aria-describedby={errors["meta.sortOrder"] ? "meta.sortOrder-error" : undefined}
              />
              {errors["meta.sortOrder"] && (
                <FieldMessage id="meta.sortOrder-error">{errors["meta.sortOrder"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-initials">{t("mgrProducts.fieldInitials")}</Label>
              <Input
                id="edit-initials"
                value={metaInitials}
                onChange={(e) => {
                  setMetaInitials(e.target.value);
                  clearFieldError("meta.initials");
                }}
                maxLength={3}
                disabled={metaBusy}
                aria-invalid={!!errors["meta.initials"]}
                aria-describedby={errors["meta.initials"] ? "meta.initials-error" : undefined}
              />
              {errors["meta.initials"] && (
                <FieldMessage id="meta.initials-error">{errors["meta.initials"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-hue">{t("mgrProducts.fieldHue")}</Label>
              <Input
                id="edit-hue"
                value={metaHue}
                onChange={(e) => {
                  setMetaHue(e.target.value.replace(/[^\d]/g, ""));
                  clearFieldError("meta.hue");
                }}
                inputMode="numeric"
                disabled={metaBusy}
                aria-invalid={!!errors["meta.hue"]}
                aria-describedby={errors["meta.hue"] ? "meta.hue-error" : undefined}
              />
              {errors["meta.hue"] && (
                <FieldMessage id="meta.hue-error">{errors["meta.hue"]}</FieldMessage>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={closeMetaEdit}
              disabled={metaBusy || metaPhotoBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={commitMetaEdit}
              disabled={metaBusy || metaPhotoBusy || !metaKey}
            >
              {t("common.save")}
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
            <DialogTitle>{t("mgrProducts.editPriceTitle")}</DialogTitle>
            <DialogDescription>
              {t("mgrProducts.editPriceDesc", { name: priceTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="price-buf">{t("mgrProducts.fieldPrice")}</Label>
              <Input
                id="price-buf"
                value={priceBuf}
                onChange={(e) => {
                  setPriceBuf(e.target.value.replace(/[^\d]/g, ""));
                  clearFieldError("price.price");
                }}
                inputMode="numeric"
                aria-invalid={!!errors["price.price"]}
                aria-describedby={errors["price.price"] ? "price.price-error" : undefined}
              />
              {parseIntStrict(priceBuf) !== null && (
                <p className="text-xs text-muted-foreground">
                  {rp(parseIntStrict(priceBuf) as number)}
                </p>
              )}
              {errors["price.price"] && (
                <FieldMessage id="price.price-error">{errors["price.price"]}</FieldMessage>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="price-tax">{t("mgrProducts.fieldTax")}</Label>
              <Input
                id="price-tax"
                value={priceTaxBuf}
                onChange={(e) => {
                  setPriceTaxBuf(e.target.value.replace(/[^\d]/g, ""));
                  clearFieldError("price.tax");
                }}
                inputMode="numeric"
                aria-invalid={!!errors["price.tax"]}
                aria-describedby={errors["price.tax"] ? "price.tax-error" : undefined}
              />
              {errors["price.tax"] && (
                <FieldMessage id="price.tax-error">{errors["price.tax"]}</FieldMessage>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={closePriceEdit}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={submitPriceOpenPin}
              disabled={
                !pricingKey ||
                parseIntStrict(priceBuf) === null ||
                parseIntStrict(priceTaxBuf) === null
              }
            >
              {t("mgrProducts.continueBtn")}
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
            <DialogTitle>{t("mgrProducts.componentsTitle")}</DialogTitle>
            <DialogDescription>
              {t("mgrProducts.componentsDesc", { name: compTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {compRows.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                {t("mgrProducts.noCompRows")}
              </p>
            ) : (
              compRows.map((row, idx) => (
                <div key={idx} className="space-y-1">
                  <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1">
                      <Label className="text-xs">{t("mgrProducts.fieldSkuSlug")}</Label>
                      <Select
                        value={row.inventory_sku_id || undefined}
                        onValueChange={(v) => {
                          updateCompRow(idx, {
                            inventory_sku_id: v as Id<"pos_inventory_skus">,
                          });
                        }}
                        disabled={compBusy}
                      >
                        <SelectTrigger aria-invalid={!!errors[`comp.row${idx}`]}>
                          <SelectValue placeholder={t("mgrProducts.pickSkuPlaceholder")} />
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
                      <Label className="text-xs">{t("mgrProducts.fieldQty")}</Label>
                      <Input
                        id={`comp-row-qty-${idx}`}
                        value={String(row.qty)}
                        onChange={(e) => {
                          const n = parseIntStrict(
                            e.target.value.replace(/[^\d]/g, ""),
                          );
                          updateCompRow(idx, { qty: n ?? 0 });
                        }}
                        inputMode="numeric"
                        disabled={compBusy}
                        aria-invalid={!!errors[`comp.row${idx}`]}
                        aria-describedby={errors[`comp.row${idx}`] ? `comp.row${idx}-error` : undefined}
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
                  {errors[`comp.row${idx}`] && (
                    <FieldMessage id={`comp.row${idx}-error`}>{errors[`comp.row${idx}`]}</FieldMessage>
                  )}
                </div>
              ))
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={addCompRow}
              disabled={compBusy}
            >
              {t("mgrProducts.addRow")}
            </Button>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={closeComponents}
              disabled={compBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={commitComponents}
              disabled={compBusy || !componentsKey}
            >
              {t("common.save")}
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

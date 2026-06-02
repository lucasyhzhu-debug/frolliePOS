/**
 * /mgr/receipt — manager-gated receipt branding (v0.5.3b Task 16).
 *
 * Exercises the v0.5.3b settings admin surface:
 *   - settings.public.getReceiptConfig        — session-gated (manager)
 *   - settings.public.generateLogoUploadUrl   — session-gated, returns short-lived upload URL
 *   - settings.public.updateReceiptConfig     — session-gated, persists 5 strings + optional logo
 *
 * Branding only — no PIN gate (per plan: low-stakes; manager session sufficient).
 * Layout mirrors /mgr/staff and /mgr/products: outer redirect + inner data hooks,
 * SpokeLayout shell, shadcn primitives, sonner toasts, idempotency intents
 * rotated via clearIntent on success.
 *
 * Live preview is FE-only — server-rendered receipts at /r/<token> remain the
 * authoritative render. Preview mirrors the server template's header/footer cues
 * (centered, dashed separators, teal business-name, Instagram footer line).
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { toast } from "sonner";

const MAX_FIELD_LEN = 120;
const MAX_LOGO_BYTES = 1_000_000;

type ReceiptConfig = {
  business_name: string;
  address: string;
  contact: string;
  instagram_handle: string;
  footer_text: string;
  logo_storage_id: Id<"_storage"> | null;
  logo_url: string | null;
};

function humanizeSettingsError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/FIELD_TOO_LONG/.test(m)) return "One of the fields is too long (max 120 chars).";
  if (m.includes("NOT_MANAGER")) return "Manager session required.";
  if (m.includes("SESSION_INVALID")) return "Session expired. Lock and log in again.";
  return "Couldn't save. Try again.";
}

export default function MgrReceipt() {
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

  return <MgrReceiptInner sessionId={session.sessionId} />;
}

function MgrReceiptInner({ sessionId }: { sessionId: Id<"staff_sessions"> }) {
  const config = useQuery(api.settings.public.getReceiptConfig, { sessionId }) as
    | ReceiptConfig
    | undefined;

  // One idempotency intent per distinct mutation surface.
  const uploadKey = useIdempotency("settings.logoUpload");
  const saveKey = useIdempotency("settings.updateReceipt");

  const generateLogoUploadUrl = useMutation(
    api.settings.public.generateLogoUploadUrl,
  );
  const updateReceiptConfig = useMutation(
    api.settings.public.updateReceiptConfig,
  );

  // Controlled form state.
  const [businessName, setBusinessName] = useState("");
  const [address, setAddress] = useState("");
  const [contact, setContact] = useState("");
  const [instagramHandle, setInstagramHandle] = useState("");
  const [footerText, setFooterText] = useState("");
  // logoStorageId is null on initial load (taken from config), then becomes a
  // new _storage Id after a successful upload. On save, we pass it only when
  // it differs from config.logo_storage_id (don't bounce the same id back).
  const [logoStorageId, setLogoStorageId] = useState<Id<"_storage"> | null>(null);
  // logoPreviewUrl is what the live preview <img> renders. Either an existing
  // public URL from config.logo_url (server-resolved) or a freshly-uploaded
  // file's object URL (revoked on replacement to avoid leaks).
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);

  const [seeded, setSeeded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  // File input ref so the styled button can trigger the hidden <input type=file>.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Track the last object URL we created so we can revoke it on replacement /
  // unmount. config.logo_url is a server URL — never revoke it.
  const objectUrlRef = useRef<string | null>(null);

  // Seed form state when getReceiptConfig first resolves. Done once (`seeded`)
  // to avoid clobbering the user's in-progress edits if the query refetches.
  useEffect(() => {
    if (!config || seeded) return;
    setBusinessName(config.business_name);
    setAddress(config.address);
    setContact(config.contact);
    setInstagramHandle(config.instagram_handle);
    setFooterText(config.footer_text);
    setLogoStorageId(config.logo_storage_id);
    setLogoPreviewUrl(config.logo_url);
    setSeeded(true);
  }, [config, seeded]);

  // Revoke the last-created object URL on unmount.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  // ─── Logo upload ────────────────────────────────────────────────────────────

  async function onPickLogo(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error("Logo must be under 1 MB.");
      return;
    }
    if (!uploadKey) {
      toast.error("Not ready yet — try again in a moment.");
      return;
    }
    setUploading(true);
    try {
      // BOTH calls below can fail: generateLogoUploadUrl (server) AND the
      // subsequent fetch upload (network/storage). If either throws, the cached
      // uploadUrl tied to `uploadKey` is now stale (Convex upload URLs are
      // short-lived) and the SAME key on a retry would replay the same stale
      // URL → silent re-failure. The catch below clearIntent's the key before
      // toasting so the next attempt mints a fresh URL.
      const { uploadUrl } = await generateLogoUploadUrl({
        idempotencyKey: uploadKey,
        sessionId,
      });
      // Convex upload URLs accept POST with the file body and return {storageId}.
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      // Rotate the intent so a subsequent upload picks a fresh URL.
      await clearIntent("settings.logoUpload");

      setLogoStorageId(storageId);

      // Browser-side preview via object URL — Convex doesn't expose a public
      // URL until the server resolves storage.getUrl() on next refetch. Revoke
      // the previous object URL (if any) to avoid memory leaks.
      const prev = objectUrlRef.current;
      const objectUrl = URL.createObjectURL(file);
      objectUrlRef.current = objectUrl;
      setLogoPreviewUrl(objectUrl);
      if (prev) URL.revokeObjectURL(prev);

      toast.success("Logo ready — Save to apply.");
    } catch {
      // Rotate the intent BEFORE the toast so the next retry mints a fresh
      // upload URL instead of replaying the stale one cached on `uploadKey`.
      await clearIntent("settings.logoUpload");
      toast.error("Logo upload failed. Try again.");
    } finally {
      setUploading(false);
      // Reset the input so the same file can be re-picked if needed.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ─── Save ───────────────────────────────────────────────────────────────────

  function validateClient(): string | null {
    const fields = {
      business_name: businessName,
      address,
      contact,
      instagram_handle: instagramHandle,
      footer_text: footerText,
    };
    for (const [, val] of Object.entries(fields)) {
      if (val.length > MAX_FIELD_LEN) return "One of the fields is too long (max 120 chars).";
    }
    if (businessName.trim().length === 0) return "Business name can't be empty.";
    return null;
  }

  async function onSave() {
    if (!saveKey || !config) return;
    const err = validateClient();
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    try {
      // Only send logo_storage_id if it changed — backend treats undefined as
      // "leave logo alone". Sending the same id back is a no-op but wastes audit
      // signal (the patch's logo_changed metadata would lie).
      const includeLogo =
        logoStorageId !== null && logoStorageId !== config.logo_storage_id;
      await updateReceiptConfig({
        idempotencyKey: saveKey,
        sessionId,
        business_name: businessName,
        address,
        contact,
        instagram_handle: instagramHandle,
        footer_text: footerText,
        ...(includeLogo ? { logo_storage_id: logoStorageId } : {}),
      });
      await clearIntent("settings.updateReceipt");
      toast.success("Saved. Customers see updated branding on next receipt.");
    } catch (e) {
      toast.error(humanizeSettingsError(e));
    } finally {
      setSaving(false);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (config === undefined) {
    return (
      <SpokeLayout title="Receipt settings" backTo="/">
        <div className="flex flex-1 flex-col gap-4 p-4">
          <Card className="p-4">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="mt-2 h-3 w-48 animate-pulse rounded bg-muted" />
          </Card>
        </div>
      </SpokeLayout>
    );
  }

  return (
    <SpokeLayout title="Receipt settings" backTo="/">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          Branding for customer receipts. Changes apply to new receipts after Save.
        </p>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Form column */}
          <Card className="space-y-4 p-4">
            <div className="space-y-1.5">
              <Label htmlFor="r-business-name">Business name</Label>
              <Input
                id="r-business-name"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                maxLength={MAX_FIELD_LEN}
                placeholder="Frollie · Pakuwon Mall"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="r-address">Address</Label>
              <Input
                id="r-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                maxLength={MAX_FIELD_LEN}
                placeholder="Pakuwon Mall, Lt. UG"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="r-contact">Contact</Label>
              <Input
                id="r-contact"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                maxLength={MAX_FIELD_LEN}
                placeholder="+62 812 3456 7890"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="r-instagram">Instagram handle</Label>
              <Input
                id="r-instagram"
                value={instagramHandle}
                onChange={(e) => setInstagramHandle(e.target.value)}
                maxLength={MAX_FIELD_LEN}
                placeholder="@frollie.id"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="r-footer">Footer text</Label>
              <textarea
                id="r-footer"
                value={footerText}
                onChange={(e) => setFooterText(e.target.value)}
                maxLength={MAX_FIELD_LEN}
                rows={2}
                placeholder="Terima kasih! 💛"
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className="text-xs text-muted-foreground">
                {footerText.length}/{MAX_FIELD_LEN}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Logo</Label>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || !uploadKey}
                  type="button"
                >
                  {uploading ? "Uploading…" : logoStorageId ? "Replace logo" : "Upload logo"}
                </Button>
                <p className="text-xs text-muted-foreground">PNG/JPG, &lt; 1 MB</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickLogo(f);
                }}
              />
            </div>

            <div className="flex justify-end pt-2">
              <Button onClick={onSave} disabled={saving || !saveKey}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </Card>

          {/* Live preview column — visual cues from convex/receipts/template.ts */}
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Live preview
            </p>
            <ReceiptPreview
              businessName={businessName}
              address={address}
              contact={contact}
              instagramHandle={instagramHandle}
              footerText={footerText}
              logoUrl={logoPreviewUrl}
            />
            <p className="text-xs text-muted-foreground">
              Preview only — the real receipt is rendered by the server with the
              transaction's line items.
            </p>
          </div>
        </div>
      </div>
    </SpokeLayout>
  );
}

// Compact header/footer preview mimicking convex/receipts/template.ts visual
// cues: centered, dashed separators, teal business name, Instagram footer.
// Intentionally NOT byte-identical to the server render — line items and totals
// belong to a real txn.
function ReceiptPreview({
  businessName,
  address,
  contact,
  instagramHandle,
  footerText,
  logoUrl,
}: {
  businessName: string;
  address: string;
  contact: string;
  instagramHandle: string;
  footerText: string;
  logoUrl: string | null;
}) {
  return (
    <div className="rounded-xl bg-gray-100 p-4">
      <div className="mx-auto max-w-[340px] rounded-xl bg-white p-5 shadow-sm">
        {/* Header */}
        <div className="border-b border-dashed border-gray-300 pb-3 text-center">
          <div className="mb-1 flex items-center justify-center gap-1.5 text-sm font-bold tracking-wide text-teal-700">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                className="inline-block h-8 align-middle"
              />
            ) : (
              <span>🍪</span>
            )}
            <span>{businessName || "Business name"}</span>
          </div>
          <div className="text-[11px] leading-snug text-gray-500">
            {address || "Address"}
            <br />
            {contact || "Contact"}
          </div>
        </div>

        {/* Status pill (static — preview only) */}
        <div className="my-3 rounded-md bg-emerald-100 py-1.5 text-center text-xs font-semibold text-emerald-800">
          LUNAS
        </div>

        {/* Stand-in body — keeps the proportions believable without faking a real txn */}
        <div className="border-t border-dashed border-gray-300 pt-2 text-[12px] text-gray-400">
          <div className="flex justify-between">
            <span>(line items)</span>
            <span>—</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span>(totals)</span>
            <span>—</span>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-3 border-t border-dashed border-gray-300 pt-3 text-center text-[11px] leading-relaxed text-gray-500">
          {footerText || "Footer text"}
          <br />
          <span className="text-[11px]">
            Follow us on Instagram! {instagramHandle || "@handle"}
          </span>
        </div>
      </div>
    </div>
  );
}

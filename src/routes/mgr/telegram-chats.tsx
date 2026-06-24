/**
 * /mgr/telegram-chats — manager-gated Telegram chat registry admin
 *
 * Ported from convex-telegram-bot-starter TelegramChatsManager.tsx (~307 lines)
 * and rewired to Frollie's manager-session API surface:
 *   - adminKey   → sessionId  (manager session from useSession())
 *   - admin*     → mgr*       (chatRegistry mgr* twins)
 *   - Inline row feedback → sonner toast
 *   - Founders summary toggle added (not in starter)
 *
 * v2.0 Spec-4 Task 10: outlet picker + grouped list.
 *   - Outlet-scoped roles (managers/inventory) require a two-step select: role → outlet.
 *   - Business roles (owners/ops) assign immediately (no outlet).
 *   - Chat list is grouped by outlet (section header = outlet name; "Business-wide" for none).
 */

import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { KNOWN_TELEGRAM_ROLES, ROLE_SCOPE } from "../../../convex/telegram/config";
import { useSession } from "@/hooks/useSession";
import { useT, type TranslationKey } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { errorMessage } from "@/lib/errors";
import { toast } from "sonner";
import type { Doc, Id } from "../../../convex/_generated/dataModel";

type Chat = Doc<"telegramChats">;

type OutletRow = { _id: Id<"outlets">; code: string; name: string; active: boolean };

const NONE_VALUE = "__none__";
const DAY_MS = 24 * 60 * 60 * 1000;

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

type StatusKind = "archived" | "error" | "active" | "dormant";

function deriveStatus(chat: Chat): { kind: StatusKind; labelKey: TranslationKey; title?: string } {
  if (chat.archivedAt !== undefined) {
    return { kind: "archived", labelKey: "mgrTelegram.statusArchived" };
  }
  if (chat.lastError && Date.now() - chat.lastError.at < DAY_MS) {
    return { kind: "error", labelKey: "mgrTelegram.statusError", title: chat.lastError.message };
  }
  if (chat.role) {
    return { kind: "active", labelKey: "mgrTelegram.statusActive" };
  }
  return { kind: "dormant", labelKey: "mgrTelegram.statusDormant" };
}

const STATUS_VARIANT: Record<StatusKind, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  dormant: "secondary",
  archived: "outline",
  error: "destructive",
};

// ─── Founders summary toggle ──────────────────────────────────────────────────

function FoundersSummaryToggle({ sessionId }: { sessionId: string }) {
  const settings = useQuery(api.settings.public.getSettings, {});
  const setEnabled = useMutation(api.settings.public.setFoundersSummaryEnabled);
  const [busy, setBusy] = useState(false);
  const t = useT();

  const enabled = settings?.founders_summary_enabled ?? true;

  async function handleToggle(next: boolean) {
    setBusy(true);
    try {
      await setEnabled({
        idempotencyKey: crypto.randomUUID(),
        sessionId: sessionId as Doc<"staff_sessions">["_id"],
        enabled: next,
      });
      toast.success(next ? t("mgrTelegram.foundersSummaryEnabled") : t("mgrTelegram.foundersSummaryDisabled"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-md border p-3">
      <Switch
        id="founders-summary-toggle"
        checked={enabled}
        onCheckedChange={handleToggle}
        disabled={busy || settings === undefined}
        aria-label={t("mgrTelegram.ariaFoundersToggle")}
      />
      <Label htmlFor="founders-summary-toggle" className="cursor-pointer text-sm">
        {t("mgrTelegram.foundersSummaryLabel")}
        <span className="ml-1 text-xs text-muted-foreground">{t("mgrTelegram.foundersChannel")}</span>
      </Label>
    </div>
  );
}

// ─── Sales ticker toggle ──────────────────────────────────────────────────────

function TxnTickerToggle({ sessionId }: { sessionId: string }) {
  const settings = useQuery(api.settings.public.getSettings, {});
  const setEnabled = useMutation(api.settings.public.setTxnTickerEnabled);
  const [busy, setBusy] = useState(false);
  const t = useT();

  const enabled = settings?.txn_ticker_enabled ?? true;

  async function handleToggle(next: boolean) {
    setBusy(true);
    try {
      await setEnabled({
        idempotencyKey: crypto.randomUUID(),
        sessionId: sessionId as Doc<"staff_sessions">["_id"],
        enabled: next,
      });
      toast.success(next ? t("mgrTelegram.tickerEnabled") : t("mgrTelegram.tickerDisabled"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-md border p-3">
      <Switch
        id="txn-ticker-toggle"
        checked={enabled}
        onCheckedChange={handleToggle}
        disabled={busy || settings === undefined}
        aria-label={t("mgrTelegram.ariaTickerToggle")}
      />
      <Label htmlFor="txn-ticker-toggle" className="cursor-pointer text-sm">
        {t("mgrTelegram.tickerLabel")}
        <span className="ml-1 text-xs text-muted-foreground">{t("mgrTelegram.tickerSilent")}</span>
      </Label>
    </div>
  );
}

// ─── Per-chat card ─────────────────────────────────────────────────────────────

function ChatCard({
  chat,
  sessionId,
  outlets,
}: {
  chat: Chat;
  sessionId: string;
  outlets: OutletRow[] | undefined;
}) {
  const assignRole = useMutation(api.telegram.chatRegistry.public.mgrAssignRole);
  const archiveChat = useMutation(api.telegram.chatRegistry.public.mgrArchiveChat);
  const restoreChat = useMutation(api.telegram.chatRegistry.public.mgrRestoreChat);
  const sendTest = useAction(api.telegram.chatRegistry.public.mgrSendTest);
  const t = useT();

  const [busy, setBusy] = useState(false);
  // pendingRole is set when an outlet-scoped role has been picked but no outlet chosen yet.
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const archived = chat.archivedAt !== undefined;
  const status = deriveStatus(chat);

  // Resolve the outlet label for this chat card (shown in header if bound).
  const boundOutlet = chat.outlet_id
    ? (outlets ?? []).find((o) => o._id === chat.outlet_id)
    : undefined;

  // ---- role select ----

  async function doAssignRole(
    role: string | null,
    outletId?: Id<"outlets">,
    overrides?: { forceReassign?: boolean; restoreIfArchived?: boolean },
  ) {
    setBusy(true);
    try {
      await assignRole({
        idempotencyKey: crypto.randomUUID(),
        sessionId: sessionId as Doc<"staff_sessions">["_id"],
        chatId: chat.chatId,
        role,
        ...(outletId ? { outletId } : {}),
        ...overrides,
      });
      toast.success(role ? t("mgrTelegram.roleSet", { role }) : t("mgrTelegram.roleCleared"));
      setPendingRole(null);
    } catch (err) {
      const msg = errorMessage(err);
      // role already held by another chat
      if (msg.toLowerCase().includes("already held")) {
        const confirmed = window.confirm(t("mgrTelegram.confirmReassign"));
        if (confirmed) {
          try {
            await assignRole({
              idempotencyKey: crypto.randomUUID(),
              sessionId: sessionId as Doc<"staff_sessions">["_id"],
              chatId: chat.chatId,
              role,
              ...(outletId ? { outletId } : {}),
              forceReassign: true,
            });
            toast.success(t("mgrTelegram.roleReassigned", { role: role ?? "" }));
            setPendingRole(null);
          } catch (err2) {
            toast.error(errorMessage(err2));
          }
        }
      } else if (msg.toLowerCase().includes("archived")) {
        const confirmed = window.confirm(t("mgrTelegram.confirmRestoreAndAssign"));
        if (confirmed) {
          try {
            await assignRole({
              idempotencyKey: crypto.randomUUID(),
              sessionId: sessionId as Doc<"staff_sessions">["_id"],
              chatId: chat.chatId,
              role,
              ...(outletId ? { outletId } : {}),
              restoreIfArchived: true,
            });
            toast.success(t("mgrTelegram.roleRestoredAssigned", { role: role ?? "" }));
            setPendingRole(null);
          } catch (err2) {
            toast.error(errorMessage(err2));
          }
        }
      } else {
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  function handleRoleChange(value: string) {
    const role = value === NONE_VALUE ? null : value;

    if (role === null) {
      // Clearing — assign immediately, hide picker
      setPendingRole(null);
      void doAssignRole(null);
      return;
    }

    const scope = ROLE_SCOPE[role as keyof typeof ROLE_SCOPE] ?? "business";
    if (scope === "outlet") {
      // Two-step: show outlet picker, don't assign yet
      setPendingRole(role);
    } else {
      // Business role — assign immediately
      setPendingRole(null);
      void doAssignRole(role);
    }
  }

  function handleOutletChange(outletId: string) {
    if (!pendingRole) return;
    void doAssignRole(pendingRole, outletId as Id<"outlets">);
  }

  // ---- archive / restore ----

  async function handleArchive() {
    if (!window.confirm(t("mgrTelegram.confirmArchive"))) return;
    setBusy(true);
    try {
      await archiveChat({
        idempotencyKey: crypto.randomUUID(),
        sessionId: sessionId as Doc<"staff_sessions">["_id"],
        chatId: chat.chatId,
      });
      toast.success(t("mgrTelegram.chatArchived"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!window.confirm(t("mgrTelegram.confirmRestore"))) return;
    setBusy(true);
    try {
      await restoreChat({
        idempotencyKey: crypto.randomUUID(),
        sessionId: sessionId as Doc<"staff_sessions">["_id"],
        chatId: chat.chatId,
      });
      toast.success(t("mgrTelegram.chatRestored"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // ---- send test ----

  async function handleSendTest() {
    setBusy(true);
    try {
      await sendTest({
        sessionId: sessionId as Doc<"staff_sessions">["_id"],
        chatId: chat.chatId,
      });
      toast.success(t("mgrTelegram.testSent"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // The current role value for the select: if a pendingRole is in-flight show it,
  // else show the chat's committed role.
  const roleSelectValue = pendingRole ?? chat.role ?? NONE_VALUE;

  return (
    <Card className={`p-4 space-y-3 ${archived ? "opacity-60" : ""}`}>
      {/* header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight truncate">{chat.title}</p>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">{chat.chatId}</p>
          {boundOutlet && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("mgrTelegram.boundOutletLabel", { name: boundOutlet.name })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="outline" className="text-[10px]">{chat.chatType}</Badge>
          <Badge variant={STATUS_VARIANT[status.kind]} title={status.title} className="text-[10px]">
            {t(status.labelKey)}
          </Badge>
        </div>
      </div>

      {/* meta row */}
      <p className="text-xs text-muted-foreground">
        {t("mgrTelegram.lastSeen")}{" "}
        <span title={new Date(chat.lastSeenAt).toLocaleString()}>
          {relativeTime(chat.lastSeenAt)}
        </span>
        {archived && chat.archivedAt && (
          <> · {t("mgrTelegram.archivedAt")} {relativeTime(chat.archivedAt)}</>
        )}
      </p>

      {/* role select */}
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground shrink-0">{t("mgrTelegram.labelRole")}</Label>
        <Select
          value={roleSelectValue}
          onValueChange={handleRoleChange}
          disabled={busy}
        >
          <SelectTrigger className="h-8 text-xs flex-1" aria-label={t("mgrTelegram.ariaRoleSelect")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>{t("mgrTelegram.unassigned")}</SelectItem>
            {KNOWN_TELEGRAM_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
            {/* preserve out-of-allowlist role so it shows rather than silently reverting */}
            {chat.role &&
              !(KNOWN_TELEGRAM_ROLES as readonly string[]).includes(chat.role) && (
                <SelectItem value={chat.role}>{t("mgrTelegram.roleUnknown", { role: chat.role })}</SelectItem>
              )}
          </SelectContent>
        </Select>
      </div>

      {/* outlet picker — only shown when an outlet-scoped role is pending */}
      {pendingRole !== null && (
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground shrink-0">{t("mgrTelegram.labelOutlet")}</Label>
          <Select
            onValueChange={handleOutletChange}
            disabled={busy || outlets === undefined}
          >
            <SelectTrigger className="h-8 text-xs flex-1" aria-label={t("mgrTelegram.ariaOutletSelect")}>
              <SelectValue placeholder={t("mgrTelegram.outletPickerPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {(outlets ?? []).map((o) => (
                <SelectItem key={o._id} value={o._id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* action buttons */}
      <div className="flex gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={handleSendTest}
          disabled={busy}
          className="text-xs"
        >
          {t("mgrTelegram.sendTest")}
        </Button>
        {archived ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRestore}
            disabled={busy}
            className="text-xs"
          >
            {t("mgrTelegram.restore")}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={handleArchive}
            disabled={busy}
            className="text-xs"
          >
            {t("mgrTelegram.archive")}
          </Button>
        )}
      </div>
    </Card>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function MgrTelegramChats() {
  const navigate = useNavigate();
  const session = useSession();
  const t = useT();

  const [includeArchived, setIncludeArchived] = useState(false);

  // Manager guard — matches existing mgr-only pattern in home.tsx
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

  return (
    <MgrTelegramChatsInner
      sessionId={session.sessionId as string}
      includeArchived={includeArchived}
      setIncludeArchived={setIncludeArchived}
    />
  );
}

function MgrTelegramChatsInner({
  sessionId,
  includeArchived,
  setIncludeArchived,
}: {
  sessionId: string;
  includeArchived: boolean;
  setIncludeArchived: (v: boolean) => void;
}) {
  const t = useT();
  const chats = useQuery(api.telegram.chatRegistry.public.mgrListChats, {
    sessionId: sessionId as Doc<"staff_sessions">["_id"],
    includeArchived,
  });
  const outlets = useQuery(api.outlets.public.listOutlets, {
    sessionId: sessionId as Doc<"staff_sessions">["_id"],
  });

  // ── Group chats by outlet_id ──────────────────────────────────────────────
  // Groups: one section per outlet (ordered by first appearance) + "Business-wide"
  // for chats without an outlet_id.
  function groupChats(chatList: Chat[], outletList: OutletRow[] | undefined) {
    type Group = { outletId: Id<"outlets"> | null; label: string; chats: Chat[] };
    const outletMap = new Map<string, OutletRow>(
      (outletList ?? []).map((o) => [o._id, o]),
    );

    const businessWide: Chat[] = [];
    const byOutlet = new Map<string, { outlet: OutletRow; chats: Chat[] }>();
    const outletOrder: string[] = [];

    for (const chat of chatList) {
      if (!chat.outlet_id) {
        businessWide.push(chat);
      } else {
        const key = chat.outlet_id;
        if (!byOutlet.has(key)) {
          const outlet = outletMap.get(key) ?? {
            _id: key as Id<"outlets">,
            code: key,
            name: key,
            active: true,
          };
          byOutlet.set(key, { outlet, chats: [] });
          outletOrder.push(key);
        }
        byOutlet.get(key)!.chats.push(chat);
      }
    }

    const groups: Group[] = outletOrder.map((key) => {
      const entry = byOutlet.get(key)!;
      return { outletId: entry.outlet._id, label: entry.outlet.name, chats: entry.chats };
    });

    if (businessWide.length > 0) {
      groups.push({ outletId: null, label: t("mgrTelegram.sectionBusinessWide"), chats: businessWide });
    }

    return groups;
  }

  return (
    <SpokeLayout title={t("mgrTelegram.title")}>
      <div className="flex flex-1 flex-col gap-4 p-4">
      {/* founders summary toggle */}
      <FoundersSummaryToggle sessionId={sessionId} />
      <TxnTickerToggle sessionId={sessionId} />

      <Separator />

      {/* show-archived toggle */}
      <div className="flex items-center gap-2">
        <Switch
          id="show-archived"
          checked={includeArchived}
          onCheckedChange={setIncludeArchived}
        />
        <Label htmlFor="show-archived" className="text-xs cursor-pointer">
          {t("mgrTelegram.showArchived")}
        </Label>
      </div>

      {/* chat list */}
      {chats === undefined ? (
        <p className="text-sm text-muted-foreground py-4 text-center">{t("mgrTelegram.loadingChats")}</p>
      ) : chats.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center space-y-1">
          <p className="text-sm text-muted-foreground">{t("mgrTelegram.noChats")}</p>
          <p className="text-xs text-muted-foreground">
            {t("mgrTelegram.noChatsHint")}{" "}
            <code className="text-xs bg-muted px-1 rounded">{"/register"}</code> {t("mgrTelegram.noChatsHintSuffix")}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groupChats(chats, outlets).map((group) => (
            <div key={group.outletId ?? "__business__"} className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {group.label}
              </p>
              {group.chats.map((chat) => (
                <ChatCard key={chat._id} chat={chat} sessionId={sessionId} outlets={outlets} />
              ))}
            </div>
          ))}
        </div>
      )}
      </div>
    </SpokeLayout>
  );
}

/**
 * /mgr/telegram-chats — manager-gated Telegram chat registry admin
 *
 * Ported from convex-telegram-bot-starter TelegramChatsManager.tsx (~307 lines)
 * and rewired to Frollie's manager-session API surface:
 *   - adminKey   → sessionId  (manager session from useSession())
 *   - admin*     → mgr*       (chatRegistry mgr* twins)
 *   - Inline row feedback → sonner toast
 *   - Founders summary toggle added (not in starter)
 */

import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { KNOWN_TELEGRAM_ROLES } from "../../../convex/telegram/config";
import { useSession } from "@/hooks/useSession";
import { useT } from "@/lib/i18n";
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
import type { Doc } from "../../../convex/_generated/dataModel";

type Chat = Doc<"telegramChats">;

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

function deriveStatus(chat: Chat): { kind: StatusKind; label: string; title?: string } {
  if (chat.archivedAt !== undefined) {
    return { kind: "archived", label: "Archived" };
  }
  if (chat.lastError && Date.now() - chat.lastError.at < DAY_MS) {
    return { kind: "error", label: "Error", title: chat.lastError.message };
  }
  if (chat.role) {
    return { kind: "active", label: "Active" };
  }
  return { kind: "dormant", label: "Dormant" };
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
}: {
  chat: Chat;
  sessionId: string;
}) {
  const assignRole = useMutation(api.telegram.chatRegistry.public.mgrAssignRole);
  const archiveChat = useMutation(api.telegram.chatRegistry.public.mgrArchiveChat);
  const restoreChat = useMutation(api.telegram.chatRegistry.public.mgrRestoreChat);
  const sendTest = useAction(api.telegram.chatRegistry.public.mgrSendTest);
  const t = useT();

  const [busy, setBusy] = useState(false);
  const archived = chat.archivedAt !== undefined;
  const status = deriveStatus(chat);

  // ---- role select ----

  async function handleRoleChange(value: string) {
    const role = value === NONE_VALUE ? null : value;
    setBusy(true);
    try {
      await assignRole({
        idempotencyKey: crypto.randomUUID(),
        sessionId: sessionId as Doc<"staff_sessions">["_id"],
        chatId: chat.chatId,
        role,
      });
      toast.success(role ? t("mgrTelegram.roleSet", { role }) : t("mgrTelegram.roleCleared"));
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
              forceReassign: true,
            });
            toast.success(t("mgrTelegram.roleReassigned", { role: role ?? "" }));
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
              restoreIfArchived: true,
            });
            toast.success(t("mgrTelegram.roleRestoredAssigned", { role: role ?? "" }));
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

  return (
    <Card className={`p-4 space-y-3 ${archived ? "opacity-60" : ""}`}>
      {/* header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight truncate">{chat.title}</p>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">{chat.chatId}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="outline" className="text-[10px]">{chat.chatType}</Badge>
          <Badge variant={STATUS_VARIANT[status.kind]} title={status.title} className="text-[10px]">
            {status.label}
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
          value={chat.role ?? NONE_VALUE}
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
        <div className="space-y-3">
          {chats.map((chat) => (
            <ChatCard key={chat._id} chat={chat} sessionId={sessionId} />
          ))}
        </div>
      )}
      </div>
    </SpokeLayout>
  );
}

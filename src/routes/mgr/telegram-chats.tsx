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
import { ConvexError } from "convex/values";
import { api } from "../../../convex/_generated/api";
import { KNOWN_TELEGRAM_ROLES } from "../../../convex/telegram/config";
import { useSession } from "@/hooks/useSession";
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
import { toast } from "sonner";
import type { Doc } from "../../../convex/_generated/dataModel";

type Chat = Doc<"telegramChats">;

const NONE_VALUE = "__none__";
const DAY_MS = 24 * 60 * 60 * 1000;

function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    return typeof err.data === "string" ? err.data : String(err.data);
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

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

  const enabled = settings?.founders_summary_enabled ?? true;

  async function handleToggle(next: boolean) {
    setBusy(true);
    try {
      await setEnabled({
        idempotencyKey: crypto.randomUUID(),
        sessionId: sessionId as Doc<"staff_sessions">["_id"],
        enabled: next,
      });
      toast.success(next ? "Founders summary enabled" : "Founders summary disabled");
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
        aria-label="founders summary toggle"
      />
      <Label htmlFor="founders-summary-toggle" className="cursor-pointer text-sm">
        Auto-send the daily summary at 22:00 WIB
        <span className="ml-1 text-xs text-muted-foreground">(Founders channel)</span>
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
  const assignRole = useMutation(api.telegram.chatRegistry.mgrAssignRole);
  const archiveChat = useMutation(api.telegram.chatRegistry.mgrArchiveChat);
  const restoreChat = useMutation(api.telegram.chatRegistry.mgrRestoreChat);
  const sendTest = useAction(api.telegram.chatRegistry.mgrSendTest);

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
      toast.success(role ? `Role set to "${role}"` : "Role cleared");
    } catch (err) {
      const msg = errorMessage(err);
      // role already held by another chat
      if (msg.toLowerCase().includes("already held")) {
        const confirmed = window.confirm("Reassign role from the other chat?");
        if (confirmed) {
          try {
            await assignRole({
              idempotencyKey: crypto.randomUUID(),
              sessionId: sessionId as Doc<"staff_sessions">["_id"],
              chatId: chat.chatId,
              role,
              forceReassign: true,
            });
            toast.success(`Reassigned role "${role}"`);
          } catch (err2) {
            toast.error(errorMessage(err2));
          }
        }
      } else if (msg.toLowerCase().includes("archived")) {
        const confirmed = window.confirm("Restore this chat and assign the role?");
        if (confirmed) {
          try {
            await assignRole({
              idempotencyKey: crypto.randomUUID(),
              sessionId: sessionId as Doc<"staff_sessions">["_id"],
              chatId: chat.chatId,
              role,
              restoreIfArchived: true,
            });
            toast.success(`Restored and assigned role "${role}"`);
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
    if (!window.confirm("Archive this chat? It will stop receiving messages.")) return;
    setBusy(true);
    try {
      await archiveChat({
        idempotencyKey: crypto.randomUUID(),
        sessionId: sessionId as Doc<"staff_sessions">["_id"],
        chatId: chat.chatId,
      });
      toast.success("Chat archived");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!window.confirm("Restore this chat?")) return;
    setBusy(true);
    try {
      await restoreChat({
        idempotencyKey: crypto.randomUUID(),
        sessionId: sessionId as Doc<"staff_sessions">["_id"],
        chatId: chat.chatId,
      });
      toast.success("Chat restored");
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
      toast.success("Test message sent");
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
        Last seen{" "}
        <span title={new Date(chat.lastSeenAt).toLocaleString()}>
          {relativeTime(chat.lastSeenAt)}
        </span>
        {archived && chat.archivedAt && (
          <> · Archived {relativeTime(chat.archivedAt)}</>
        )}
      </p>

      {/* role select */}
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground shrink-0">Role</Label>
        <Select
          value={chat.role ?? NONE_VALUE}
          onValueChange={handleRoleChange}
          disabled={busy}
        >
          <SelectTrigger className="h-8 text-xs flex-1" aria-label="role select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>Unassigned</SelectItem>
            {KNOWN_TELEGRAM_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
            {/* preserve out-of-allowlist role so it shows rather than silently reverting */}
            {chat.role &&
              !(KNOWN_TELEGRAM_ROLES as readonly string[]).includes(chat.role) && (
                <SelectItem value={chat.role}>{chat.role} (unknown)</SelectItem>
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
          Send test
        </Button>
        {archived ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRestore}
            disabled={busy}
            className="text-xs"
          >
            Restore
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={handleArchive}
            disabled={busy}
            className="text-xs"
          >
            Archive
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

  const [includeArchived, setIncludeArchived] = useState(false);

  // Manager guard — matches existing mgr-only pattern in home.tsx
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
  const navigate = useNavigate();

  const chats = useQuery(api.telegram.chatRegistry.mgrListChats, {
    sessionId: sessionId as Doc<"staff_sessions">["_id"],
    includeArchived,
  });

  return (
    <main className="flex flex-1 flex-col gap-4 p-4">
      {/* page header */}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold leading-tight">Telegram chats</h1>
          <p className="text-xs text-muted-foreground">Manage bot registrations and roles</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          ← Back
        </Button>
      </header>

      {/* founders summary toggle */}
      <FoundersSummaryToggle sessionId={sessionId} />

      <Separator />

      {/* show-archived toggle */}
      <div className="flex items-center gap-2">
        <Switch
          id="show-archived"
          checked={includeArchived}
          onCheckedChange={setIncludeArchived}
        />
        <Label htmlFor="show-archived" className="text-xs cursor-pointer">
          Show archived
        </Label>
      </div>

      {/* chat list */}
      {chats === undefined ? (
        <p className="text-sm text-muted-foreground py-4 text-center">Loading chats…</p>
      ) : chats.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center space-y-1">
          <p className="text-sm text-muted-foreground">No registered Telegram chats yet</p>
          <p className="text-xs text-muted-foreground">
            Invite the bot to a group and send{" "}
            <code className="text-xs bg-muted px-1 rounded">/register</code> from the chat
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {chats.map((chat) => (
            <ChatCard key={chat._id} chat={chat} sessionId={sessionId} />
          ))}
        </div>
      )}
    </main>
  );
}

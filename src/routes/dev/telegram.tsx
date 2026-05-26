import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import * as Tabs from "@radix-ui/react-tabs";
import { api } from "../../../convex/_generated/api";

// Three template tabs that mirror the spec's
// docs/superpowers/specs/2026-05-25-telegram-poc-design.md
// Approval | Shift summary | Custom.

export default function TelegramPocPage() {
  const send = useAction(api.telegram.send.sendTemplate);
  const log = useQuery(api.telegram.queries.listRecentLog) ?? [];

  return (
    <div className="mx-auto max-w-2xl p-4 space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Telegram POC playground</h1>
        <p className="text-sm text-muted-foreground">
          Sends to the dev Telegram group via the bot. Activity feed updates live.
        </p>
      </header>

      <Tabs.Root defaultValue="approval" className="border rounded-lg p-3">
        <Tabs.List className="flex gap-2 border-b mb-3 pb-2">
          <Tabs.Trigger
            value="approval"
            className="px-3 py-1 rounded data-[state=active]:bg-stone-200 data-[state=active]:font-medium"
          >
            Approval
          </Tabs.Trigger>
          <Tabs.Trigger
            value="shift_summary"
            className="px-3 py-1 rounded data-[state=active]:bg-stone-200 data-[state=active]:font-medium"
          >
            Shift summary
          </Tabs.Trigger>
          <Tabs.Trigger
            value="custom"
            className="px-3 py-1 rounded data-[state=active]:bg-stone-200 data-[state=active]:font-medium"
          >
            Custom
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="approval">
          <ApprovalForm send={send} />
        </Tabs.Content>
        <Tabs.Content value="shift_summary">
          <ShiftSummaryForm send={send} />
        </Tabs.Content>
        <Tabs.Content value="custom">
          <CustomForm send={send} />
        </Tabs.Content>
      </Tabs.Root>

      <section className="border rounded-lg p-3">
        <h2 className="text-sm font-medium mb-2">Activity ({log.length})</h2>
        <ul className="space-y-1.5 text-xs font-mono">
          {log.map((row) => (
            <li
              key={row._id}
              className={`p-2 rounded border ${
                row.direction === "in"
                  ? "border-purple-300 bg-purple-50"
                  : "border-emerald-300 bg-emerald-50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                    row.direction === "in"
                      ? "bg-purple-200 text-purple-900"
                      : "bg-emerald-200 text-emerald-900"
                  }`}
                >
                  {row.direction.toUpperCase()}
                </span>
                <span>{new Date(row.created_at).toLocaleTimeString()}</span>
                {row.template_kind && <span>· {row.template_kind}</span>}
                {row.from_user && <span>· {row.from_user}</span>}
              </div>
              {row.callback_data && (
                <div className="mt-1 text-purple-900">{row.callback_data}</div>
              )}
              <div className="mt-1 text-stone-600 truncate">{row.payload_json.slice(0, 120)}</div>
            </li>
          ))}
          {log.length === 0 && (
            <li className="text-stone-500 italic">No activity yet — hit Send above.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

type SendFn = ReturnType<typeof useAction<typeof api.telegram.send.sendTemplate>>;

function ApprovalForm({ send }: { send: SendFn }) {
  const [actionType, setActionType] = useState<"refund" | "manual_pay" | "neg_stock">("refund");
  const [amount, setAmount] = useState("50000");
  const [reason, setReason] = useState("customer says cookie was stale");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await send({
            kind: "approval",
            payload: {
              action_type: actionType,
              amount_idr: Number(amount),
              reason,
            },
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block text-sm">
        Action type
        <select
          className="block w-full mt-1 border rounded px-2 py-1"
          value={actionType}
          onChange={(e) => setActionType(e.target.value as typeof actionType)}
        >
          <option value="refund">Refund</option>
          <option value="manual_pay">Manual payment override</option>
          <option value="neg_stock">Negative stock</option>
        </select>
      </label>
      <label className="block text-sm">
        Amount (IDR)
        <input
          type="number"
          className="block w-full mt-1 border rounded px-2 py-1 font-mono"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Reason
        <textarea
          className="block w-full mt-1 border rounded px-2 py-1"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send approval request"}
      </button>
    </form>
  );
}

function ShiftSummaryForm({ send }: { send: SendFn }) {
  const [staffName, setStaffName] = useState("Citra");
  const [sales, setSales] = useState("4275000");
  const [txns, setTxns] = useState("42");
  const [hours, setHours] = useState("8");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await send({
            kind: "shift_summary",
            payload: {
              staff_name: staffName,
              sales_idr: Number(sales),
              txn_count: Number(txns),
              hours: Number(hours),
            },
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block text-sm">
        Staff name
        <input
          className="block w-full mt-1 border rounded px-2 py-1"
          value={staffName}
          onChange={(e) => setStaffName(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Sales (IDR)
        <input
          type="number"
          className="block w-full mt-1 border rounded px-2 py-1 font-mono"
          value={sales}
          onChange={(e) => setSales(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Txn count
        <input
          type="number"
          className="block w-full mt-1 border rounded px-2 py-1 font-mono"
          value={txns}
          onChange={(e) => setTxns(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Hours
        <input
          type="number"
          step="0.5"
          className="block w-full mt-1 border rounded px-2 py-1 font-mono"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send shift summary"}
      </button>
    </form>
  );
}

function CustomForm({ send }: { send: SendFn }) {
  const [text, setText] = useState("hello from the playground");
  const [includeButtons, setIncludeButtons] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await send({
            kind: "custom",
            payload: { text, include_buttons: includeButtons },
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block text-sm">
        Message
        <textarea
          className="block w-full mt-1 border rounded px-2 py-1"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeButtons}
          onChange={(e) => setIncludeButtons(e.target.checked)}
        />
        Include Test A / Test B buttons
      </label>
      <button
        type="submit"
        disabled={busy}
        className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send custom message"}
      </button>
    </form>
  );
}

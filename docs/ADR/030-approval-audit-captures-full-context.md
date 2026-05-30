# 030. Approval audit captures full context

**Date:** 2026-05-21
**Status:** Accepted
**Group:** WA

## Context

Disputes happen — "who approved that refund?", "why was the manual-confirm marked OK?", "show me the chain of events for sale #057". Without rich audit data, reconstructing the why becomes guesswork from chat scrollback.

## Decision

On `approvals.approve` (server-side execution), write one `audit_log` row with full context:

```
{
  actor_id: <manager who approved>,
  action: <"refund.approved" | "payment.confirmed_manual_override" | ...>,
  entity_type: <"refund" | "payment" | ...>,
  entity_id: <id of the affected entity>,
  before_state: <JSON snapshot before change>,
  after_state: <JSON snapshot after change>,
  reason: <reason text from the request>,
  device_id: <where the action actually executed>,
  source: "wa_approval",
  metadata: { approval_request_id, token_consumed_at }
}
```

Linked back to the approval request via `pos_approval_requests.audit_log_id`.

## Alternatives considered

- **Just log "approved by X at Y" with no payload.** Rejected: dispute resolution requires before/after state, not just attribution.
- **Log the full request payload but no diff.** Rejected: harder to read at a glance ("what changed?"). Before/after is the question disputes ask.

## Consequences

- *Easier:* "show me everything Lucas approved this week" → audit_log filter on `(actor_id = lucas, source = wa_approval)`. "Show me the full history of refund X" → audit_log filter on `(entity_id = refund_x)`.
- *Audit cost:* one extra row per approval. Negligible at expected volumes.
- *Schema:* `pos_approval_requests { id, kind, requester_staff_id, entity_id, payload, reason_provided, status (pending|approved|denied|expired|cancelled), decided_by_mgr_id?, decided_at?, audit_log_id? }`.
- *Source field:* `audit_log.source` enum gains `"wa_approval"`, `"booth_inline"`, `"system"` to distinguish the routing path of any sensitive action.

---

## Amendment 2026-05-30 — v0.4 generalization

The original decision was filed in v0.3 when the only approval kind was `staff_pin_reset`. v0.4 added `manual_payment_override` and generalized the schema. This amendment records what changed and what the original decision got right.

### Schema changes (additive)

`pos_approval_requests` is unchanged in spirit but extended:

```
pos_approval_requests {
  kind: "staff_pin_reset" | "manual_payment_override"   // v0.4 adds manual_payment_override

  // WHO asked (pin_reset is system-triggered → optional)
  requester_staff_id?: Id<"staff">                       // NEW in v0.4

  // WHAT is approved — generic entity pointer
  entity_type?: string                                   // NEW in v0.4
  entity_id?: string                                     // NEW in v0.4
  subject_staff_id?: Id<"staff">                         // kept for pin_reset back-compat

  // per-kind context blob — validated by kinds.ts before insert
  context?: any                                          // NEW in v0.4 (v.any(); invariant enforced in app layer)
  reason?: string

  triggered_by_event: string
  triggered_at: number
  token_hash: string
  token_expires_at: number

  status: "pending" | "resolved" | "denied" | "expired" // "denied" NEW in v0.4
  notified_at?: number
  resolved_at?: number
  resolved_by_manager_id?: Id<"staff">
  denied_at?: number                                     // NEW in v0.4
  denied_by_manager_id?: Id<"staff">                     // NEW in v0.4
  deny_reason?: string                                   // NEW in v0.4

  // Telegram linkage (best-effort — patched after notify)
  notification_channel?: "telegram"                      // NEW in v0.4
  telegram_message_id?: number                           // NEW in v0.4
  telegram_chat_id?: string                              // NEW in v0.4
}
```

Indexes added in v0.4: `by_kind_status` (`[kind, status]`) for the non-staff-kind dedup guard.

### `APPROVAL_KINDS` registry (`convex/approvals/kinds.ts`)

The original decision assumed per-kind logic would be ad-hoc. v0.4 formalises a single registry:

- `ApprovalKind` — the union type (`"staff_pin_reset" | "manual_payment_override"`).
- `validateContext(kind, raw)` — validates and normalises the per-kind `context` blob before insert. Called exclusively by `_createRequest_internal` — the single writer — so no bypass path exists.
- `KIND_AUDIT` — maps kind → audit action strings (`"approval.created"`, `"approval.resolved"`, `"approval.denied"`).
- `KIND_TEMPLATE` — maps kind → Telegram template id (used by `sendTemplate` in `convex/telegram/send.ts`).

**Adding a new approval kind** requires editing `kinds.ts` plus the four touch-points in CLAUDE.md §"How to add a feature" #8. The registry is the single source of truth; no other file needs to enumerate kinds.

### Audit linkage — NO `audit_log_id` foreign key

The original decision proposed `pos_approval_requests.audit_log_id`. This field **was not shipped**. The linkage direction is reversed in the actual implementation:

- `audit_log.metadata` carries `{ approval_request_id }` for approval-related rows.
- The `by_entity` index on `audit_log` (`[entity_type, entity_id]`) covers "all audit rows for approval request X" queries.

This keeps `pos_approval_requests` as the write-path entity and `audit_log` as the append-only trail (ADR-007), without a forward foreign key that would couple the two tables.

### `denied` status

A manager can now explicitly deny an approval request (`_markDenied_internal`). The `denied` terminal status mirrors `resolved` but uses `denied_at` / `denied_by_manager_id` / `deny_reason` fields. The idempotency wrapper prevents double-denial from concurrent manager taps.

### Audit `source` field — additive change

`audit_log.source` gained `"telegram_approval"` as an **additive** literal in v0.4. `"wa_approval"` is **retained** in both the validator and the schema for historical rows — the schema never drops a union literal from a populated column (Convex requires a migration). No production code emits `"wa_approval"` post-v0.4; the canonical source for off-booth approval rows going forward is `"telegram_approval"`. See the ADR-035 amendment for the routing context.

### Superseded language in original Decision

The original Decision section references `"approved"` as a status value and `"audit_log_id"` as a field. Both are superseded by this amendment:
- Status `"approved"` → the shipped literal is `"resolved"` (consistent with the lifecycle language used elsewhere).
- `audit_log_id` field → not present on the schema; linkage is via `audit_log.metadata.approval_request_id` (see above).

### References

- [ADR-007](./007-audit-log-append-only.md) — audit log append-only; no `audit_log_id` FK on `pos_approval_requests`
- [ADR-029](./029-token-authorizes-view-pin-authorizes-act.md) — token-VIEW / PIN-ACT; unchanged
- [ADR-035](./035-telegram-as-internal-comms.md) — Telegram delivery channel; amendment records source literal change
- `convex/approvals/kinds.ts` — APPROVAL_KINDS registry
- `convex/approvals/schema.ts` — full schema including v0.4 fields
- `convex/approvals/internal.ts` — `_createRequest_internal` (single writer), `_markResolved_internal`, `_markDenied_internal`, `_linkTelegramMessage_internal`

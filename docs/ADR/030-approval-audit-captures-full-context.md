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

# 019. Refund re-credits stock

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Stock

## Context

When a customer returns a cookie within minutes of buying it ("wrong flavour, can I swap?"), the cookie typically goes back on the shelf. If the refund doesn't re-credit stock, the SKU count drifts low for no reason.

When the returned item is damaged or unfit ("the cookie broke in the bag"), it doesn't go back on the shelf — it's binned. We need to distinguish these.

## Decision

`pos_refunds.execute` writes **positive** `pos_stock_movements` rows, `source: "refund"`, mirroring the original sale's components. Default assumption: returned items go back on the shelf. If the physical item is actually damaged or binned, staff overrides with a separate Stock In movement of `source: "spoilage"` after the refund completes (two-step, but auditable and unambiguous).

## Alternatives considered

- **Refund doesn't touch stock; staff manually adjusts after.** Rejected: too easy to forget; stock drift accumulates.
- **Single refund flow with "binned / restocked" toggle.** Rejected: more UI complexity; the spoilage path is rare enough that the two-step is fine.

## Consequences

- *Easier:* default flow re-credits automatically. Stock stays accurate for the common case.
- *Harder:* spoilage handling requires the staff to follow up with a Stock In/spoilage row. Mitigation: refund success screen suggests "was the item damaged? log spoilage" as a one-tap shortcut.
- *Movement source enum:* see [ADR-020](./020-stock-movement-source-enum.md). `refund` source on a positive movement; `spoilage` source on a negative movement (manager-PIN-gated).
- *Audit:* refund row + stock movement row both write to `audit_log`. Spoilage adds a third audit row, linked by `notes` field.

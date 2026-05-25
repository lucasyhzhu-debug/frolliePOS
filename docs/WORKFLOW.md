# Workflow

Development workflow for Frollie POS. Extends Frollie Pro's `docs/WORKFLOW.md`. Deviations documented below.

## Defer to Frollie Pro for

- Branching strategy
- Commit message conventions
- PR review process
- Convex deployment etiquette (production deploys, schema changes)
- TypeScript style (see `product_master/docs/CODE_STYLE.md`)

## POS-specific workflow notes

### Schema changes that touch shared tables

If a change to `convex/schema.ts` modifies a Frollie Pro table (`products`, `recipes`, etc.) or adds a cross-cutting table (`staff`, `audit_log`), the PR must be reviewed by the Frollie Pro maintainer in addition to the POS reviewer. Schema additions for `pos_*` tables only require POS review.

### Convex production deploys

The Convex deployment is shared with `product_master`. A POS deploy that breaks schema validation will break `product_master`. Before running `npx convex deploy`:

1. Confirm CI passed (typecheck, tests).
2. Verify with the Frollie Pro maintainer that no concurrent schema change is in flight.
3. Deploy during off-peak hours when feasible (mall closed, no active transactions).
4. Monitor the Convex dashboard for function errors for 15 minutes post-deploy.

### Adding a new audit action

Whenever you add a state-changing mutation:

1. Add the new action string to the enum in `convex/audit.ts` and `docs/SCHEMA.md`.
2. Call the `logAudit` helper from inside the mutation, in the same transaction.
3. If the action requires a `reason` field, validate it at the mutation boundary.
4. Set `source` correctly: `"booth_inline"` for direct manager-PIN approvals, `"wa_approval"` for actions executed via `approvals.approve`, `"system"` or `"reaper"` for scheduled cleanups.
5. Add a test that verifies the audit row is written.

### Adding a new approval-gated action

The v0.4+ pattern: when a mutation requires a manager PIN, it should:

1. Validate args + write any intermediate state (e.g. `pos_refunds` with `status: pending`).
2. Call `approvals.create_internal({ kind, requesterStaffId, entityId, payload, reason })` which returns `{ requestId, token, waShareUrl }`.
3. Return the `waShareUrl` to the client so the staff's device can open the wa.me share-intent.
4. The actual execution path lives in `approvals.approve` — it switches on `request.kind` and calls the right internal action (e.g. `refunds.executeAfterApproval_internal`).
5. The action being executed reads `mgr_approver_id` from the approval row when writing its audit log.

If you need a new approval `kind`, update the enum in `convex/approvals.ts`, the WA share-intent template in `src/lib/wa-link.ts`, and the landing-page rendering in `src/routes/approve/index.tsx`.

### Adding a new payment confirmation path

There are exactly three paths today (webhook, polling, manual-override-via-WA-approval). Adding a fourth requires an ADR. Adding more telemetry to existing paths does not.

### Working on offline behavior

The offline matrix ([ADR-025](./ADR/025-service-worker-cache.md), [ADR-026](./ADR/026-reconciliation-on-reload.md)) is the source of truth for what works without network. If your change affects this:

1. Update the matrix in the relevant ADR.
2. Verify behavior manually on a real Android device with WiFi toggled.
3. Add an e2e test that simulates offline via Playwright.

### Idempotency hygiene

Every new public mutation MUST:

1. Accept `idempotencyKey: v.string()` in its `args`.
2. Be wrapped by `withIdempotency()` from `convex/idempotency.ts` (the harness).
3. Generate a stable client-side key per *intent* (not per render); the `useIdempotency()` hook returns one tied to an intent identifier.

PR review rejects any new public mutation that omits `idempotencyKey`.

### Receipt template changes

The public receipt page (`/r/<receipt_token>`) is a customer-facing artifact. Changes need:

1. Visual review on a real Android phone via the mobile preview.
2. Confirmation that token-based URL still validates.
3. No new PII in the URL (token is opaque).
4. Compatibility with the receipt HTML cache invalidation (24h TTL, regenerated on access).

### Device registration

To test device registration locally:

```bash
# Generate a setup code from the manager dashboard (logged in as manager)
# OR via convex CLI:
npx convex run staff:generateDeviceSetupCode '{ }'
```

The code is single-use and expires after 1 hour. After activation, the device row appears in `registered_devices`.

### Testing payments locally

Xendit test mode:

```bash
# Use Xendit test keys in .env.local
XENDIT_SECRET_KEY=xnd_development_...
```

Xendit's test mode has a "simulate payment" button in their dashboard for any test invoice. Webhook will fire to your local Convex dev URL — Convex prints a stable HTTP URL on `npx convex dev` startup; configure it in Xendit's test webhook settings.

Polling fallback can be tested by configuring Xendit to delay webhook delivery (test mode has a delay slider).

Manual-override path is testable without Xendit at all: tap "Customer paid but not showing?" after 60s; this opens the WA share-intent — copy the URL it would open and paste it in another browser tab to simulate a manager opening the approval landing.

### Testing WA approvals locally

You don't actually need WhatsApp to test the approval flow:

1. Trigger a refund (or other approval-gated action) as staff.
2. The staff device shows the "Waiting on manager" screen with the `frollie.id/approve/<token>` URL in the activity log.
3. Open that URL in another tab (or another device) — this simulates a manager tapping the WA link.
4. Approve with the manager PIN.
5. Verify the action completes on the staff device + the audit row is written with `source: "wa_approval"`.

### Releases

- **v0.1**: documentation only (initial bundle, superseded by v0.2-baseline)
- **v0.2-baseline**: GitHub initial commit — cleaned docs (33 ADRs + strategic foundations), scaffolding (Vite/TS/Tailwind/shadcn/Convex/router stubs), `.gitignore`. No backend yet.
- **v0.2**: auth + catalog (PIN login, HomeNav, products query)
- **v0.3**: sale flow + QRIS + BCA VA + webhook + idempotency harness
- **v0.4**: polling + manual override + audit log + WA approval pattern + manager home (mobile) + founders share
- **v0.5**: refunds + receipt page + history + settlements + stock-in + stock check + drafts + products manager + receipt config + dashboard
- **v0.6**: voucher/discount management + reconciliation jobs + spoilage flow + e2e tests
- **v1.0**: launch-ready (negative-stock reconciliation tools, settlement reconciliation, PWA install prompt polish, full e2e pass)

Each version bumps `docs/CHANGELOG.md`.

### Local docs / design source

Two directories are kept locally as reference but excluded from the repo via `.gitignore`:

- `frollie-pos design files/` — the wireframe handoff bundle (canonical source for screen IA + the 33-ADR registry).
- `archive/files.zip` — original delivery zip from the design tool.

When implementing a screen, open the corresponding artboard's source file under `frollie-pos design files/project/wireframes/*.jsx` for layout intent. The hand-drawn aesthetic is wireframe convention — implementation uses production-polish shadcn/Tailwind via the design tokens in `src/index.css`.

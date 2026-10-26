# Fulfillment operations

Run commands from the repository root. Deployment and database maintenance follow
[the Cloudflare runbook](cloudflare_deployment.md) and
[Commerce operations](commerce_operations.md).

## Admin IRL finalization Workflow

Admin IRL finalization runs in the API Worker's
`ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW`. The existing Admin request document,
30-minute lease, and on-chain submission records provide recovery. Commerce
migration `0008_admin_irl_redeem_workflow_operation.sql` indexes Workflow operation
IDs for status and recovery lookups.
Terminal failures with retained progress are not restarted by status polling.
After correcting the cause, authenticate as the original requesting Admin and
replay `POST /admin/irl-redeem/finalize` with its stored `dropId`, `requestId`,
and `transferSignature`. The API explicitly restarts or recreates the
deterministic instance, including after Workflow retention or deletion.
Ambiguously dispatched restarts are never auto-reissued; if one remains terminal
or missing after the grace window, inspect and resolve the deterministic Workflow
instance manually before replaying.

From the repository root, restart an existing instance with:

```bash
npx wrangler workflows instances restart mons-shop-admin-irl-redeem-finalize-v1 '<OPERATION_ID>' --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

After confirming the instance is missing or past retention, recreate it with its
stored Workflow payload:

```bash
npx wrangler workflows trigger mons-shop-admin-irl-redeem-finalize-v1 '{"version":1,"dropId":"<DROP_ID>","requestId":"<REQUEST_ID>"}' --id '<OPERATION_ID>' --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Keep the Workflow binding, status routes, and compatible frontend available
while operations are active. Drain active v1 Admin instances before changing
the signer, drop configuration, or on-chain configuration.

## Queues, schedules, and notifications

The API Worker produces and consumes notification email, reveal
reconciliation, and Stripe fulfillment queues, each with a dead-letter queue.
The shared five-minute scheduled trigger recovers Stripe fulfillment,
pack-status projections, and ready-to-ship notification work. Do not disable
the schedule to control one subsystem.

Ready-to-ship fulfillment notifications go to `fulfillment@mons.shop` for every
drop registered with `solanaCluster: 'mainnet-beta'`, including new drops by
default. Devnet and unknown drops do not notify fulfillment. Buyer notifications
and the admin IRL redemption exclusion retain their existing behavior.

Each `scheduled_reconciliation_job` log reports `attempted`, `completed`,
`deferred`, `skipped`, and `failed`. Counts refer to orders or operations, or
cleanup tasks for OPS; email and deleted-row totals remain in their domain logs.
Partial counts survive invocation failures. The invocation `outcome` describes
whether the pass resolved or rejected, so a successful pass may still report a
terminal item failure. Failure logs identify the affected work without including
provider messages or notification payloads.

Ready-to-ship, Stripe terminal, and shipped email publication state lives in
`COMMERCE_DB.commerce_notification_outbox`. Publication
claims and retries update outbox rows without changing order/check-out versions.
Ready and shipped reconciliation each page through eight due rows at a time,
stopping before new work after 32 inspected rows or 20 seconds per family.
Each run uses a fixed due cutoff and reports inspected rows, pages, stop reason,
remaining due work, and its oldest due age. In-flight publication and finalization
finish under the scheduled handler's existing deadline. Stripe limits remain
unchanged. Publication keeps ten-minute
claims, four attempts, six-hour retry windows, and stable job IDs/idempotency keys.
Rendered payloads are persisted before sending and reused exactly across retries;
Queue acceptance or cancellation removes payloads. Failed entries remain available
for investigation. Shipped-email intent is saved with fulfillment status and cron
recovers enqueue failures automatically; explicit resend uses a new generation.

Use `npm run notification-outbox-control -- status` for mode, readiness, pending
age, failures, and expired claims. The public shipped state remains `pending` or
`queued`; `queued` means Queue acceptance. Reconcile saved identities with Queue
and Resend outcomes before deliberately replaying work. The
[Commerce operations guide](commerce_operations.md#recovery-and-ongoing-maintenance)
covers ambiguous historical shipped markers, maintenance, and recovery.

Queue a synthetic notification email through the production API:

```bash
npm run test-resend-notification-email -- --kind stripe-manual-review
```

Inspect queues and live Worker logs with the pinned Wrangler:

```bash
node_modules/.bin/wrangler queues info mons-shop-notification-emails
node_modules/.bin/wrangler queues info mons-shop-notification-emails-dlq
node_modules/.bin/wrangler tail mons-shop-api --format json
```

Queue processing is idempotent. Replay dead-letter jobs only after fixing the
underlying failure and identifying the affected jobs.

Stripe fulfillment persists a notification outbox with its fulfilled or
manual-review status. Queue publication saves the email payloads and job IDs
before sending; retries reuse them. The five-minute cron also recovers pending
terminal notifications, independently of fulfillment Queue retries. Publication
uses the delivery notification policy: a ten-minute claim lease, at most four
attempts, and a six-hour window starting with the first attempt. Exhausted
publication is retained as a failed notification-outbox row and logged
as `stripe_terminal_notifications_failed` for manual review. `queued` means the
email Queue accepted the jobs; provider delivery still uses its existing retries
and dead-letter queue. Historical checkouts are not bulk backfilled; explicitly
replayed fulfillment jobs initialize missing outboxes.

Receipt-claim failures use the same error inbox and notification Queue. The
receipt-specific outbox captures terminal Workflow failures atomically, and the
five-minute cron detects overdue operations and abandoned legacy processing
claims. One incident produces one stable email job; completed or superseded
attempts are suppressed before publication. Receipt delivery retains its
15-minute automatic window and explicit retry requirement. See
[receipt claim failure emails](receipt_claim_workflow.md#failure-emails)
for diagnostics and recovery.

Inventory, pending-box, notification-subscription, and RPC browser requests are
accepted only from `mons.shop`, `www.mons.shop`, localhost, and `127.0.0.1`.
Candidate and version-preview frontend origins are intentionally unsupported.

## Stripe chargeback labels

Fulfillment displays a prominent **CHARGEBACK** label for a Stripe order with
any recorded dispute or inquiry. This records history permanently, including
won, lost, prevented, and otherwise resolved disputes. It does not change
fulfillment, shipping, claims, notifications, sorting, filtering, or available
order actions. Refunds and standalone fraud warnings do not create this label.
History lives separately in Commerce D1's `stripe_order_disputes` table, linked
by Stripe mode, Checkout Session, and exact stored drop identity. Duplicate
webhooks and repeated backfills do not duplicate records.

Use existing Wrangler authentication (or the configured `CLOUDFLARE_API_TOKEN`)
with `--cloudflare`. This connects to the API Worker's private
`StripeChargebackMaintenance` service entrypoint in the existing Cloudflare
account. Stripe credentials remain inside that deployed Worker. No staff-browser
login, local Stripe key, or additional shared secret is required. The operator
configuration pins the account, Worker, and named service; it does not publish an
operator Worker or add a public HTTP route.

Inspect, then enable dispute events on the existing active live and test Stripe
webhook destinations:

```bash
npm run backfill:stripe-chargebacks -- --cloudflare --configure-webhooks
npm run backfill:stripe-chargebacks -- --cloudflare --configure-webhooks --write
```

The inspection is a dry run and reports missing event counts. The write command
preserves all enabled events, signing secrets, URLs, and endpoint status, adds
only these events, and verifies the result:

- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`
- `charge.dispute.funds_withdrawn`
- `charge.dispute.funds_reinstated`

Setup rereads each endpoint before merging subscriptions. Avoid concurrent
Dashboard/API edits during setup: Stripe replaces the full event list.

Backfill the full live and test dispute history after deployment:

```bash
npm run backfill:stripe-chargebacks -- --cloudflare
npm run backfill:stripe-chargebacks -- --cloudflare --write
```

For operators who already have a fulfillment-admin staff session, omitting
`--cloudflare` retains the authenticated HTTP transport. Supply its token only
through `MONS_STAFF_SESSION_TOKEN`, never as a CLI argument. That transport pins
`https://api.mons.shop/admin/stripe-chargebacks/backfill` and refuses redirects.
Do not print or commit either kind of credential. Webhook configuration requires
`--cloudflare`; both transports share the same backfill checkpoints and results.

The first command is a dry run. Each request scans one dispute, without date,
drop, fulfillment-status, or dispute-status filters. Both commands default to
live and test modes; `--mode live` or `--mode test` limits an investigation to
one mode. Each mode must finish successfully in the write run to complete the backfill. Verify the resulting labels in Fulfillment and investigate
every reported failure. `matchedOrders` counts matched dispute-to-order records;
multiple disputes may refer to the same order.

Private local checkpoints in `.cache/stripe-chargebacks/` keep separate
live/test and dry-run/write cursors, successful-page totals, and failure details.
They contain no credentials. Interrupted runs resume their current page; HTTP
429, 408, 5xx, and network failures retry the identical request up to five times,
with a capped `Retry-After` delay. Pages containing only temporary Stripe,
storage, or order-persistence failures use the same retry budget. RPC failures
expose only recognized error codes. Authentication errors, permanent dispute
failures, and malformed responses stop immediately. Cloudflare RPC also stops
immediately for configuration and identity errors; exhausted temporary failures
exit nonzero. Fix the cause and rerun
the same command. Failed pages are not skipped. Their successful inserts remain
idempotent and may count as `existing` when that page is retried; progress totals
include only pages that fully succeeded.

Completed mode checkpoints start a fresh full scan on the next invocation.
`--restart` explicitly starts over from the beginning, including for an
interrupted run. A fresh write scan is safe and picks up newer disputes that
arrived ahead of an interrupted cursor. After recovering an interrupted rollout,
run a fresh complete scan in both modes before declaring the backfill finished.

The admin-only API accepts `{ mode: "live" | "test", cursor?: string,
write?: boolean }`; `write` defaults to false. Its successful response contains
`ok`, `mode`, `write`, `nextCursor`, `scanned`, `matchedOrders`, `inserted`,
`existing`, `unrelated`, and `failures` (`disputeId` and `code`). A null next
cursor means the end only when `failures` is empty. Unrelated Stripe payments
are counted without adding labels; an unresolved app order is a failure that
must be investigated.

## Packing replacement receipts

The completed binder issuance remains a normal Fulfillment packing order labeled
**Packing replacements**. Select the binder drop and download each available code
as a PNG, or use **Download Secret Codes ZIP** for displayed orders. These existing
exports use the stored claim codes and suppress used codes; they do not issue
receipts or reset claims. Packing orders have no customer shipment, shipping-label
actions, or customer notifications.

The [completed issuance record](../../releases/binder-packing-replacements-2026-10-20/README.md)
contains the receipt identities and historical tool revision. Keep private operator
journals and exports outside the repository. Existing receipt claims and their
recovery remain supported.

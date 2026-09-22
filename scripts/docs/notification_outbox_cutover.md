# Notification outbox cutover

Migration `0013_notification_outbox.sql` adds the notification table in inactive
`legacy` mode. Ready, Stripe terminal, and shipped notifications move together.
Subscription and synthetic notifications, Queue messages, and email consumers
remain unchanged. No messages are sent by the maintenance tools.

## Before maintenance

Use one fixed checkout. Complete validation before pausing and repeat it only if
the checkout changes:

```sh
npm run check:api
npm run typecheck:tools
npm test
npm run check:dead-code
```

Apply the additive schema while the existing Worker is serving traffic, then
inspect the source notification markers and resolve any malformed identities:

```sh
npm run db:migrate:api
npm run check:commerce-d1
npm run notification-outbox-control -- status
```

`status` reports migration readiness, counts by family/state, failed reasons,
oldest pending age, and expired claims. It never renders or sends emails. Legacy
orders with no notification markers are omitted. Legacy shipped `pending`
markers become failed with `legacy_shipped_delivery_unknown`: their first send
and original payload are unknown, so automatic replay is unsafe. Investigate
Queue/Resend history and use the existing explicit shipped-email retry only when
a deliberate resend is appropriate.

## Pause, prepare, publish, activate

Read the authority revision and run the existing coordinated pause:

```sh
npm run commerce-authority-control -- status
npm run commerce-authority-control -- paused --expected-revision <CURRENT_REVISION> --write
```

Keep the returned paused revision. The coordinator pauses all consumer Queues,
waits 15 minutes 5 seconds while Commerce remains active, pauses Commerce, then
waits another 15 minutes 5 seconds for in-flight requests and scheduled work.
Preserve both drains. Maintenance is ready only after `paused_at_ms` is set.

```sh
npm run notification-outbox-control -- prepare --expected-revision <PAUSED_REVISION> --write
npm run notification-outbox-control -- status
npm run check:commerce-d1 -- --for-deployment
```

Preparation holds the shared renewable maintenance lease, validates every
source marker, imports in bounded pages, and verifies every record before
marking the cutover ready. It preserves identities, partial completion, payloads,
claims and retry budgets. Once preparation starts, resuming legacy operation is
blocked until activation. An interrupted prepare is safe to rerun.

Publish the unchanged, already-validated checkout with the pinned Wrangler:

```sh
node_modules/.bin/wrangler deploy --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Only after publication succeeds, confirm that the compatible Worker is deployed
and activate the table:

```sh
npm run notification-outbox-control -- activate --expected-revision <PAUSED_REVISION> --worker-deployed --write
npm run notification-outbox-control -- status
npm run check:commerce-d1 -- --for-deployment
npm run check:pack-status-d1
npm run check:ops-d1
npm run commerce-authority-control -- d1 --expected-revision <PAUSED_REVISION> --write
npm run check:queue-backlogs
```

Activation checks the imported records against the frozen source snapshot and
switches storage in one guarded update. The coordinator restores Commerce
before resuming Queue consumers. Follow Worker notification error logs, pending
age, failed reasons, expired claims, and Queue backlogs after resumption.
`queued` means Queue acceptance, not email delivery.

## Recovery

- Keep Commerce and Queues paused after an uncertain prepare, publish, or
  activation. Inspect `status`, correct the cause, then rerun the same command
  with the current paused revision. Active leases reject concurrent maintenance;
  expired leases can be reacquired.
- Activation is one-way. After activation, deploy compatible corrections only.
  Preparation verifies active table integrity and never reimports frozen legacy
  fields. Database fences reject legacy notification-field writes.
- Saved payloads are reused across publication retries and removed after Queue
  acceptance or cancellation. Queue acceptance followed by a lost database
  acknowledgement can require replay; identities and retry budgets remain stable.
- Use the updated `wipe-drop` tool. Its plan, guards, and completion verification
  include notification rows deleted through the parent foreign key.

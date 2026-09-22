# Notification outbox cutover

Migration `0013_notification_outbox.sql` adds the notification table in inactive
`legacy` mode. Ready, Stripe terminal, and shipped notifications move together.
Subscription and synthetic notifications, Queue messages, and email consumers
remain unchanged. No messages are sent by the maintenance tools.

Migration `0014_drop_legacy_notification_indexes.sql` removes six indexes on
the frozen legacy notification fields. It requires activated `table` storage,
except for an untouched, empty database still in its initial paused state.
It does not activate notifications or change any order or outbox rows.

If `0013` is already applied but storage is still `legacy`, skip migration
application below and complete pause, preparation, publication, and activation
first. This checkout's checker accepts the exact `0013` baseline for that work.
Use the direct Wrangler publication command below: `deploy:api` applies all
pending migrations and will correctly stop at `0014` before activation.

For a populated database older than `0013`, complete the original cutover using
the previous release whose migrations end at `0013`, then return to this release
for index cleanup. Keep each release's validation and publication together.

## Before maintenance

Use one fixed checkout. Complete validation before pausing and repeat it only if
the checkout changes:

```sh
npm run check:api
npm run typecheck:tools
npm test
npm run check:dead-code
```

When performing the original cutover from the previous release, apply its
additive schema while the existing Worker is serving traffic:

```sh
npm run db:migrate:api
```

For databases already at `0013`, inspect the source notification markers and
resolve any malformed identities without applying `0014` yet:

```sh
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

## Remove legacy notification indexes

After activation, use this release to apply cleanup and verify the result:

```sh
npm run notification-outbox-control -- status
npm run db:migrate:commerce
npm run check:commerce-d1 -- --for-deployment
```

The checker accepts exact migration histories through `0013` or `0014`. It
requires the six legacy indexes at `0013` and their absence at `0014`, while
continuing to verify the active outbox indexes and query plans. Historical
notification fields and their write fences remain in place.

If `0014` fails with `notification_outbox_activation_required`, the cleanup is
rolled back and earlier successful migrations remain applied. Complete the
cutover before rerunning migration application. Do not bypass the guard or
mark the migration applied manually. Fresh database initialization can apply
all migrations before its normal inventory and outbox activation.

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

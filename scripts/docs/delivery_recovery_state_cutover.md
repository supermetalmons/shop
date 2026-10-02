# Delivery recovery state cutover

Migration `0030_delivery_recovery.sql` adds `commerce_delivery_recovery` in
inactive `legacy` mode. It moves the complete `receiptRecovery` value, including
unknown fields, retry history, legacy lease expiry, and pending transaction
journals. Order status, identity, ownership, shipping data, and notifications
remain in their existing stores. Each recovery row has an independent generation
and revision. Recovery-only updates leave the parent version unchanged.

For an already activated database, use the metadata cleanup procedure below.
A populated database still in legacy mode must complete this initial cutover
using a pre-0033 release before upgrading to the current release. An empty
database can replay every migration and use the normal empty preparation and
activation steps.

Use a fixed, validated checkout. Complete `npm run check:api`,
`npm run typecheck:tools`, `npm test`, and `npm run check:dead-code` before
maintenance. Finish the inventory, notification, Stripe checkout, and pack-status
outbox cutovers first. These maintenance commands do not call providers, submit
transactions, or send notifications.

## Publish the compatible frontend, then pause and backfill

Confirm the deployed API accepts paginated recovery. Publish the compatible
frontend before enforcing the new request contract; its API helper always sends
`cursor: null` for a broad first-page request:

```sh
npm run deploy
```

Apply the additive migration while the existing Worker serves traffic, then use
the existing coordinator to pause Queues, drain work, pause Commerce, and drain
in-flight requests and scheduled work:

```sh
npm run check:commerce-d1
npm run db:migrate:commerce
npm run delivery-recovery-state-control -- status
npm run commerce-authority-control -- status
npm run commerce-authority-control -- paused --expected-revision <CURRENT_REVISION> --write
```

Preserve both coordinator drains. Keep the returned authority revision and
continue only after `paused_at_ms` is set.

```sh
npm run delivery-recovery-state-control -- prepare --expected-revision <PAUSED_REVISION> --write
npm run delivery-recovery-state-control -- status
npm run check:commerce-d1 -- --for-deployment
```

Preparation holds the renewable shared maintenance lease and validates source
records before writes. It reads pages of five orders, omits duplicate recovery
payloads from parent metadata to stay within the runner's output buffer, imports every order including
orders without recovery data, and verifies all rows before marking preparation
ready. Missing recovery data remains distinct from explicit JSON null. Reruns
retain identical rows and their generations. Backfill preserves parent JSON,
versions, timestamps, and the Commerce documents revision. Changed source
revisions invalidate readiness. Resolve malformed source metadata or recovery
projections before rerunning preparation.

Starting preparation blocks resumption until activation. A fully paused, verified
preparation is accepted by deployment validation for the initial publication.

## Publish, activate, and resume

Publish the validated Worker while Commerce and Queues remain paused:

```sh
node_modules/.bin/wrangler deploy --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run delivery-recovery-state-control -- activate --expected-revision <PAUSED_REVISION> --worker-deployed --write
npm run delivery-recovery-state-control -- status
npm run check:commerce-d1 -- --for-deployment
npm run check:pack-status-d1
npm run check:ops-d1
npm run commerce-authority-control -- d1 --expected-revision <PAUSED_REVISION> --write
npm run check:queue-backlogs
```

Use `--worker-deployed` only after compatible publication succeeds. Activation
rechecks the entire source snapshot and switches storage in one guarded update.
The coordinator resumes Commerce before Queue consumers. Inspect recovery
failures, expired leases, and Queue backlogs after resumption. Existing pending
transaction journals remain available for recovery before any new submission.

Broad recovery now requires an explicit first-page `cursor: null`; follow
`nextCursor` for subsequent pages. The current frontend sends this already.
Cached older clients that omit a cursor receive HTTP 409 with
`failed-precondition` and `Refresh the page to continue delivery recovery.`
Those old clients only log the error and retry, so refresh existing tabs after
publication. Targeted `{ dropId, deliveryId, force }` calls remain supported
without a cursor. A target combined with any cursor is rejected.

## Recovery and ongoing operation

- Keep Commerce and Queues paused after uncertain preparation, publication, or
  activation. Inspect `status`, resolve the cause, and rerun with the current
  paused revision. A lost activation acknowledgement is reconciled against
  the stored control state.
- Activation is one-way. Publish compatible fixes afterward. Repeating `prepare`
  in table mode validates active rows and never restores frozen legacy JSON.
  Parent recovery fields stay frozen until migration 0033 removes their copies;
  later writes cannot restore them. Parent mutations require compatible commit
  guards. Old Workers fail closed after activation.
- `status` reports preparation and source revisions, validation errors, order
  counts, retry age, and active or expired leases. Active reads validate parent
  metadata and state together in bounded pages. Runtime wallet summaries return
  one aggregate row, although computing the exact result still scans matching
  wallet records in D1.
- The updated `wipe-drop` preview includes recovery row counts and generations
  and revisions in its freshness comparison. D1 guards validate those tokens
  before parent deletion cascades into recovery state; completion verification
  requires zero recovery rows for the target drop.
- Ordinary `deploy:api` checks require migration 0030 and active state, or the
  fully paused verified preparation used for the initial cutover.

## Remove frozen parent metadata

Migration `0033_delivery_recovery_metadata_cleanup.sql` removes only the obsolete
`receiptRecovery` property from delivery parent metadata. The recovery table
remains authoritative. It preserves every recovery row, pending transaction
journal, lease, generation, revision, parent version and timestamp, and Commerce
revision. It also replaces the old frozen-value fences with absence fences.
Other state-table migrations and their controls are unchanged.

Finish `npm run check:api`, `npm run typecheck:tools`, `npm test`, and
`npm run check:dead-code` on one fixed checkout before maintenance. Inspect the
existing database with the updated checker; migration 0032 remains inspectable.

```sh
npm run check:commerce-d1
npm run delivery-recovery-state-control -- status
npm run commerce-authority-control -- status
npm run commerce-authority-control -- paused --expected-revision <CURRENT_REVISION> --write
```

Preserve both coordinator drains. Continue only after `paused_at_ms` is set and
the coordinator has released its lease. Recovery must be in `table` mode with
`validationError: null`. Finish any outstanding wipe before continuing. The
migration refuses active or undrained Commerce, competing leases, unfinished
guards, and missing recovery parents. Its only exception is a strictly empty
initial database, whose bootstrap controls remain unchanged.

The existing coordinator waits 15 minutes 5 seconds for Queue consumers and
another 15 minutes 5 seconds for Commerce requests: allow about 30 minutes before
the migration. Queue delivery pauses during both drains; Commerce remains
available during the first drain.

Apply the migration before publishing the new Worker. Use Wrangler migrations
so trigger replacement and metadata removal roll back together on failure;
never execute individual migration statements.

```sh
npm run db:migrate:commerce
npm run check:commerce-d1 -- --for-deployment
npm run delivery-recovery-state-control -- status
node_modules/.bin/wrangler deploy --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run check:commerce-d1 -- --for-deployment
npm run check:pack-status-d1
npm run check:ops-d1
npm run commerce-authority-control -- d1 --expected-revision <PAUSED_REVISION> --write
npm run check:queue-backlogs
```

Verify `legacyMetadataCount: 0`, unchanged delivery count, and
`validationError: null` before resuming. The previously deployed Worker can read
and write the cleaned schema, so an unsuccessful publication can be retried
while paused. The new Worker requires migration 0033; publishing it first would
conflict with the old frozen-value fences. Do not restore parent copies from a
backup or rerun a legacy backfill. After a failed migration, verify the migration
history and the restored guards, correct its precondition, and retry while
Commerce stays paused. After an uncertain acknowledgement, inspect migration
history and status before retrying.

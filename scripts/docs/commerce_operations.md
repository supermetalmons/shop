# Commerce operations

Current tooling supports the latest Commerce schema, row-based inventory, and
the authoritative notification, checkout, pack-status, and delivery-recovery
tables. Applied SQL and historical schema checksums remain immutable. Append
migrations and regenerate the schema manifest for future schema changes.

## Inspect current state

```sh
npm run check:commerce-d1
npm run dude-inventory-control -- status
npm run notification-outbox-control -- status
npm run stripe-checkout-state-control -- status
npm run pack-status-outbox-control -- status
npm run delivery-recovery-state-control -- status
npm run commerce-authority-control -- status
npm run check:queue-backlogs
```

The database check requires the latest schema, initialized inventory, active
state tables, matching parent records, and valid indexes and query plans.
`--for-deployment` remains supported by the deployment gate. State-control
commands are read-only inspectors; their old `prepare` and `activate` commands
have been retired. Inventory preparation remains available for new drops.

Status includes validation errors, pending ages, failure reasons, and processing
leases. It does not send emails or contact payment or chain providers. Inventory
status checks ownership documents and reports configuration matches, stock
counts, and orphan reservations; the integrity check also validates availability.

## Pause and resume maintenance

Validate one fixed checkout before maintenance:

```sh
npm run check
npm run commerce-authority-control -- status
npm run commerce-authority-control -- paused --expected-revision <CURRENT_REVISION> --write
```

The coordinator pauses every configured consumer Queue and waits 15 minutes
5 seconds while Commerce remains active. It then pauses Commerce and waits
another 15 minutes 5 seconds for in-flight requests and scheduled work. Preserve
both drains. Continue only after `paused_at_ms` is set and retain the returned
paused authority revision.

Mutations require that revision, explicit `--write`, and the shared renewable
maintenance lease. An active lease rejects concurrent maintenance. After an
interruption, inspect state and rerun the same operation; an expired lease can
be reacquired. An uncertain result is not a reason to erase journals or guards.

After maintenance and any required compatible publication succeed:

```sh
npm run check:commerce-d1 -- --for-deployment
npm run check:pack-status-d1
npm run check:ops-d1
npm run commerce-authority-control -- d1 --expected-revision <PAUSED_REVISION> --write
npm run check:queue-backlogs
```

The coordinator restores Commerce authority before resuming consumers. A failed
publication leaves the previous Worker running; applied migrations stay applied.
Keep maintenance paused, fix the cause, and publish a compatible correction.
Never restore an old allocator or a Worker that writes frozen legacy fields.

## Initialize an empty database

Configure the intended fresh D1 databases and Queue bindings before these
commands. Bootstrap accepts only an empty Commerce database or verified partial
initialization from an earlier bootstrap attempt. It refuses business records,
revision tombstones, unfinished wipes, and unexpected initialization state.

Apply every migration before initializing storage:

```sh
npm run db:migrate:api
npm run commerce-authority-control -- status
npm run commerce-authority-control -- paused --expected-revision <CURRENT_REVISION> --write
npm run bootstrap:commerce -- --expected-revision <PAUSED_REVISION> --write
npm run check:commerce-d1 -- --for-deployment
npm run check:pack-status-d1
npm run check:ops-d1
npm run deploy:api
npm run commerce-authority-control -- d1 --expected-revision <PAUSED_REVISION> --write
npm run check:queue-backlogs
```

Even when migrations leave the fresh database paused, run the coordinator to
complete its drains and set `paused_at_ms`. Bootstrap verifies the exact current
schema, initializes registry-defined inventory with fresh generations, and moves
empty state controls through their existing guarded transitions. It remains
paused and does not deploy, resume Queues, call providers, or create business
records. Publish the frontend only after the API is ready.

Bootstrap is resumable after interrupted writes or lost acknowledgements. It
verifies existing inventory and completed transitions before continuing. It
never replenishes ready stock or imports frozen historical JSON. On failure,
leave Commerce paused, resolve the reported mismatch, and rerun with the current
paused revision. Do not use bootstrap on a previously used database whose rows
were deleted.

## Initialize a new inventory drop

After registering a new drop, complete the pause above and run:

```sh
npm run dude-inventory-control -- prepare --drop <DROP_ID> --expected-revision <PAUSED_REVISION> --write
npm run dude-inventory-control -- status --drop <DROP_ID>
npm run check:commerce-d1 -- --for-deployment
```

Inventory must already use `rows` mode. A missing or unfinished drop must have
no legacy pool or assignment documents. Preparation initializes its configured
range with a fresh generation, or verifies ready stock without replenishing it.
Without `--drop`, it processes the configured inventory drops. Existing stock
and ownership remain unchanged. Publish configuration changes before resuming
allocation through the normal authority coordinator.

## Recovery and ongoing maintenance

- Notification retries reuse saved payloads, job identities, and retry budgets.
  `queued` means Queue acceptance, not email delivery. For
  `legacy_shipped_delivery_unknown`, inspect Queue and Resend history before a
  deliberate resend; automatic replay could send a duplicate.
- Checkout and delivery recovery preserve processing claims, generations,
  revisions, and pending transaction journals. Do not clear an unresolved
  submission or receiver lock merely because its lease expired. Use the existing
  receipt/preorder recovery interfaces after resolving the underlying cause.
- Pack-status rebuild uses authoritative outbox rows. Pending, failed, or unknown
  projection state blocks rebuilding. Never enqueue all historical ready orders:
  previous summary rebuilds may already include them without individual events.
  New projections retain stable event identities across retries.
- `wipe-drop` keeps its pause, lease, freshness, and completion guards. Its preview
  includes authoritative state rows; parent deletion cascades through them.
  Recovery generation/revision checks remain required. Keep Commerce paused until
  an interrupted repository commit or deployment is resolved.

## Historical populated-database cutovers

The inventory, notification, checkout, pack-status, and recovery cutovers are
complete in production. Their import tooling and runbooks remain in commit
`521fd4761c340ff3bbfd1a3d46f67a3e73a34e4b`. For historical recovery, use an isolated
checkout of that revision and follow its recorded runbooks, including any
earlier migration checkpoint they require. Keep the scripts, dependencies,
schema checkpoint, and compatible Worker release matched. Current bootstrap
does not migrate populated historical databases.

All applied SQL, write fences, schema checksums, and compatibility records remain
in this checkout. Mainnet program and metadata compatibility is independent of
these retired database import commands.

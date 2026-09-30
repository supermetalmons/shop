# Pack-status outbox cutover

Migration `0029_pack_status_outbox.sql` adds an inactive outbox table to Commerce
D1. It moves delivery projection retry state out of order JSON. The DATA D1
event key and counter logic stay unchanged. Only delivery completion and admin
pack publication create new outbox rows, atomically with their ready orders.

Use one fixed checkout. Complete `npm run check:api`,
`npm run typecheck:tools`, `npm test`, and `npm run check:dead-code` before
maintenance. Preparation and activation only update Commerce D1. Queue work
resumes through the existing coordinator at the end of the cutover.

## Apply, pause, and prepare

The additive migration is compatible with the currently deployed Worker while
the new storage mode remains `legacy` and preparation remains `idle`.

```sh
npm run check:commerce-d1
npm run db:migrate:commerce
npm run pack-status-outbox-control -- status
npm run commerce-authority-control -- status
npm run commerce-authority-control -- paused --expected-revision <CURRENT_REVISION> --write
```

The existing coordinator pauses Queue consumers and drains them, then pauses
Commerce and drains in-flight requests and scheduled work. A new pause takes
about 30 minutes. Preserve both drains and the returned revision; proceed only
after `paused_at_ms` is set.

```sh
npm run pack-status-outbox-control -- prepare --expected-revision <PAUSED_REVISION> --write
npm run pack-status-outbox-control -- status
npm run check:commerce-d1 -- --for-deployment
```

Preparation holds the renewable maintenance lease, validates all marked orders
before importing any rows, and reads orders in pages of 25. It imports only
explicit pending, completed, or failed projection markers, preserving their
retry and terminal metadata. Missing failure counts and pending retry times
default to zero. Missing terminal timestamps and errors remain null. Invalid
supplied values stop preparation with the document path.

Unmarked historical orders remain unmarked. Never enqueue every ready order:
historical summary rebuilds can already include orders without per-order DATA
events, and replaying them would double-count totals.

Interrupted preparation retains identical imported rows and can be rerun.
Exact imported/source equality and an unchanged documents revision are required
before readiness. Starting preparation blocks resumption until activation.
Deployment validation accepts prepared legacy storage only while Commerce is
fully paused and the backfill is verified.

## Publish, activate, and resume

Keep Commerce and Queues paused while publishing the compatible Worker:

```sh
npm run deploy:api
npm run pack-status-outbox-control -- activate --expected-revision <PAUSED_REVISION> --worker-deployed --write
npm run pack-status-outbox-control -- status
npm run check:commerce-d1 -- --for-deployment
npm run check:pack-status-d1
npm run check:ops-d1
npm run commerce-authority-control -- d1 --expected-revision <PAUSED_REVISION> --write
npm run check:queue-backlogs
npm run pack-status-outbox-control -- status
```

Use `--worker-deployed` only after compatible publication succeeds. Activation
rechecks the prepared source, switches storage in one guarded update, and
freezes the six historical JSON projection fields. The old fields and index
remain for historical inspection. New rows and retry updates use the outbox
table exclusively. The coordinator restores Commerce before Queue consumers.

After resumption, inspect the existing `delivery_pack_status_projection_*`
logs, pending age and next-due timestamps, failure reasons, and Queue backlogs.
The schedule retains its four-order sweep cap, per-drop fairness, concurrency
two, and existing retry backoff. A successful DATA write followed by a lost
Commerce acknowledgment is safe to replay using the unchanged event identity.

## Recovery and maintenance

- Keep Commerce and Queues paused after uncertain preparation, publication, or
  activation. Inspect status and rerun the interrupted command with the current
  paused revision. An active maintenance lease rejects competing operations.
- Activation is one-way. Restore service with compatible fixes after
  activation. An older Worker must not be restored. Active-mode preparation
  validates current rows without reimporting frozen JSON.
- Status reports storage/preparation mode, source revision, validation errors,
  row counts by state, oldest pending/due times, and error-code counts.
- The updated rebuild tool uses authoritative table state after activation.
  Pending and failed rows block rebuild; completed and cancelled rows are
  settled. Preserve the existing requirement to quiesce mutation paths before
  writing rebuilt summaries.
- The updated wipe tool previews outbox row counts, verifies them before
  deletion, and requires zero remaining rows afterward. Rows are removed by
  the parent foreign key under the existing paused maintenance guards.

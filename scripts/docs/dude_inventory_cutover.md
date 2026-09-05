# Figure inventory cutover

Migration `0010_dude_inventory.sql` adds availability rows and an inactive storage
switch to Commerce D1. Existing figure and box documents retain ownership.
The updated Worker requires initialized inventory and `rows` mode for new
allocations; it never recreates stock from legacy pools.

## Before the maintenance window

Use one fixed checkout for validation and publication. Finish these checks before
pausing; repeat them only if the checkout changes:

```sh
npm run check:api
npm run typecheck:tools
npm test
npm run check:dead-code
```

Apply the additive schema while the old Worker is still serving traffic. Its
default `legacy` mode leaves existing allocation behavior intact:

```sh
npm run db:migrate:api
npm run check:pack-status-d1
npm run check:ops-d1
npm run check:commerce-d1
npm run dude-inventory-control -- status
```

The normal `deploy:api` command requires activated `rows` mode. For this initial
cutover, use the publication command below while Commerce is paused; the
standalone database checks continue to accept staged legacy inventory.

Review available/assigned counts, orphan reservations, and default pool
initialization. Missing/non-array pools use the full configured range; explicit
empty pools stay empty. Resolve ownership conflicts and unconfigured inventory
documents before the window. Orphan markers remain reserved.

Let Admin finalizations finish before the window. Preparation and activation
also reject unfinished finalization records. Inspect uncertain instances using
the existing Admin Workflow recovery procedure; do not terminate or replay them
simply to accelerate this migration.

## Pause, prepare, publish, activate

Read the authority revision, then use it in the pause command:

```sh
npm run commerce-authority-control -- status
npm run commerce-authority-control -- paused --expected-revision <CURRENT_REVISION> --write
```

Keep the returned paused revision. The coordinator first pauses Queue delivery
and waits 15 minutes 5 seconds while Commerce remains active. It then pauses
Commerce and waits another 15 minutes 5 seconds for in-flight requests. Preserve
both drains. Queue delivery is delayed during both waits; the commerce
maintenance interval starts at the second.

Prepare the current authoritative data under the coordination lease:

```sh
npm run dude-inventory-control -- prepare --expected-revision <PAUSED_REVISION> --write
npm run check:commerce-d1
```

Preparation inserts unready metadata, writes availability in bounded batches,
checks the exact ordered result, and marks each drop ready. An incomplete drop
blocks resumption. Before activation, rerunning preparation refreshes from legacy
data. Claim and notification records need no migration.

Publish the unchanged, already-validated checkout using the pinned Wrangler.
This primitive avoids repeating the full test suite inside the window:

```sh
node_modules/.bin/wrangler deploy --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Confirm publication succeeded, activate inventory, verify, and resume:

```sh
npm run dude-inventory-control -- activate --expected-revision <PAUSED_REVISION> --write
npm run check:commerce-d1
npm run check:pack-status-d1
npm run check:ops-d1
npm run commerce-authority-control -- d1 --expected-revision <PAUSED_REVISION> --write
```

Activation verifies all configured inventory drops and switches storage with one
guarded update. Queue messages and saved notification payloads remain intact.
The coordinator restores Commerce authority before resuming consumers. Check
normal reveal/receipt traffic, assignment conflicts, Worker errors, and Queue
backlogs with the existing operational tools after resumption.

## Recovery and new drops

- Keep Commerce paused after an uncertain backfill, publication, or activation.
  Inspect `status`, correct the cause, and rerun the same command using the
  current paused revision. Expired leases can be reacquired; active leases
  reject concurrent maintenance commands.
- `rows` mode is one-way. After activation, publish compatible corrections and
  never resume an old allocator. Database fences reject legacy pool writes even
  after inventory metadata is removed by a guarded wipe.
- In `rows` mode, preparation verifies ready stock without replenishing it.
  Missing/unready inventory with legacy ownership data is rejected rather than
  rebuilt from a stale pool.
- Initialize new configured drops before enabling allocation: use the normal
  pause/drain, run `prepare --drop <DROP_ID> --expected-revision <PAUSED_REVISION>
  --write`, verify, and resume. In `rows` mode the drop must have no legacy pool
  or assignment documents. A fresh generation rejects stale selections.
- Use the updated `wipe-drop` tool. Its guarded plan and completion checks include
  availability and metadata. Deleting an assignment never replenishes stock.

Rarity and selection rules are unchanged. The picker still reads remaining IDs
once per attempt; this change removes whole-pool writes and individual candidate
lookups, not that list read.

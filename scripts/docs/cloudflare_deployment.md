# Cloudflare deployment

Use the repository's pinned Wrangler. Authenticate interactively with native
Wrangler or provide a scoped `CLOUDFLARE_API_TOKEN`, then verify the selected
account:

```bash
node_modules/.bin/wrangler whoami
```

Deployment assumes the configured Workers, custom domains, `mons-shop-data`,
`mons-shop-ops`, and `mons-shop-commerce` D1 databases, Queues, dead-letter queues,
bindings, schedules, and secrets already exist. The npm commands validate and deploy application
changes; they do not create infrastructure, rewrite resource IDs, or pause
consumers. Provision a new environment explicitly before using these commands.

The committed `cloud/workers/api/release.env` remains empty. It isolates
production API commands from local dotenv files and must not be used to store
secrets.

## Frontend Worker

```bash
npm run check:frontend
npm run dry-run:frontend
npm run deploy
```

`dry-run:frontend` performs all frontend checks and a native
`wrangler deploy --dry-run`. `deploy` repeats the checks and publishes with
`wrangler deploy --strict`. It changes only the frontend Worker and does not
deploy the API.

## API Worker

Validate the API bundle and configuration without publishing:

```bash
npm run dry-run:api
```

Before production rollout, inspect the [Commerce maintenance procedure](commerce_operations.md).
The frozen-metadata cleanup requires preflight with the previous checker and a
completed pause/drain before migration and API publication. Follow the
[cleanup rollout sequence](commerce_operations.md#frozen-metadata-cleanup-rollout).

The focused production primitives are:

```bash
npm run db:migrate:data
npm run db:migrate:ops
npm run db:migrate:commerce
npm run db:migrate:api
npm run check:pack-status-d1
npm run check:ops-d1
npm run check:commerce-d1
npm run deploy:api
```

`db:migrate:api` applies all three D1 migration sets. `deploy:api` runs
the API checks, applies all pending remote D1 migration sets, checks remote
pack-status, ops-state, and commerce read-model integrity, and then publishes the API Worker with
native `wrangler deploy --strict`. This order ensures the deployed code never
expects a schema that has not been applied.

API deployment disables automatic resource provisioning with
`--experimental-provision=false`. Its named databases, queues, and R2 bucket
already exist. This avoids an unnecessary bucket-administration lookup when
deploying an existing binding with Worker edit permissions; Durable Object
class migrations still travel with the Worker deployment. See Cloudflare's
[binding permissions](https://developers.cloudflare.com/workers/authorization/#bindings).

Both API and frontend release checks verify generated catalog and schema files.
`generate:db` updates the catalog first, then replays all three D1 migration sets
to build the committed `scripts/generated/commerceSchemaManifest.json`,
`scripts/generated/dataSchemaManifest.json`, and
`scripts/generated/opsSchemaManifest.json`. The manifests preserve migration
checksums and schema fingerprints for historical checkpoints; Commerce also
preserves versioned preorder catalogs, while DATA and OPS record table ownership.
Run `npm run check:db-generated` to verify the generated files. Generation refuses
changes to recorded SQL or checkpoints. Adding these local manifests requires no
database migration or deployment; DATA and OPS retain their existing latest-schema
validation. Current Commerce inspection and deployment require the latest
checkpoint, initialized inventory in `rows` mode, and all four state controls in
`table` mode. Applied
migrations and historical seeds must never be edited; append a migration and
regenerate for schema changes.

Use the [Commerce operations guide](commerce_operations.md) for read-only
status, new-drop inventory initialization, pause/resume, and recovery. A fresh
database applies every migration, completes the coordinated pause/drain, and
runs `bootstrap:commerce` before its first API deployment. Historical recovery
uses the source revision recorded in that guide.

Delivery recovery reads its authoritative table, preserving pending transaction
journals and leases. Broad recovery requests must explicitly send `cursor: null`
for the first page. Cached clients that omit it receive a refresh error;
targeted recovery requests retain their existing contract.

Receipt retries recognize both missing assets and MPL Core's one-byte burned
accounts. Existing automatic website recovery resumes interrupted batches with
only the unprocessed assets, preventing repeat burns and duplicate receipts.

D1 changes and Worker publication are separate platform operations. Production
recovery is fix-forward: if any step fails, stop, inspect the remote state,
correct the problem, and rerun the same command. The currently deployed Worker
remains active until publication succeeds, while every applied D1 migration
remains recorded in its database. After a production defect, publish a
corrected version through the same checks. Do not edit applied SQL or attempt
to reverse the deployment workflow by hand.

After the frozen-metadata cleanup, publish only code that uses the authoritative
state tables. Earlier Workers that read or write removed JSON metadata are not
rollback targets; use a compatible correction.

## Pack-status D1

The API Worker binds the existing `mons-shop-data` database as `DATA_DB`.
Customer pack-status endpoints read its supported-drop summaries, immutable
event history, and cache-generation metadata.

`cloud/workers/api/migrations/0001_current_schema.sql` is the clean pack-status
baseline. Never edit a migration after it has been applied. Append a new numbered
migration and regenerate the schema manifests.

Apply pending production migrations and verify the result with:

```bash
npm run db:migrate:data
npm run check:pack-status-d1
```

The integrity check validates the supported summaries, projection and event
invariants, cache metadata, SQLite quick check, and foreign keys against the
remote database.

The authoritative rebuild derives summaries from Commerce D1 orders and
assignments, then writes the public summaries to the pack-status D1 database:

```bash
npm run rebuild-pack-status -- --all
npm run rebuild-pack-status -- --all --write
npm run check:pack-status-d1
```

The first command is read-only. A write replaces the selected summaries
atomically, preserves D1 event rows, requires their counts to remain unchanged,
and increments cache generation once. Run a write only while reveal,
fulfillment, delivery, and admin mutations are quiesced. The tool refuses
pending, failed, or unknown durable delivery projection outboxes.

Delivery projection retry state lives in
`COMMERCE_DB.commerce_pack_status_outbox`. Rebuild and wipe tools require the
authoritative table. Inspect mode, readiness,
pending age, and failures with `npm run pack-status-outbox-control -- status`.
The [Commerce operations guide](commerce_operations.md) covers
bootstrap, maintenance, and recovery.

Do not mark every legacy delivery order as projection-pending. Historical
summary rebuilds can include orders without per-order event documents, so
replaying those orders individually can double-count them. New ready orders
receive their durable pending outbox row atomically and are retried by the Worker
schedule.

## Operations D1

The API Worker binds `mons-shop-ops` as `OPS_DB`. Its schema is separate from pack
status. Append new files in
`cloud/workers/api/ops-migrations/`; keep applied migrations immutable and
regenerate the schema manifests.

Apply and verify this database independently with:

```bash
npm run db:migrate:ops
npm run check:ops-d1
```

The integrity check validates the schema baseline, every strict table, expiry
indexes, foreign keys, SQLite quick check, singleton controls, and current
table shapes. Receipt-transfer caller and asset buckets use exact ten-minute
fixed windows. Expired buckets are cleaned in bounded batches by the existing
five-minute Worker schedule. The retained ready-notification cursor is historical
storage; active recovery
and health checks do not use it.

Reveal submissions live in Ops D1. Inspect or pause that subsystem with:

```bash
npm run reveal-submissions-control -- status
npm run reveal-submissions-control -- pause --write
npm run reveal-submissions-control -- resume --write
```

Profiles and append-only encrypted saved addresses live only in the Ops D1
database. The Ops integrity check validates their schema and current row
integrity without hard-coded production count floors.

## Worker secrets

Cloudflare Worker secrets are the runtime secret system. The required inventory
is declared in `cloud/workers/api/wrangler.jsonc` and includes Alchemy, OpenSea,
Helius, the cosigner and address-decryption keys, Resend, notification enqueue,
ShipStation, and Stripe values.

Create or rotate a secret with native Wrangler and enter its value through the
prompt or standard input:

```bash
node_modules/.bin/wrangler secret put <SECRET_NAME> \
  --config cloud/workers/api/wrangler.jsonc \
  --env-file cloud/workers/api/release.env
```

List configured secret names with:

```bash
node_modules/.bin/wrangler secret list \
  --config cloud/workers/api/wrangler.jsonc \
  --env-file cloud/workers/api/release.env
```

Do not store runtime secrets in `release.env`, repository files, command
arguments, logs, or frontend environment variables.
`SHIPSTATION_SHIP_FROM` is one JSON object; its Worker secret value is the
canonical fulfillment origin address.
Use `"name": "mons shop"` and `"company_name": "mons.shop"` for this origin.
USPS rejects `"name": "mons.shop"` because its full-name validation requires
two parts containing at least two alphabetic characters each.

## Background work

Queue consumers and the five-minute schedule recover accepted operations. Use
subsystem admission and maintenance controls instead of disabling the shared
schedule. See [fulfillment operations](fulfillment_operations.md) for Queue,
notification, and admin recovery, and [receipt claim operations](receipt_claim_workflow.md)
for receipt Workflow recovery.

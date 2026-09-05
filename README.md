# mons.shop

React + TypeScript Solana dapp for mons IRL blind boxes. Box minting is fully
on-chain through the custom box-minter program and MPL Core assets. The browser
uses Worker-managed anonymous sessions and Solana wallet signatures for identity.
Privileged application traffic runs through Cloudflare. D1 owns commerce
documents, profiles, saved addresses, the public pack-status projection, Worker
control, rate-limit state, and shipment and fulfillment data.

## Architecture

- `mons-shop` serves static assets and proxies authenticated `/api/*` requests
  to `mons-shop-api` through a service binding.
- `mons-shop-api` serves `api.mons.shop`, including inventory, Solana RPC,
  profiles, delivery, claims, Stripe, ShipStation, notifications, admin routes,
  scheduled reconciliation, and Queue consumers.
- Ops D1 stores opaque anonymous-session hashes and the immutable legacy-auth
  retirement record. The retired Google Cloud project was deletion-requested on
  2026-08-26 without creating a database archive and is not an application
  runtime path.
- The `mons-shop-data` D1 database is authoritative for public pack-status
  summaries and events.
- The `mons-shop-ops` D1 database stores profiles, encrypted saved addresses,
  wallet-session bindings, the ready-notification cursor, and receipt-transfer
  fixed-window rate-limit buckets.
- The `mons-shop-commerce` D1 database is the permanent authority for delivery
  orders, assignments, claim codes, Stripe checkouts, and related commerce
  documents.
- The API Worker's existing cron, Queue producers and consumers, dead-letter
  queues, bindings, routes, and secrets are declared in
  `cloud/workers/api/wrangler.jsonc`.
- `shared/` is the canonical runtime-neutral domain core used by the frontend,
  API Worker, and repository tools. Its boundary rules live in
  `shared/README.md`.
- `shared/deploymentRegistry.ts` is the canonical secret-free drop registry.
  `src/config/deployment.ts` is its frontend projection and
  `cloud/workers/api/src/dropConfig.ts` is its API projection.
- `scripts/ops/` contains the guarded Cloudflare operational utilities.

There is one root dependency graph. Do not add a nested package for server
code.

## Local development and validation

Requires Node.js 22.15 or newer and the npm version pinned in `package.json`.

```bash
npm install
npm run dev
```

Development proxies authenticated `/api/*` calls to `https://api.mons.shop`.
The target may be overridden in an uncommitted `.env` or the invoking shell:

- `VITE_MONS_API_ORIGIN`

These overrides are development-only. Production frontend checks and
deployments ignore local dotenv overrides and inject build time during the
build. Never expose a server secret through a `VITE_*` variable.

Useful checks:

```bash
npm run check:frontend
npm run dry-run:frontend
npm run check:api
npm run dry-run:api
npm run check
```

`check:frontend` runs frontend typechecking, repository tests, the production
build, and browser-bundle validation. `dry-run:frontend` adds a native Wrangler
dry run. `check` is the full repository gate, including API and runtime tests,
dead-code checks, on-chain tests, generated Worker types, Worker startup
validation, and both production bundles.

## Anonymous Auth and legacy-provider retirement

The frontend creates fresh anonymous identities through `mons-shop-api`. The
opaque credential stays in an HttpOnly, host-only cookie; local storage contains
only non-secret subject and expiry metadata. Authenticated browser requests use
the frontend Worker's same-origin `/api/*` gateway and a fixed CSRF header.

Legacy provider ID tokens are not accepted. The completed removal is recorded
irreversibly in Ops D1, and arbitrary bearer tokens fail closed without an
external certificate lookup. No database archive was created before the Google
Cloud project entered `DELETE_REQUESTED`; its recorded recovery deadline is
2026-09-25. This repository does not manage or deploy resources in that project,
and application runtime code must not add legacy-provider access.

Commerce documents, profiles, saved addresses, wallet sessions, and operational
controls are D1-only.

### Wallet sessions

The mapping from each anonymous auth subject to its signed Solana wallet is
D1-only in `mons-shop-ops` and keyed by `auth_subject`. Different-wallet
rebinding is temporarily blocked while profile reconciliation holds its
bounded D1 lease, while same-wallet renewal remains available.

Allowlisted fulfillment and admin wallets use a separate wallet-only staff
session and do not depend on anonymous authentication. The API issues a
five-minute, one-time Solana signing challenge, stores only the resulting
opaque session secret hash in `mons-shop-ops`, and requires that staff session
for every `/admin/*` and `/fulfillment/*` request. The browser restores the
session under `monsStaffWalletSession:v1` and refreshes its 30-day inactivity
window once per day. Removing a wallet from the committed staff access
inventory invalidates its sessions immediately. Legacy staff sessions are
discarded on first load so the wallet signs the staff
challenge once. Active challenges are reused, while Cloudflare Worker bindings
rate-limit challenge and signature requests without storing caller counters in
D1.

## Cloudflare deployment

Use the repository's pinned Wrangler. Authenticate interactively with native
Wrangler or provide a scoped `CLOUDFLARE_API_TOKEN`, then verify the selected
account:

```bash
node_modules/.bin/wrangler whoami
```

Deployment assumes the configured Workers, custom domains, `mons-shop-data` and
`mons-shop-ops` D1 databases, Queues, dead-letter queues, bindings, schedules,
and secrets already exist. The npm commands validate and deploy application
changes; they do not create infrastructure, rewrite resource IDs, or pause
consumers. Provision a new environment explicitly before using these commands.

The committed `cloud/workers/api/release.env` remains empty. It isolates
production API commands from local dotenv files and must not be used to store
secrets.

### Frontend Worker

```bash
npm run check:frontend
npm run dry-run:frontend
npm run deploy
```

`dry-run:frontend` performs all frontend checks and a native
`wrangler deploy --dry-run`. `deploy` repeats the checks and publishes with
`wrangler deploy --strict`. It changes only the frontend Worker and does not
deploy the API.

### API Worker

Validate the API bundle and configuration without publishing:

```bash
npm run dry-run:api
```

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

D1 changes and Worker publication are separate platform operations. Production
recovery is fix-forward: if any step fails, stop, inspect the remote state,
correct the problem, and rerun the same command. The currently deployed Worker
remains active until publication succeeds, while every applied D1 migration
remains recorded in its database. After a production defect, publish a
corrected version through the same checks. Do not edit applied SQL or attempt
to reverse the deployment workflow by hand.

Ops migration 0003 removed a column required by older API Workers. Never deploy
or roll back below compatibility version
`1f782978-64cd-4934-834d-9432ba7a0145`.

### Admin IRL finalization Workflow

Admin IRL finalization runs in the API Worker's
`ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW`. The existing Admin request document,
30-minute lease, and on-chain submission records provide recovery. Commerce
migration `0008_admin_irl_redeem_workflow_operation.sql` indexes Workflow operation
IDs for status and recovery lookups. Stripe receipt claims remain synchronous.
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

Roll out the compatible frontend first, then the API binding and routes, then
the final frontend timeout cleanup. Cached pre-compatibility tabs must refresh
before the API cutover. After the final frontend release, roll the frontend back
to its compatibility version before rolling the API back. Drain active v1 Admin
instances before changing the signer, drop configuration, or on-chain
configuration.

### Pack-status D1

The API Worker binds the existing `mons-shop-data` database as `DATA_DB`.
Customer pack-status endpoints read its supported-drop summaries, immutable
event history, and cache-generation metadata.

`cloud/workers/api/migrations/0001_current_schema.sql` is the clean pack-status
baseline. Never edit a migration after it has been applied. Introduce the next
schema change as `0004_<description>.sql`, then continue numbering in order.

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

Do not mark every legacy delivery order as projection-pending. Historical
summary rebuilds can include orders without per-order event documents, so
replaying those orders individually can double-count them. New ready orders
receive their durable pending marker atomically and are retried by the Worker
schedule.

### Operations D1

The API Worker binds `mons-shop-ops` as `OPS_DB`. Its schema is separate from
pack status and starts at
`cloud/workers/api/ops-migrations/0001_current_schema.sql`. Migration
`0003_remove_ready_notification_pause.sql` removes the legacy notification pause
column while preserving the reconciliation cursor,
`0004_repair_ready_notification_cursor.sql` repairs a missing cursor singleton,
`0005_remove_redundant_anonymous_auth_subject_index.sql` removes the redundant
named index while preserving the table's unique index, and
`0006_cover_expiry_cleanup_indexes.sql` covers the complete ordering used by
bounded expiry cleanup queries. Append `0007_<description>.sql` for the next
change and never edit an applied file.

Apply and verify this database independently with:

```bash
npm run db:migrate:ops
npm run check:ops-d1
```

The integrity check validates the schema baseline, every strict table, expiry
indexes, foreign keys, SQLite quick check, singleton controls, and current
table shapes. Receipt-transfer caller and asset buckets use exact ten-minute
fixed windows. Expired buckets are cleaned in bounded batches by the existing
five-minute Worker schedule. Ready-notification reconciliation stores only its
cursor and compare-and-set revision in Ops D1.

Reveal submissions live in Ops D1. Inspect or pause that subsystem with:

```bash
npm run reveal-submissions-control -- status
npm run reveal-submissions-control -- pause --write
npm run reveal-submissions-control -- resume --write
```

Profiles and append-only encrypted saved addresses live only in the Ops D1
database. The Ops integrity check validates their schema and current row
integrity without hard-coded production count floors.

### Worker secrets

Cloudflare Worker secrets are the runtime secret system. The required inventory
is declared in `cloud/workers/api/wrangler.jsonc` and includes Helius, the
cosigner and address-decryption keys, Resend, notification enqueue, ShipStation,
and Stripe values.

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

### Commerce database

`mons-shop-commerce` is the authoritative commerce document database. Its
schema starts at
`cloud/workers/api/commerce-migrations/0001_current_schema.sql`; migration
`0002_authority_control_lease.sql` adds operational serialization and
`0003_wipe_readiness_guard.sql` makes destructive maintenance readiness atomic,
`0004_ready_notification_owner_indexes.sql` adds owner-targeted
ready-notification indexes, and `0005_delivery_owner_query_revisions.sql` adds
owner-scoped delivery-order query guards without replacing the global revision
used by maintenance. `0006_document_path_revisions.sql` adds path-scoped
revision guards for point reads. Owner- and document-path revision rows are
retained as tombstones so deleted scopes cannot return to an earlier epoch.
Migration `0006` requires Commerce to be paused with `paused_at_ms` confirming
the drain. The exact untouched seed state may migrate without a prior pause, but
the migration atomically leaves it paused and unready so old readers cannot cross
the cutover. Keep Commerce paused through `npm run deploy:api` and until the
`0006`-capable Worker is verified. For an automatic seed-state pause, rerun the
`paused` authority command with the current revision to complete the normal drain
before resuming; unready authority cannot resume. This is a pause-and-cutover
migration, not a rolling Worker migration. Never deploy or roll back to a
pre-`0006` Worker while Commerce is active: pause and fully drain it first, then
keep it paused until a compatible Worker is restored. Legacy existing-path write
expectations remain accepted; tombstoned absent-path expectations fail closed.
`0007_stripe_terminal_notifications.sql` indexes pending Stripe terminal
notifications, and `0008_admin_irl_redeem_workflow_operation.sql` indexes Admin IRL
Workflow operation IDs. Migration `0008` is additive and preserves existing
documents and authority state. For a database already at `0007`, apply it with
`npm run db:migrate:commerce`, then run `npm run check:commerce-d1` from the updated
checkout; no Commerce pause or Worker publication is required for this index.
Append `0009_<description>.sql` for the next change.
The Worker preserves the existing commerce API and transaction behavior through
the D1 document-store adapter.

Inspect or pause the authoritative database with:

```bash
npm run check:commerce-d1
npm run commerce-authority-control -- status
npm run commerce-authority-control -- paused --expected-revision <revision> --write
npm run commerce-authority-control -- d1 --expected-revision <revision> --write
```

All authority-control commands require a scoped `CLOUDFLARE_API_TOKEN` with
Queues Write and the D1 permissions Wrangler needs for the remote authority
query or mutation. A new pause takes about 30 minutes: it pauses every configured
consumer Queue and drains in-flight consumers before changing D1 authority, then
drains in-flight HTTP and scheduled work. The command sets `paused_at_ms` only
after both drains and a final Queue-pause check; a null value means maintenance
is not ready. A `d1` command restores D1 authority before resuming those Queues.
Queue names and the account ID are read from
`cloud/workers/api/wrangler.jsonc`; the token is never printed.

Authority mutations still require the current revision and explicit `--write`.
Mutation and repair commands are serialized by a renewable 30-minute D1 lease;
an active lease rejects concurrent commands. If a process exits before release,
retry after the lease expires.
If an operation is interrupted, rerun the same command with the same expected
revision. A pause repair clears `paused_at_ms` and repeats the full Queue drain
before marking maintenance ready again. The coordinator only changes Queue
states that still differ from the requested state. A partial resume leaves D1
authoritative and exits with the Queues that remain paused.

### Queues, schedules, and notifications

The API Worker produces and consumes notification email, reveal
reconciliation, and Stripe fulfillment queues, each with a dead-letter queue.
The shared five-minute scheduled trigger recovers Stripe fulfillment,
pack-status projections, and ready-to-ship notification work. Do not disable
the schedule to control one subsystem.

Ready-to-ship email recovery uses the `ready_notifications` reconciliation
cursor in `mons-shop-ops`. Reconcile stored job IDs with Queue and Resend
outcomes before replaying work because a Queue publish may have succeeded before
its D1 marker update.

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
publication is retained as `stripeTerminalNotificationState: failed` and logged
as `stripe_terminal_notifications_failed` for manual review. `queued` means the
email Queue accepted the jobs; provider delivery still uses its existing retries
and dead-letter queue. Historical checkouts are not bulk backfilled; explicitly
replayed fulfillment jobs initialize missing outboxes.

Inventory, pending-box, notification-subscription, and RPC browser requests are
accepted only from `mons.shop`, `www.mons.shop`, localhost, and `127.0.0.1`.
Candidate and version-preview frontend origins are intentionally unsupported.

## Operations

The retained tools are intentionally narrow:

- `npm run check-irl-claims` (`scripts/ops/checkIrlClaims.ts`) inspects IRL
  claim state.
- `npm run rebuild-pack-status` (`scripts/ops/rebuildPackStatus.ts`) compares
  authoritative Commerce D1 history with pack-status summaries and is read-only unless its
  explicit D1 write option is supplied.
- `npm run check:ops-d1` validates the remote operations database, its
  ready-notification singleton, and the permanent legacy-auth retirement record.
- `npm run test-resend-notification-email` sends a synthetic notification
  through the production API queue.
- `npm run wipe-drop` (`scripts/ops/wipeDrop.ts`) is the guarded repository and
  Commerce D1 cleanup utility. It refuses drops with pack-status or reveal
  history. Use `--dry-run` to inspect proposed changes without pausing. Before
  mutation, pause Commerce D1 with `commerce-authority-control`; a new pause
  takes about 30 minutes and returns only after `paused_at_ms` marks maintenance ready.
  `wipe-drop` then requires that readiness marker to be at least 65 seconds old.
  During mutation it holds the authority lease and keeps a D1 wipe guard until
  the repository commit finishes, so resume is blocked after an interrupted
  wipe. Keep Commerce paused until the updated API and frontend are deployed,
  then resume `d1`. Mutation requires interactive confirmation unless `--yes`
  is supplied explicitly.

Active operator commands use the configured Cloudflare D1 databases and require
no legacy-provider CLI access.

## Address encryption

Generate a TweetNaCl-compatible Curve25519 keypair and place only the base64
public key in `src/App.tsx` as `ADDRESS_ENCRYPTION_PUBLIC_KEY`:

```bash
node -e "const nacl=require('tweetnacl');const kp=nacl.box.keyPair();console.log('pub',Buffer.from(kp.publicKey).toString('base64'));console.log('secret',Buffer.from(kp.secretKey).toString('base64'));"
```

Keep the private key only in the API Worker's
`ADDRESS_DECRYPTION_SECRET`. Never ship it to the frontend or any public
configuration.

## On-chain deployments and metadata compatibility

Provision a reusable cluster-scoped receipt pool:

```bash
npm run deploy-receipt-pool -- <poolId> <devnet|mainnet-beta>
```

Deploy a drop from `scripts/newDrops/<dropId>.ts`:

```bash
npm run deploy-all-onchain -- <dropId>
```

The deploy tool updates only `shared/deploymentRegistry.ts`. It accepts HTTPS,
`ipfs://`, or raw CID metadata bases and normalizes raw CIDs to canonical
`ipfs://CID` values.

Metadata URI history is part of live on-chain compatibility:

- Existing legacy `/json/...` drops must keep their recorded
  `metadataPathFormat`, base aliases, and program behavior.
- The first compact-metadata drop in a program lineage must use a fresh program
  (`reuseProgramId = false`) so it cannot change legacy URI behavior.
- Later compact drops may reuse that lineage with `reuseProgramId = true`; use
  `reuseProgramIdFromDropId` to pin the source drop explicitly.
- Do not delete URI migration records, legacy codecs, aliases, or compatibility
  tests merely because current drops use compact metadata.

Those records, compatibility helpers, and their verifier are retained
operational evidence, not obsolete deployment tooling.

Verify the historical mainnet URI migrations before changing URI logic:

```bash
npm run verify:mainnet-uri-migrations
```

Upgrade an existing program only through the canonical registered drop:

```bash
npm run upgrade-onchain -- <dropId> --dry-run
npm run upgrade-onchain -- <dropId>
```

Rehearse upgrades on the corresponding devnet drop first. Reused program drops
skip program build and deployment during ordinary `deploy-all-onchain`; an
intentional upgrade must use `upgrade-onchain`.

Stripe test Checkout performs a pre-payment availability check but does not
reserve on-chain supply. If supply sells out before webhook fulfillment, the
checkout is marked for manual refund review with its Stripe session identifier.

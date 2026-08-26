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
- Ops D1 stores opaque anonymous-session hashes and the irreversible Firebase-auth
  removal record. Firestore client rules deny every browser read and
  write; the API Worker accesses operational data with its service accounts.
- The `mons-shop-data` D1 database is authoritative for public pack-status
  summaries and events.
- The `mons-shop-ops` D1 database stores profiles, encrypted saved addresses,
  wallet-session bindings, the ready-notification control, and receipt-transfer
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
- `scripts/ops/` contains the retained Firestore and operational utilities.

There is one root dependency graph. Do not add a nested package for server
code.

## Local development and validation

Requires Node.js 22 and the npm version pinned in `package.json`.

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
npm run test:firestore-rules
npm run check
```

`check:frontend` runs frontend typechecking, repository tests, the production
build, and browser-bundle validation. `dry-run:frontend` adds a native Wrangler
dry run. `check` is the full repository gate, including API and
runtime tests, Firestore rules, dead-code checks, on-chain tests, generated
Worker types, Worker startup validation, and both production bundles. Java is
required for the Firestore Emulator suite.

## Anonymous Auth and Firestore

The frontend creates fresh anonymous identities through `mons-shop-api`. The
opaque credential stays in an HttpOnly, host-only cookie; local storage contains
only non-secret subject and expiry metadata. Authenticated browser requests use
the frontend Worker's same-origin `/api/*` gateway and a fixed CSRF header.

Firebase ID tokens are not accepted. The completed removal is recorded
irreversibly in Ops D1, and arbitrary bearer tokens fail closed without a Google
certificate lookup. The retained Firestore catch-all rules reject every browser
read and write, and the historical database is not an application runtime path.

Commerce documents, profiles, saved addresses, wallet sessions, and operational
controls are D1-only. Firebase tooling remains only for deny-rule validation and
deployment.

Deploy Firestore indexes and deny-all client rules from the repository root:

```bash
npm run deploy:firestore
```

The command runs the emulator rules suite before changing the `mons-shop`
project, then deploys the retained indexes and deny rules. Application runtime
code must not add new Firestore queries.

### Wallet sessions

The mapping from each anonymous auth subject to its signed Solana wallet is
D1-only in `mons-shop-ops`; its legacy physical column remains `firebase_uid`
for storage compatibility. Different-wallet
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

`db:migrate:api` applies both immutable migration histories. `deploy:api` runs
the API checks, applies all pending remote D1 migration sets, checks remote
pack-status, ops-state, and commerce read-model integrity, and then publishes the API Worker with
native `wrangler deploy --strict`. This order ensures the deployed code never
expects a schema that has not been applied.

D1 changes and Worker publication are separate platform operations. Production
recovery is fix-forward: if any step fails, stop, inspect the remote state,
correct the problem, and rerun the same command. The currently deployed Worker
remains active until publication succeeds, while any already-applied D1
migration remains part of database history. After a production defect, publish
a corrected version through the same checks. Do not edit applied SQL or attempt
to reverse the deployment workflow by hand.

### Pack-status D1

The API Worker binds the existing `mons-shop-data` database as `DATA_DB`.
Customer pack-status endpoints read D1 only; historical Firestore is not a
fallback. The projection includes supported-drop summaries, immutable event
history, and cache-generation metadata.

D1 files under `cloud/workers/api/migrations/` are immutable history. Never
edit, rename, reorder, or remove a migration that may have been applied.
Introduce schema changes by appending the next numbered migration. A fresh
database must apply the complete history in order and finish with the same
steady-state schema as production; intermediate schema in historical files is
expected.

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

The API Worker binds `mons-shop-ops` as `OPS_DB`. Its immutable migration
history is separate from pack status under
`cloud/workers/api/ops-migrations/`. Append a numbered migration for every
future change; never edit or remove one that may have been applied.

Apply and verify this database independently with:

```bash
npm run db:migrate:ops
npm run check:ops-d1
```

The integrity check validates Wrangler migration history, every strict table,
the expiry index, foreign keys, SQLite quick check, the singleton
ready-notification control, the reveal-submission source and production count
baseline, and the profile-storage source. Receipt-transfer
caller and asset buckets use exact ten-minute fixed windows. Expired buckets
are cleaned in bounded batches by the existing five-minute Worker schedule;
there is no Firestore backfill for these ephemeral counters.

Reveal submissions live in Ops D1 after their guarded one-way cutover. Inspect
or pause that subsystem with:

```bash
npm run reveal-submissions-control -- status
npm run reveal-submissions-control -- pause --write
npm run reveal-submissions-control -- resume --write
```

The production Firestore-to-D1 cutover completed on 2026-08-25. The D1 source is
permanent and the Worker fails closed unless all 14 pre-cutover submissions are
present. Recover by fixing forward and retain the historical Firestore documents
without modifying or deleting them.

Profiles and append-only encrypted saved addresses live only in the Ops D1
database. The Ops integrity check enforces the production cutover count floors
and permanently D1-only source.

Inspect and mutate the notification control only through the guarded operator
command:

```bash
npm run ready-notifications-control -- status
npm run ready-notifications-control -- pause --write
npm run ready-notifications-control -- resume --write
```

Pause and resume always advance the control revision, including repeated
requests for the same state, so in-flight cursor updates become stale. All
mutations require `--write`; `status` is read-only.

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

Do not store runtime secrets in Firebase configuration, `release.env`,
repository files, command arguments, logs, or frontend environment variables.
`SHIPSTATION_SHIP_FROM` is one JSON object; its Worker secret value is the
canonical fulfillment origin address.

### Commerce database

`mons-shop-commerce` is the authoritative commerce document database after the
guarded maintenance cutover. The Worker preserves the existing commerce API
and transaction behavior through the D1 document-store adapter.

Inspect or pause the authoritative database with:

```bash
npm run check:commerce-d1
npm run commerce-authority-control -- status
npm run commerce-authority-control -- paused --expected-revision <revision> --write
npm run commerce-authority-control -- d1 --expected-revision <revision> --write
```

Authority mutations require the current revision and explicit `--write`.

### Queues, schedules, and notifications

The API Worker produces and consumes notification email, reveal
reconciliation, and Stripe fulfillment queues, each with a dead-letter queue.
The shared five-minute scheduled trigger recovers Stripe fulfillment,
pack-status projections, and ready-to-ship notification work. Do not disable
the schedule to control one subsystem.

Ready-to-ship email recovery uses the `ready_notifications` control in
`mons-shop-ops`. Use `ready-notifications-control` to pause only this subsystem
during incident reconciliation; do not disable the shared schedule. Reconcile
stored job IDs with Queue and Resend outcomes before replaying work because a
Queue publish may have succeeded before its D1 marker update.

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

## Operations

The retained tools are intentionally narrow:

- `npm run check-irl-claims` (`scripts/ops/checkIrlClaims.ts`) inspects IRL
  claim state.
- `npm run rebuild-pack-status` (`scripts/ops/rebuildPackStatus.ts`) compares
  authoritative Commerce D1 history with pack-status summaries and is read-only unless its
  explicit D1 write option is supplied.
- `npm run check:ops-d1` validates the remote operations database, its
  ready-notification singleton, and the permanent Firebase-auth removal record.
- `npm run ready-notifications-control` inspects or changes the D1 notification
  control; every mutation requires `--write`.
- `npm run test-resend-notification-email` sends a synthetic notification
  through the production API queue.
- `npm run wipe-drop` (`scripts/ops/wipeDrop.ts`) is the guarded repository and
  Commerce D1 cleanup utility. It refuses drops with pack-status or reveal
  history. Use `--dry-run` to inspect proposed changes without pausing. Before
  mutation, pause Commerce D1 with `commerce-authority-control`, wait at least
  65 seconds, and rerun the command; keep Commerce paused until the
  updated API and frontend are deployed, then resume `d1`. Mutation requires
  interactive confirmation unless `--yes` is supplied explicitly.

Active operator commands use the configured Cloudflare D1 databases. Firebase
CLI access is retained only for deny-rule validation and deployment.

## Address encryption

Generate a TweetNaCl-compatible Curve25519 keypair and place only the base64
public key in `src/App.tsx` as `ADDRESS_ENCRYPTION_PUBLIC_KEY`:

```bash
node -e "const nacl=require('tweetnacl');const kp=nacl.box.keyPair();console.log('pub',Buffer.from(kp.publicKey).toString('base64'));console.log('secret',Buffer.from(kp.secretKey).toString('base64'));"
```

Keep the private key only in the API Worker's
`ADDRESS_DECRYPTION_SECRET`. Never ship it to the frontend or Firebase public
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

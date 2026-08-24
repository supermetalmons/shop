# mons.shop

React + TypeScript Solana dapp for mons IRL blind boxes. Box minting is fully
on-chain through the custom box-minter program and MPL Core assets. The browser
uses Firebase Anonymous Auth for identity, while application data remains in
Firestore and all privileged application traffic runs through Cloudflare.

## Architecture

- `mons-shop` is the asset-only frontend Worker for `mons.shop` and
  `www.mons.shop`.
- `mons-shop-api` serves `api.mons.shop`, including inventory, Solana RPC,
  profiles, delivery, claims, Stripe, ShipStation, notifications, admin routes,
  scheduled reconciliation, and Queue consumers.
- Firebase provides Anonymous Auth and Firestore only. Firestore rules, indexes,
  and emulator tests remain part of this repository.
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

The frontend defaults to `https://api.mons.shop` and the committed public
Firebase configuration. Local overrides may be supplied in an uncommitted
`.env` or the invoking shell:

- `VITE_MONS_API_ORIGIN`
- `VITE_FIREBASE_API_KEY`

Never expose a server secret through a `VITE_*` variable.

Useful checks:

```bash
npm run build
npm run check:api
npm run test:firestore-rules
npm run check
```

`npm run check` validates the frontend, API Worker, repository tools, Firestore
rules, dead code, on-chain program, production bundle, generated Worker types,
Wrangler dry runs, and API startup profile. Java is required for the Firestore
Emulator suite, and rules deployment fails closed if that suite cannot run.

## Firebase Auth and Firestore

Firebase Auth tokens remain the browser identity boundary and existing Firebase
UIDs remain compatible with Firestore data. The browser does not write
privileged fulfillment state directly; those operations go through
`mons-shop-api`.

Deploy Firestore indexes and rules from the repository root:

```bash
npm run deploy:firestore
```

That command runs the Firestore Emulator rules suite before deploying indexes
and rules to the `mons-shop` project. Deploy updated rules and indexes before an
API version that depends on them.

## Cloudflare releases

### Frontend Worker

Validate without authenticating:

```bash
npm run deploy -- dry-run
```

Run the complete guarded release:

```bash
npm run deploy -- production
```

Advanced exact-version controls:

```bash
npm run deploy -- preview --token-file /path/to/cloudflare-token
npm run deploy -- production --version-id <uuid> --token-file /path/to/cloudflare-token
npm run release:finalize -- --api-version-id <uuid> --frontend-version-id <uuid> --confirm
npm run release:approve-api-rollback -- --version-id <uuid> --confirm
```

The release uploads and verifies an exact Version Preview, promotes that same
version without rebuilding it, verifies both production domains and the paired
API version, and records evidence in `cloud/release-manifest.json`. Candidate
and evidence records are source-bound. The manifest tracks exact current and
approved rollback API/frontend pairs.

Provide a scoped Cloudflare token through `CLOUDFLARE_API_TOKEN` or the supported
token-file option. The release helper strips local `VITE_*` values and secrets
from build subprocesses.

### API Worker

Run the complete guarded API release:

```bash
npm run deploy:api
```

Advanced exact-version controls:

```bash
npm run deploy:api -- preview --smoke-owner <wallet>
npm run deploy:api -- production --version-id <uuid> --smoke-owner <wallet> [--firestore-writer-service-account-file <path>]
npm run deploy:api -- rollback --version-id <uuid> --smoke-owner <wallet>
npm run benchmark:api -- --api-origin https://api.mons.shop --owner <wallet> --runs 5
```

API releases require `CLOUDFLARE_API_TOKEN` and `HELIUS_API_KEY` in the invoking
environment. On macOS, install the device-local Firestore reader and writer
credentials once with:

```bash
npm run setup:api:firestore-keychain
```

The guarded flow validates the tracked production pair, generated bindings,
tests, dry-run bundle and triggers, exact preview inventory, and production
smokes. Its five-request comparison requires exact inventory IDs to match the
direct Helius reference and requires the Worker median to be faster. Promotion
applies reviewed triggers only to the verified version. Every one-step or
exact-version promotion reruns the exact Stripe, ready-notification, and
pack-status Firestore reconciliation queries after candidate benchmarking and
before production mutation. Production mode reads the writer credential from
Keychain on macOS; the writer-file option is required elsewhere. Exact-version
promotion also requires a clean checkout at the candidate's recorded commit and
the same writer public key that was uploaded with that candidate.

Rollback accepts only the approved API version while its approved frontend is
live. It pauses reveal and Stripe fulfillment delivery, verifies consumers and
the exact pair, rolls back and smokes production, then resumes and verifies the
queues. A failure after resume re-pauses delivery. Scheduled Stripe fulfillment,
pack-status, and ready-notification reconciliation is restored by the next guarded
production release.

### Pack-status D1

The API Worker binds the shared `mons-shop-data` D1 database as `DATA_DB`.
Cloudflare tokens used by API release and migration commands require account-level
D1 Edit permission. The production database was provisioned with the Eastern North
America location hint and no jurisdiction. Copy the returned UUID into the existing
`DATA_DB.database_id` field, and apply the tracked migration before uploading a
Worker version:

```bash
node_modules/.bin/wrangler d1 create mons-shop-data --location enam
node_modules/.bin/wrangler d1 migrations apply mons-shop-data --remote --config cloud/workers/api/wrangler.jsonc
```

The production migration is guarded and reversible:

```bash
npm run migrate:pack-status -- backfill
npm run migrate:pack-status -- verify
npm run migrate:pack-status -- cutover
npm run migrate:pack-status -- rollback
```

`backfill` and `verify` use the device-local Firestore reader credential unless
`--firestore-service-account-file <path>` is supplied. Cutover first requires
exact Firestore/D1 summary and event parity and automatically restores Firestore
reads if any production smoke fails. Firestore remains a dual-write target,
shadow comparison source, and emergency fallback until a separate cleanup.

Before the first direct pack-status projection release, use a maintenance window
that prevents delivery/admin finalization and pauses reveal and Stripe fulfillment
processing. Keep them quiesced through the rebuild and exact-version promotion.

If a Queue-based candidate ever served real delivery traffic, first either drain
its projection jobs with the Queue-capable version and verify their outcomes, or
deliberately discard them and reconcile the affected orders. Finish this before the
authoritative rebuild so no legacy job can apply another delta afterward. Then deploy
the Firestore indexes, rebuild the legacy summaries, and refresh and verify D1:

```bash
npm run deploy:firestore
npm run rebuild-pack-status -- --drop-id card_nft_2 --write
npm run rebuild-pack-status -- --drop-id little_swag_boxes --write
npm run rebuild-pack-status -- --drop-id poncho_drifella --write
npm run migrate:pack-status -- backfill
npm run migrate:pack-status -- verify
```

After verification succeeds, run `npm run deploy:api` while delivery/admin
finalization remains manually paused. The guarded release promotes the exact direct
Worker, applies and verifies its triggers, then resumes reveal and Stripe delivery
for its post-resume smokes. Do not deploy the intermediate Queue-based projector.
Resume delivery/admin finalization only after the guarded command succeeds.

Do not mark every legacy delivery order as projection-pending. Historical summary
rebuilds can include orders without per-order event documents, so replaying those
orders individually can double-count them. New ready orders receive their durable
pending marker atomically and are retried directly by the Worker schedule.

An approved rollback preserves existing direct pending markers but does not process
them. Keep delivery/admin finalization manually paused. The guarded rollback resumes
the Queue-capable reveal and Stripe consumers; use that version to drain or reconcile
legacy Queue work, then explicitly pause those consumers again. If any order was
finalized by the rollback version, restoring forward alone cannot recover it. Restore
the direct version and triggers while producers remain paused, and verify every
existing direct pending marker has settled. Finally rerun the authoritative rebuild,
D1 backfill, and verification above before resuming producers.

`NOTIFICATION_ENQUEUE_SECRET` remains stored only as a Worker secret and is
inherited by uploaded versions. Guarded API releases publish a smoke probe to
the Cloudflare Queue; the Worker signs and forwards the test through its real
enqueue handler with the bound secret. Releases therefore do not retrieve or
locally duplicate the secret. The standalone
notification-smoke command still accepts it from the invoking environment or
root `.env.local`. Never pass it as a command argument, print it, or commit it.

Ready-to-ship email recovery uses the Firestore control document
`workerControls/readyNotifications`. The Worker creates a missing control
automatically with `paused=false`; set its `paused` field to `true` to stop only
ready-notification publication and set it back to `false` after reconciliation.
Do not disable the shared scheduled trigger, which also owns Stripe fulfillment
and pack-status recovery.

Before the first cron-enabled ready-notification release, deploy the Firestore
indexes and audit legacy orders whose buyer or shipper email state is `pending`.
Do not add markers to ready orders that have none. The first publication claim
opens a six-hour retry window, with at most four claims. Legacy pending markers
without that claim metadata, and markers that exhaust either bound, move to
`failed` with `manual-review-required`; do not fabricate claim metadata to replay
them. Reconcile their stored job IDs against Queue and Resend outcomes first,
because a Queue publish may have succeeded before its marker update failed. The
guarded API writer preflight executes the exact recovery queries and blocks
promotion until all of their indexes are available.

Alert on `ready_to_ship_notifications_marker_finalization_failed`. Notification
retries reuse one Resend idempotency key, but Resend retains that key for 24 hours.
If the failure persists, set `workerControls/readyNotifications.paused=true` and
reconcile the logged job IDs and Firestore markers before that provider window
expires. Restore ready-email recovery with `paused=false` after reconciliation.

### Worker secrets

Cloudflare Worker version secrets are the only runtime secret system. Required
bindings include Helius, Firestore service accounts, the cosigner and address
decryption keys, Resend keys, the notification enqueue secret, ShipStation
configuration, and Stripe API and webhook secrets.

Rotate a secret as a new Worker version, then promote only the exact reviewed
combined version through the guarded API release flow:

```bash
node_modules/.bin/wrangler versions secret put <SECRET_NAME> --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Do not store runtime secrets in Firebase configuration, repository files, or
frontend environment variables. `SHIPSTATION_SHIP_FROM` is one JSON object; the
fulfillment workflow treats its Worker secret value as the canonical origin
address.

### Queues and notifications

The API Worker produces and consumes the notification email, reveal
reconciliation, and Stripe fulfillment queues, each with a dead-letter queue.
Stripe reconciliation also runs every five minutes to recover stale marked
checkouts. Queue processing is idempotent and DLQ jobs should be replayed only
after the underlying failure is fixed and the affected jobs are identified.

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

## Operations

The retained tools are intentionally narrow:

- `npm run check-irl-claims` inspects IRL claim state.
- `npm run rebuild-pack-status` rebuilds public pack-status counters and is
  read-only unless its explicit write option is supplied.
- `npm run migrate:pack-status -- <command>` backfills, verifies, cuts over, or
  rolls back the D1 pack-status projection.
- `npm run test-resend-notification-email` sends a synthetic notification through
  the production API queue.
- `npm run wipe-drop` is the guarded drop cleanup utility. Use `--dry-run` to
  preview it; mutation requires interactive confirmation unless `--yes` is
  supplied explicitly.

Repository operations use the Google Cloud Firestore client or Firebase CLI
credentials only to access Firestore. They do not represent an application
runtime.

## Address encryption

Generate a TweetNaCl-compatible Curve25519 keypair and place only the base64
public key in `src/App.tsx` as `ADDRESS_ENCRYPTION_PUBLIC_KEY`:

```bash
node -e "const nacl=require('tweetnacl');const kp=nacl.box.keyPair();console.log('pub',Buffer.from(kp.publicKey).toString('base64'));console.log('secret',Buffer.from(kp.secretKey).toString('base64'));"
```

Keep the private key only in the API Worker's versioned
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

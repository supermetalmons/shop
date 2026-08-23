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
npm run deploy:api -- production --version-id <uuid> --smoke-owner <wallet>
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
applies reviewed triggers only to the verified version.

Rollback accepts only the approved API version while its approved frontend is
live. It pauses reveal and Stripe fulfillment delivery, verifies consumers and
the exact pair, rolls back and smokes production, then resumes and verifies the
queues. A failure after resume re-pauses delivery. Scheduled Stripe
reconciliation is restored by the next guarded production release.

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

`NOTIFICATION_ENQUEUE_SECRET` remains stored only as a Worker secret and is
inherited by uploaded versions. Guarded API releases publish their synthetic
notification directly to the Cloudflare Queue with the scoped API token, so they
do not need to retrieve or locally duplicate the secret. The standalone
notification-smoke command still accepts it from the invoking environment or
root `.env.local`. Never pass it as a command argument, print it, or commit it.

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

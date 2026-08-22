# mons.shop

React + TypeScript Solana dapp for the mons IRL blind boxes. **Box minting is fully on-chain** via a custom Solana program that mints **MPL Core (uncompressed) assets**. Cloud Functions remain for off-chain assignment, receipt issuance, recovery, and Firestore-triggered fulfillment work. Public inventory, pack status, pending-open reads, delivery transaction preparation, authenticated profile and fulfillment actions, and the browser's narrowly scoped Solana RPC traffic go through the dedicated `api.mons.shop` Cloudflare Worker, which keeps provider credentials out of the browser.

## Shared domain core

Runtime-neutral code used by the frontend, Cloud Functions, and repository tools
lives in `functions/src/shared`. Keep Firebase, Node-only, browser/React, Solana
SDK, secrets, and environment access in thin runtime adapters. See
`functions/src/shared/README.md` for the boundary rules.

## Frontend
- Install deps: `npm install`
- Optional frontend env overrides for local development (in your shell, or a local `.env` that you do NOT commit):
  - `VITE_MONS_API_ORIGIN` (defaults to `https://api.mons.shop`)
  - `VITE_FIREBASE_API_KEY`
- If unset, the frontend uses the committed API origin and Firebase public configuration.
- Configure everything else in **committed config**:
  - `src/lib/firebase.ts` (Firebase non-secret config, functions region)
  - `src/App.tsx` (delivery encryption public key)
  - `functions/src/shared/deploymentRegistry.ts` (canonical secret-free drop deployment registry, auto-updated by `npm run deploy-all-onchain`)
  - `src/config/deployment.ts` (frontend projection of the canonical registry; do not add registry rows here)
- Run dev server: `npm run dev`
- Build for production: `npm run build` (outputs `dist/`)

## Deployment
The frontend is an asset-only Cloudflare Worker named `mons-shop`. Public Helius
reads and authenticated profile and fulfillment routes are served by the separate
`mons-shop-api` Worker at `api.mons.shop`.
Firebase, Firestore, and Cloud Functions remain independently deployed to Firebase.

- Prerequisite: Node.js 22.12 or newer.
- Install dependencies: `npm install --legacy-peer-deps`
- Validate the build and Wrangler config without authenticating:
  - `npm run deploy -- dry-run`
- Run the complete guarded frontend release without an intermediate preview command or version argument:
  - `npm run deploy -- production`
  - The command verifies the tracked API/frontend pair, validates and uploads the frontend, smoke-tests its exact Version Preview, promotes only that version, verifies both production domains and the unchanged API version, then updates and commits only `cloud/release-manifest.json`.

Advanced frontend release controls remain available for recovery or separately managed releases:

- Upload a non-production Worker version, smoke-test its exact Version Preview, and write an ignored version-keyed candidate record:
  - `npm run deploy -- preview --token-file /path/to/cloudflare-token`
- Promote or resume an exact candidate, re-verify production, and update and commit the local release manifest:
  - `npm run deploy -- production --version-id <uuid> --token-file /path/to/cloudflare-token`
- Atomically reconcile an already verified API/frontend pair when fresh production evidence exists:
  - `npm run release:finalize -- --api-version-id <uuid> --frontend-version-id <uuid> --confirm`

The token file must contain only a scoped Cloudflare API token. Alternatively,
set `CLOUDFLARE_API_TOKEN` in the invoking shell. The deploy helper strips
Cloudflare credentials and all local `VITE_*` overrides from the Vite build
environment, sets `VITE_BUILD_DATETIME`, and only passes the token to the pinned
local Wrangler process. Deployment builds therefore use the committed Firebase
configuration and API origin; no frontend Worker runtime variables are required.
Never commit the token or expose secrets through a `VITE_*` variable.

### Shop API deployment

The API Worker uses encrypted `HELIUS_API_KEY`, `RESEND_API_KEY`,
`RESEND_CONTACTS_API_KEY`, and `NOTIFICATION_ENQUEUE_SECRET` secrets, the
separate `NOTIFICATION_EMAIL_QUEUE` and `REVEAL_BACKGROUND_QUEUE` producers and
consumers, Smart Placement, and a version-first release flow. It serves
`/auth/solana`, `/profile/reconcile`, `/boxes/reveal`, `/claims/irl/prepare`, `/delivery/prepare`, `/admin/irl-redeem/prepare`, `/checkout/session`, `/webhooks/stripe`, `/inventory`, `/notifications/subscribe`, `/pack-status/:dropId`,
`/pending-open-boxes`, authenticated profile/admin/fulfillment reads,
`/rpc/mainnet-beta`, and `/rpc/devnet`. Browser-facing
responses remain uncached. Pack-status reads use the public Firestore REST API
with a 15-second Cloudflare subrequest cache and support only `card_nft_2`,
`poncho_drifella`, and `little_swag_boxes`.

- Run the complete guarded API release with no intermediate commands or arguments:
  - `npm run deploy:api`
  - This requires `HELIUS_API_KEY` and `CLOUDFLARE_API_TOKEN` in the process environment. It does not read `.env.local` or accept either secret as a command argument.
  - On macOS, install or verify the dedicated Firestore reader and writer credentials once with `npm run setup:api:firestore-keychain`. Release and preview commands read them directly from the device-local Keychain. Paired private JSON file arguments remain available for non-macOS release environments.
  - The command verifies the tracked API/frontend production pair before upload, validates the API, tests an exact Version Preview against devnet inventory, runs the mandatory comparison, promotes only the API version, verifies that the frontend stayed unchanged, and records the new pair.
  - The fulfillment admin wallet is used for smoke requests unless `--smoke-owner` is supplied. The default release requires `clear_cards_devnet_v2` and rejects stale `clear_cards_devnet` inventory.
- Validate code, generated bindings, tests, dry-run bundling, and startup time:
  - `npm run check:api`

Advanced release controls remain available for separately managed releases:

- Upload an undeployed candidate, smoke-test its Version Preview, run the mandatory five-request comparison, and write version-keyed promotion evidence:
  - `npm run deploy:api -- preview --smoke-owner <wallet>`
  - Preview creates the reveal queue and DLQ when they are missing; it does not attach a consumer or enqueue reveal work.
- Re-smoke and repeat the mandatory five-request comparison against that exact Version Preview, apply the reviewed `api.mons.shop` trigger, verify the tracked baseline, promote the exact version, smoke-test production, and write production evidence:
  - `npm run deploy:api -- production --version-id <uuid> --smoke-owner <wallet>`
- Reapply reviewed triggers without changing code:
  - `npm run deploy:api -- triggers --smoke-owner <wallet>`
  - This verifies both queue consumers without pausing or resuming reveal delivery.
- Roll back to the exact approved API version only when the approved frontend is live:
  - `npm run deploy:api -- rollback --version-id <uuid> --smoke-owner <wallet>`
  - The command pauses reveal delivery, verifies the approved pair and both consumers, rolls back and smokes the API, resumes delivery, verifies again, and updates release metadata. Any post-resume failure re-pauses delivery.
- Run the standalone comparison against an explicit origin:
  - `npm run benchmark:api -- --api-origin https://api.mons.shop --owner <wallet> --runs 5`
  - Add `--include-devnet` when the comparison should include both mainnet and devnet inventory.

Preview upload writes `HELIUS_API_KEY` to a newly created mode-`0600` file inside
a mode-`0700` temporary directory, passes that file directly to Wrangler, and
deletes the validated temporary path immediately afterward. The preconfigured
`RESEND_API_KEY`, `RESEND_CONTACTS_API_KEY`, and `NOTIFICATION_ENQUEUE_SECRET` Worker secrets are
preserved across version uploads. The Cloudflare token, Helius secret, and
notification secrets are stripped from all other child-process environment
data and are never printed.

The fulfillment and checkout routes also use `ADDRESS_DECRYPTION_SECRET`, `COSIGNER_SECRET`, `SHIPSTATION_API_KEY`,
`SHIPSTATION_SHIP_FROM`, and the four Stripe API-key secrets. Synchronize their existing Google Secret Manager values
into an undeployed Worker version with `npm run sync:api:firebase-secrets`; the
command uses a temporary mode-`0600` bulk file, verifies production is unchanged,
and removes the file immediately.

The migrated Firebase callables have been retired and must not be restored. Frontend production releases still require authenticated, non-submitting delivery and Admin IRL preparation smokes. Configure `DELIVERY_PREPARE_SMOKE_FIREBASE_TOKEN`, `DELIVERY_PREPARE_SMOKE_OWNER`, `DELIVERY_PREPARE_SMOKE_DROP_ID`, `DELIVERY_PREPARE_SMOKE_ADDRESS_ID`, and `DELIVERY_PREPARE_SMOKE_ITEM_IDS`, plus `ADMIN_IRL_REDEEM_PREPARE_SMOKE_FIREBASE_TOKEN`, `ADMIN_IRL_REDEEM_PREPARE_SMOKE_OWNER`, `ADMIN_IRL_REDEEM_PREPARE_SMOKE_DROP_ID`, and `ADMIN_IRL_REDEEM_PREPARE_SMOKE_ITEM_IDS`. The smokes conditionally remove their exact prepared Firestore records and never submit transactions.

### Notification delivery

Transactional order and manual-review emails are rendered by the three existing
Firebase document triggers, authenticated with `NOTIFICATION_ENQUEUE_SECRET`,
and queued through the internal `mons-shop-api` producer route. `mons-shop-api`
consumes `mons-shop-notification-emails` and sends through Resend from its queue
handler. Failed transient deliveries retry five times before moving to
`mons-shop-notification-emails-dlq`.

- Validate the HTTP and notification handlers, generated bindings, TypeScript,
  unit tests, bundling, and startup together with `npm run check:api`.
- API production releases send a synthetic email through the production queue
  before writing release evidence.
- Queue the synthetic test email through the production API and print its job ID:
  - `npm run test-resend-notification-email -- --kind stripe-manual-review`
- Inspect queue state and live structured logs:
  - `node_modules/.bin/wrangler queues info mons-shop-notification-emails`
  - `node_modules/.bin/wrangler queues info mons-shop-notification-emails-dlq`
  - `node_modules/.bin/wrangler tail mons-shop-api --format json`

Both queues use 24-hour retention to match Resend's idempotency window. Do not
automatically replay the DLQ after that window, and do not restore direct
Firebase delivery while the primary queue contains messages.

Reveal reconciliation uses `mons-shop-reveal-reconciliation` with
`mons-shop-reveal-reconciliation-dlq`. Inspect both queues with `wrangler queues
info <queue>` and inspect the Worker with `wrangler tail mons-shop-api --format
json`. If a job reaches the DLQ, deploy and verify the fix before manually
replaying only the affected jobs; reconciliation is idempotent.

Wrangler can upload a preview version only after the Worker exists.
`mons-shop-api` is already provisioned, so releases can use the preview command directly.

The deployment helpers keep short-lived, exact-version verification records
under the ignored `.cache` directory. Frontend and API candidate records are bound
to the clean Git commit that created them, and production promotion requires that
same clean commit. Promotion never rebuilds the candidate. Guarded resume reruns the frontend
hash checks or API smoke and benchmark before touching triggers or evidence.
Production evidence is written only after both `mons.shop` and `www.mons.shop`
pass their smoke tests. The release finalization command
requires both IDs, matching fresh evidence, and a deliberate `--confirm`; it never
deploys or changes the approved rollback pair.

Production promotion reads the pinned Wrangler's `deployments status --json`
before and after every mutation. It proceeds only from a stable 100% deployment
that matches either the manifest's current production version or the exact
requested candidate. The release creates the reveal queues, pauses reveal
delivery before attaching consumers or promoting, verifies the exact candidate,
then resumes and verifies again. Any failure after resume re-pauses delivery.
Failed releases resume through the same exact candidate or a new fixed candidate.

Tracked production and approved rollback IDs live in `cloud/release-manifest.json`.
API rollback accepts only the approved API version and only while the approved
frontend is live.

To roll back an application version, provide `CLOUDFLARE_API_TOKEN` in the shell,
inspect `node_modules/.bin/wrangler deployments list --config wrangler.jsonc`,
and run `node_modules/.bin/wrangler rollback <known-good-production-version-id> --config wrangler.jsonc`.
Always provide the version ID: a bare rollback can
select a preview-only upload rather than the prior production deployment. The
Amplify app and its CloudFront DNS targets were retired after the migration, so
subsequent application rollbacks must use an explicit Worker version.

Do not restore the former frontend or Functions versions after the fulfillment
callables are retired. Those versions are no longer a compatible production pair.

Pack-status releases must deploy Firestore rules first, then the API Worker, then
the frontend Worker. Roll back in reverse order because the frontend deliberately
has no direct-Firestore fallback. Deploy the prerequisite rules with
`firebase deploy --project mons-shop --only firestore:rules` after the emulator
suite passes.

#### Address encryption key
- Generate a Curve25519 keypair (TweetNaCl-compatible) and copy the base64 public key into `src/App.tsx` (`ADDRESS_ENCRYPTION_PUBLIC_KEY`):
  ```bash
  node -e "const nacl=require('tweetnacl');const kp=nacl.box.keyPair();console.log('pub',Buffer.from(kp.publicKey).toString('base64'));console.log('secret',Buffer.from(kp.secretKey).toString('base64'));"
  ```
- Keep the secret key offline for ops to decrypt shipping addresses; never ship it to the frontend or Firebase config.
- Only the public key is needed by the UI to encrypt addresses before they are stored.

## Firebase functions
- Install and build: `cd functions && npm install && npm run build`
- Deploy from the repo root:
  - `npm run deploy:firebase` runs the Firestore Emulator rules suite, deploys Functions and indexes to `mons-shop`, and then deploys Firestore rules in a separate Firebase CLI invocation.
  - `npm run deploy:functions` deploys Functions only to `mons-shop`.
- The retired profile shipment projection can be removed only with the guarded
  `npm run purge:profile-shipments` command. It defaults to read-only and requires
  the exact observed count plus explicit project confirmation before deleting.
- Java is required for every rules deployment because `npm run test:firestore-rules` fails closed when the Firestore Emulator cannot run.

### Runtime env + secrets
- `HELIUS_API_KEY` (env/runtime config)
- `COSIGNER_SECRET` (Firebase Functions and `mons-shop-api` Worker secret / Google Secret Manager; bs58 secret key for the server cosigner; must match the on-chain box minter admin)
  - Set (recommended): `firebase functions:secrets:set COSIGNER_SECRET`
  - Synchronize to Cloudflare with `npm run sync:api:firebase-secrets` before releasing checkout-session creation.
  - Local dev: set `COSIGNER_SECRET` in your shell (do not commit it in `.env`)
- `STRIPE_RESTRICTED_KEY` or `STRIPE_SECRET_KEY` (Firebase Functions secret or local env; test-mode key used by devnet Checkout Sessions)
  - Set (recommended): `firebase functions:secrets:set STRIPE_RESTRICTED_KEY`
- `STRIPE_RESTRICTED_KEY_LIVE` or `STRIPE_SECRET_KEY_LIVE` (Firebase Functions secret or local env; live-mode key used by mainnet Checkout Sessions)
  - Set (recommended): `firebase functions:secrets:set STRIPE_RESTRICTED_KEY_LIVE`
  - Optional fallback: `firebase functions:secrets:set STRIPE_SECRET_KEY_LIVE`
  - If both are configured, Checkout tries the secret live key first and keeps the restricted live key only as a fallback. Use a Dashboard-created restricted key with Checkout Session permissions; Stripe CLI restricted keys can expire.
- `STRIPE_WEBHOOK_SECRET_DEVNET` (`mons-shop-api` secret for the Stripe test-mode endpoint serving devnet drops)
  - Set or rotate with `wrangler versions secret put STRIPE_WEBHOOK_SECRET_DEVNET --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env`, then promote the resulting combined version through the guarded API release flow.
- `STRIPE_WEBHOOK_SECRET` (`mons-shop-api` secret for the Stripe live endpoint serving mainnet drops)
  - Set or rotate with `wrangler versions secret put STRIPE_WEBHOOK_SECRET --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env`, then promote the resulting combined version through the guarded API release flow.
- `RESEND_API_KEY` (`mons-shop-api` outbound transactional-email secret; use a Resend Sending Access key restricted to `support.mons.shop`)
  - Later API versions inherit it; rotate it as an API Worker secret and promote only the exact reviewed combined version.
- `NOTIFICATION_ENQUEUE_SECRET` (shared HMAC secret for the three Firebase notification producers and the internal `mons-shop-api` queue endpoint)
  - Store the same randomly generated 32-byte value in Firebase Secret Manager and the API Worker's secret set before uploading its candidate. Never pass it as a command argument or print it.
  - The test-email command reads this secret from the shell or Firebase Secret Manager and never accesses the Resend key.
- `RESEND_CONTACTS_API_KEY` (`mons-shop-api` Worker secret used only by `POST /notifications/subscribe`; requires Resend Full Access to manage Contacts)
  - Set or rotate with `wrangler versions secret put RESEND_CONTACTS_API_KEY --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env`, then promote the resulting version through the guarded API release flow.
  - A notification signup directly adds the normalized address to global Resend Contacts without sending a confirmation email. Existing contacts return success without changing their current unsubscribe state.
  - There is deliberately no fallback between the outbound and Contacts keys.
  - Inbound mail for `support.mons.shop` is delivered directly by iCloud and is not handled by Firebase.
- `STRIPE_RETURN_URL_ALLOWED_ORIGINS` (optional comma/space-separated http(s) origins for Stripe success/cancel return URLs beyond `https://mons.shop`, `https://*.mons.shop`, and localhost; useful for preview hosts)
- `ADDRESS_DECRYPTION_SECRET` (Firebase Functions secret or local env; base64 Curve25519 secret key matching the frontend address encryption public key)
  - Reused by fulfillment/admin address decryption and Stripe webhook fulfillment; set with `firebase functions:secrets:set ADDRESS_DECRYPTION_SECRET` only if the Firebase project does not already have it.
  - Stripe webhook fulfillment uses it to encrypt Stripe shipping addresses into the same delivery-order address format.
- `SHIPSTATION_API_KEY` (`mons-shop-api` Worker secret or local env; ShipStation API v2 key used by fulfillment actions, including label purchases)
  - Keep the source value in Google Secret Manager during the initial rollback window; the Firebase callable no longer reads it.
  - Synchronize to Cloudflare with `npm run sync:api:firebase-secrets`.
- `SHIPSTATION_SHIP_FROM` (`mons-shop-api` Worker secret or local env; the origin address as one JSON object, so it can change without a code deploy)
  - Synchronize to Cloudflare with `npm run sync:api:firebase-secrets`.
  - Shape: `{"name":"mons.shop","company_name":"mons.shop","phone":"+1XXXXXXXXXX","address_line1":"1061 10th Street","city_locality":"West Pittsburg","state_province":"PA","postal_code":"16160","country_code":"US","address_residential_indicator":"no"}`
  - The fulfillment page's "Add to ShipStation" button creates a pending shipment with `create_sales_order: true` and no carrier/service, so it lands in ShipStation's Awaiting Shipment tab for the shipper to rate and label. Parcels default to 4 oz per item at 9x12x2 in.
  - Pushes are idempotent per order: the `shipstation.shipmentId` field on the delivery order short-circuits repeats, and `external_shipment_id` (`mons-{dropId}-{deliveryId}`) lets the function re-adopt a shipment created by a call that crashed before recording it.
- `STRIPE_TEST_UNIT_AMOUNT_CENTS` (optional local/env override for devnet test Checkout pricing; defaults to `100`)
- Stripe Checkout is enabled per drop with `stripeCheckoutEnabled`; `card_nft_2` drops default to enabled unless explicitly opted out. Enabled drops must also configure a Stripe product tax code (`stripeProductTaxCode`), and `card_nft_2` drops default to the tangible-goods tax code. Live enabled drops additionally require committed `stripeLiveUnitAmountCents`. `salesMode: 'stripe_receipt_only'` removes the SOL mint surface and requires a reusable receipt pool, `itemsPerBox: 0`, and no mint selection. Publishable Stripe keys are not needed by the current server-created Checkout redirect flow.

Everything else is committed in `functions/src/shared/deploymentRegistry.ts` (auto-updated by the deploy script). `functions/src/config/deployment.ts` projects the server-safe Functions shape from that canonical registry.

Stripe test Checkout only performs a pre-payment availability check; it intentionally does not reserve on-chain supply before payment. If supply sells out before webhook fulfillment, the fulfillment queue/session is marked failed with `manualRefundReviewRequired` and the Stripe `sessionId`/`stripeCheckoutSessionId` can be used for a manual refund in Stripe.

### On-chain + address helpers
- Provision a reusable receipt-only collection and Bubblegum V2 tree:
  - `npm run deploy-receipt-pool -- <poolId> <devnet|mainnet-beta>`
  - Receipt pools are cluster-scoped. The same logical pool id resolves to separate devnet and mainnet collection/tree addresses.
  - Pool metadata, royalties, authority, and tree dimensions are fixed by `scripts/shared/receiptPoolConfig.ts`. Existing pools are validated read-only and are never rewritten for an individual drop.
- Deploy box minter (program + MPL Core collection + config):
  - Prereqs: Solana CLI + Anchor CLI installed; a deploy wallet funded.
  - One-command deploy:
    - `npm run deploy-all-onchain -- <dropId>` (prompts for deployer private key; `dropId` is required)
    - Drop configs live in `scripts/newDrops/` and each file name must match its `dropId`, for example `scripts/newDrops/<dropId>.ts`.
    - To change cluster/RPC, pin an existing MPL-Core collection, or choose whether to reuse the shared program id, edit `NEW_DROP.deploy` in that drop's config file.
    - `NEW_DROP.onchain.metadataBase` accepts either `https://...`, `ipfs://...`, or a raw IPFS CID like `bafy...` (raw CIDs are normalized to canonical `ipfs://CID`).
    - The first compact-metadata drop in a lineage must set `NEW_DROP.deploy.reuseProgramId = false` so existing legacy `/json/...` drops keep their current program binary. Later compact drops can reuse that fresh lineage with `reuseProgramId = true`; set `reuseProgramIdFromDropId` when you want to pin reuse to a specific deployed drop's program id. Reused drops skip program build/deploy entirely; use `npm run upgrade-onchain -- <dropId>` for intentional program upgrades.
    - Fresh dedicated MPL-Core collections use the deployer/admin wallet as root update authority for marketplace verification, with the program config PDA added as an UpdateDelegate for on-chain mint/reveal CPIs.
    - Receipt-only pooled drops deliberately do not add their config PDA as a collection delegate. Admin receipt delivery remains authorized by the fixed pool authority while direct SOL mint attempts fail atomically.
  - Updates one tracked registry:
    - `functions/src/shared/deploymentRegistry.ts` (canonical secret-free superset)
    - `src/config/deployment.ts` and `functions/src/config/deployment.ts` are compatibility projections and are not rewritten per drop.
  - Prints remaining required config keys (does **not** print `COSIGNER_SECRET`).
- Single-master-key mode: the deploy/admin keypair is also the delivery treasury/vault (no separate vault keypair).
- Card NFT Binder deployment order:
  - Devnet: `npm run deploy-receipt-pool -- mons_shop_receipts devnet`, then `npm run deploy-all-onchain -- card_nft_binder_devnet`
  - Mainnet after devnet acceptance: `npm run deploy-receipt-pool -- mons_shop_receipts mainnet-beta`, then `npm run deploy-all-onchain -- card_nft_binder`
  - Deploy Functions and the web app before running `npm run start-mint -- <dropId>` as the final go-live action.
- Upgrade an existing box minter program:
  - `npm run upgrade-onchain -- <dropId>` builds the program for the deployed program id in the canonical `functions/src/shared/deploymentRegistry.ts`, verifies the current upgrade authority, prompts for that private key, deploys the upgrade, then dumps the deployed binary to verify its hash.
  - Rehearse with the devnet drop id first, for example `npm run upgrade-onchain -- little_swag_hoodies_devnet`, then run the corresponding mainnet drop id.
  - Use `--dry-run` to build and compare hashes without prompting or sending transactions.

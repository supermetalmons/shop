# mons.shop

React + TypeScript Solana dapp for the mons IRL blind boxes. **Box minting is fully on-chain** via a custom Solana program that mints **MPL Core (uncompressed) assets**. Cloud Functions are used for flows that require off-chain coordination (open box assignments, delivery order pricing, IRL claim locking). Inventory is fetched client-side via Helius DAS.

## Shared domain core

Runtime-neutral code used by the frontend, Cloud Functions, and repository tools
lives in `functions/src/shared`. Keep Firebase, Node-only, browser/React, Solana
SDK, secrets, and environment access in thin runtime adapters. See
`functions/src/shared/README.md` for the boundary rules.

## Frontend
- Install deps: `npm install`
- Optional env overrides for the frontend's public client-side API keys (local dev: in your shell, or a local `.env` that you do NOT commit):
  - `VITE_HELIUS_API_KEY`
  - `VITE_FIREBASE_API_KEY`
- If unset, the frontend falls back to the bundled defaults in `src/lib/helius.ts` and `src/lib/firebase.ts`.
- Configure everything else in **committed config**:
  - `src/lib/firebase.ts` (Firebase non-secret config, functions region)
  - `src/App.tsx` (delivery encryption public key)
  - `functions/src/shared/deploymentRegistry.ts` (canonical secret-free drop deployment registry, auto-updated by `npm run deploy-all-onchain`)
  - `src/config/deployment.ts` (frontend projection of the canonical registry; do not add registry rows here)
- Run dev server: `npm run dev`
- Build for production: `npm run build` (outputs `dist/`)

## Deployment
The frontend is an asset-only Cloudflare Worker named `mons-shop`. Firebase,
Firestore, and Cloud Functions remain independently deployed to Firebase.

- Prerequisite: Node.js 22.12 or newer.
- Install dependencies: `npm install --legacy-peer-deps`
- Validate the build and Wrangler config without authenticating:
  - `npm run deploy -- dry-run`
- Upload a non-production Worker version with the `candidate` preview alias:
  - `npm run deploy -- preview --token-file /path/to/cloudflare-token`
- Build and deploy to `mons.shop` and `www.mons.shop`:
  - `npm run deploy -- production --token-file /path/to/cloudflare-token`

The token file must contain only a scoped Cloudflare API token. Alternatively,
set `CLOUDFLARE_API_TOKEN` in the invoking shell. The deploy helper strips
Cloudflare credentials and all local `VITE_*` overrides from the Vite build
environment, sets `VITE_BUILD_DATETIME`, and only passes the token to the pinned
local Wrangler process. Deployment builds therefore use the committed Firebase
and Helius client fallbacks; no Worker runtime variables are required. Never
commit the token or expose it through a `VITE_*` variable.

Wrangler can upload a preview version only after the Worker exists. The
`mons-shop` Worker was bootstrapped once without routes during this migration;
subsequent releases can use the preview command directly.

To roll back an application version, provide `CLOUDFLARE_API_TOKEN` in the shell,
inspect `node_modules/.bin/wrangler deployments list --config wrangler.jsonc`,
and run `node_modules/.bin/wrangler rollback <known-good-production-version-id> --config wrangler.jsonc`.
Always provide the version ID: a bare rollback can
select a preview-only upload rather than the prior production deployment. The
Amplify app and its CloudFront DNS targets were retired after the migration, so
subsequent application rollbacks must use an explicit Worker version.

For a coordinated application and Firebase rollback, restore the frontend Worker
before deploying older Functions or Firestore rules. A newer frontend can depend
on backend authentication and read contracts that older Firebase releases do not
provide.

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
- Verify the production profile shipment projection with `npm run verify:profile-shipments`. The command is read-only, runs independently of deployment, and exits nonzero if it detects drift.
  - Application Default Credentials must be authorized for `mons-shop`.
  - If the combined source and projection collections exceed 20,000 documents, pass `--max-audit-documents <count>` up to 50,000 after confirming the expected collection size.
- Java is required for every rules deployment because `npm run test:firestore-rules` fails closed when the Firestore Emulator cannot run.

### Function env + secrets
- `HELIUS_API_KEY` (env/runtime config)
- `COSIGNER_SECRET` (Firebase Functions secret / Google Secret Manager; bs58 secret key for the server cosigner; must match the on-chain box minter admin)
  - Set (recommended): `firebase functions:secrets:set COSIGNER_SECRET`
  - Local dev: set `COSIGNER_SECRET` in your shell (do not commit it in `.env`)
- `STRIPE_RESTRICTED_KEY` or `STRIPE_SECRET_KEY` (Firebase Functions secret or local env; test-mode key used by devnet Checkout Sessions)
  - Set (recommended): `firebase functions:secrets:set STRIPE_RESTRICTED_KEY`
- `STRIPE_RESTRICTED_KEY_LIVE` or `STRIPE_SECRET_KEY_LIVE` (Firebase Functions secret or local env; live-mode key used by mainnet Checkout Sessions)
  - Set (recommended): `firebase functions:secrets:set STRIPE_RESTRICTED_KEY_LIVE`
  - Optional fallback: `firebase functions:secrets:set STRIPE_SECRET_KEY_LIVE`
  - If both are configured, Checkout tries the secret live key first and keeps the restricted live key only as a fallback. Use a Dashboard-created restricted key with Checkout Session permissions; Stripe CLI restricted keys can expire.
- `STRIPE_WEBHOOK_SECRET_DEVNET` (Firebase Functions secret or local env; Stripe test-mode endpoint signing secret for devnet drops handled by `stripeWebhook`)
  - Set: `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET_DEVNET`
- `STRIPE_WEBHOOK_SECRET` (Firebase Functions secret or local env; Stripe live/production endpoint signing secret for mainnet drops handled by `stripeWebhook`)
  - Set: `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY` (Firebase Functions secret used only for outbound notifications; use a Resend Sending Access key restricted to `support.mons.shop`)
  - Set: `firebase functions:secrets:set RESEND_API_KEY`
- `RESEND_CONTACTS_API_KEY` (Firebase Functions secret used only by `subscribeToNotifications`; requires Resend Full Access to manage Contacts)
  - Set: `firebase functions:secrets:set RESEND_CONTACTS_API_KEY`
  - A notification signup directly adds the normalized address to global Resend Contacts without sending a confirmation email. Existing contacts return success without changing their current unsubscribe state.
  - There is deliberately no fallback between the outbound and Contacts keys.
  - Inbound mail for `support.mons.shop` is delivered directly by iCloud and is not handled by Firebase.
- `STRIPE_RETURN_URL_ALLOWED_ORIGINS` (optional comma/space-separated http(s) origins for Stripe success/cancel return URLs beyond `https://mons.shop`, `https://*.mons.shop`, and localhost; useful for preview hosts)
- `ADDRESS_DECRYPTION_SECRET` (Firebase Functions secret or local env; base64 Curve25519 secret key matching the frontend address encryption public key)
  - Reused by fulfillment/admin address decryption and Stripe webhook fulfillment; set with `firebase functions:secrets:set ADDRESS_DECRYPTION_SECRET` only if the Firebase project does not already have it.
  - Stripe webhook fulfillment uses it to encrypt Stripe shipping addresses into the same delivery-order address format.
- `SHIPSTATION_API_KEY` (Firebase Functions secret or local env; ShipStation API v2 key used by `addFulfillmentOrderToShipStation`)
  - Set: `firebase functions:secrets:set SHIPSTATION_API_KEY`
- `SHIPSTATION_SHIP_FROM` (Firebase Functions secret or local env; the origin address as one JSON object, so it can change without a code deploy)
  - Set: `firebase functions:secrets:set SHIPSTATION_SHIP_FROM`
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

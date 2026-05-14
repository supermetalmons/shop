# mons.shop

React + TypeScript Solana dapp for the mons IRL blind boxes. **Box minting is fully on-chain** via a custom Solana program that mints **MPL Core (uncompressed) assets**. Cloud Functions are used for flows that require off-chain coordination (open box assignments, delivery order pricing, IRL claim locking). Inventory is fetched client-side via Helius DAS.

## Frontend
- Install deps: `npm install`
- Optional env overrides for the frontend's public client-side API keys (local dev: in your shell, or a local `.env` that you do NOT commit):
  - `VITE_HELIUS_API_KEY`
  - `VITE_FIREBASE_API_KEY`
- If unset, the frontend falls back to the bundled defaults in `src/lib/helius.ts` and `src/lib/firebase.ts`.
- Configure everything else in **committed config**:
  - `src/lib/firebase.ts` (Firebase non-secret config, functions region)
  - `src/App.tsx` (delivery encryption public key)
  - `src/config/deployment.ts` (drop-specific frontend deployment config, auto-updated by `npm run deploy-all-onchain`)
- Run dev server: `npm run dev`
- Build for production: `npm run build` (outputs `dist/`)

## Deployment
The frontend is a static Vite build (`dist/`). Deploy it to any static host (Amplify, Netlify, Vercel, S3/CloudFront, etc). The two env vars above are optional overrides; everything else is in committed config.

### Deploy to Amplify
- Set Amplify branch env vars if you want to override the bundled frontend API-key defaults:
  - `VITE_HELIUS_API_KEY`
  - `VITE_FIREBASE_API_KEY`
- Deploy: `npm run deploy -- <branch>`
  - Dry run (prints keys only): `npm run deploy -- <branch> --dry-run`
  - Wait for the Amplify job to finish: `npm run deploy -- <branch> --wait`

#### Address encryption key
- Generate a Curve25519 keypair (TweetNaCl-compatible) and copy the base64 public key into `src/App.tsx` (`ADDRESS_ENCRYPTION_PUBLIC_KEY`):
  ```bash
  node -e "const nacl=require('tweetnacl');const kp=nacl.box.keyPair();console.log('pub',Buffer.from(kp.publicKey).toString('base64'));console.log('secret',Buffer.from(kp.secretKey).toString('base64'));"
  ```
- Keep the secret key offline for ops to decrypt shipping addresses; never ship it to the frontend or Firebase config.
- Only the public key is needed by the UI to encrypt addresses before they are stored.

## Firebase functions
- Install and build: `cd functions && npm install && npm run build`
- Deploy (from repo root):
  - `npm run deploy:firebase` (rules + functions)
  - `npm run deploy:functions` (functions only)

### Function env + secrets
- `HELIUS_API_KEY` (env/runtime config)
- `COSIGNER_SECRET` (Firebase Functions secret / Google Secret Manager; bs58 secret key for the server cosigner; must match the on-chain box minter admin)
  - Set (recommended): `firebase functions:secrets:set COSIGNER_SECRET`
  - Local dev: set `COSIGNER_SECRET` in your shell (do not commit it in `.env`)
- `STRIPE_RESTRICTED_KEY` or `STRIPE_SECRET_KEY` (Firebase Functions secret or local env; used by devnet test Checkout Sessions)
  - Set (recommended): `firebase functions:secrets:set STRIPE_RESTRICTED_KEY`
- `STRIPE_TEST_UNIT_AMOUNT_CENTS` (optional local/env override for devnet test Checkout pricing; defaults to `100`)

Everything else is committed in `functions/src/config/deployment.ts` (auto-updated by the deploy script).

### On-chain + address helpers
- Deploy box minter (program + MPL Core collection + config):
  - Prereqs: Solana CLI + Anchor CLI installed; a deploy wallet funded.
  - One-command deploy:
    - `npm run deploy-all-onchain -- <dropId>` (prompts for deployer private key; `dropId` is required)
    - Drop configs live in `scripts/newDrops/` and each file name must match its `dropId`, for example `scripts/newDrops/<dropId>.ts`.
    - To change cluster/RPC, pin an existing MPL-Core collection, or choose whether to reuse the shared program id, edit `NEW_DROP.deploy` in that drop's config file.
    - `NEW_DROP.onchain.metadataBase` accepts either `https://...`, `ipfs://...`, or a raw IPFS CID like `bafy...` (raw CIDs are normalized to canonical `ipfs://CID`).
    - The first compact-metadata drop in a lineage must set `NEW_DROP.deploy.reuseProgramId = false` so existing legacy `/json/...` drops keep their current program binary. Later compact drops can reuse that fresh lineage with `reuseProgramId = true`.
    - Fresh MPL-Core collections use the deployer/admin wallet as root update authority for marketplace verification, with the program config PDA added as an UpdateDelegate for on-chain mint/reveal CPIs.
  - Updates tracked config files:
    - `src/config/deployment.ts` (frontend)
    - `functions/src/config/deployment.ts` (cloud functions)
  - Prints remaining required config keys (does **not** print `COSIGNER_SECRET`).
- Single-master-key mode: the deploy/admin keypair is also the delivery treasury/vault (no separate vault keypair).
- Upgrade an existing box minter program:
  - `npm run upgrade-onchain -- <dropId>` builds the program for the deployed program id in `src/config/deployment.ts`, verifies the current upgrade authority, prompts for that private key, deploys the upgrade, then dumps the deployed binary to verify its hash.
  - Rehearse with the devnet drop id first, for example `npm run upgrade-onchain -- little_swag_hoodies_devnet`, then run the corresponding mainnet drop id.
  - Use `--dry-run` to build and compare hashes without prompting or sending transactions.

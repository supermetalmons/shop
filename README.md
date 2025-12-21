# mons.shop

React + TypeScript Solana dapp for the mons IRL blind boxes. **Box minting is fully on-chain** via a custom Solana program that mints **MPL Core (uncompressed) assets**. Cloud Functions are used for flows that require off-chain coordination (open box assignments, delivery order pricing, IRL claim locking). Inventory is fetched client-side via Helius DAS.

Default mint params (configurable at deploy): **max 333 boxes**, **0.001 SOL per box**, **max 15 per tx**.

## Frontend
- Install deps: `npm install`
- Configure **secrets via env only** (local dev: in your shell, or a local `.env` that you do NOT commit):
  - `VITE_HELIUS_API_KEY`
  - `VITE_FIREBASE_API_KEY`
- Configure everything else in **committed config**:
  - `src/config/deployment.ts` (Firebase non-secret config, delivery encryption public key)
  - `src/config/deployed.ts` (auto-updated by `npm run box-minter:deploy-all`)
- Run dev server: `npm run dev`
- Build for production: `npm run build` (outputs `dist/`)

## Deployment
The frontend is a static Vite build (`dist/`). Deploy it to any static host (Amplify, Netlify, Vercel, S3/CloudFront, etc). Only the two env vars above are required at build time; everything else is in committed config.

### Deploy to Amplify
- Set Amplify branch env vars:
  - `VITE_HELIUS_API_KEY`
  - `VITE_FIREBASE_API_KEY`
- Deploy: `npm run deploy -- <branch>`
  - Dry run (prints keys only): `npm run deploy -- <branch> --dry-run`
  - Wait for the Amplify job to finish: `npm run deploy -- <branch> --wait`

#### Address encryption key
- Generate a Curve25519 keypair (TweetNaCl-compatible) and copy the base64 public key into `src/config/deployment.ts` (`addressEncryptionPublicKey`):
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

### Function env (set as runtime config or shell env)
- `HELIUS_API_KEY`
- `COSIGNER_SECRET` (bs58 secret key for the server cosigner; must match the on-chain box minter admin)

Everything else is committed in `functions/src/config/deployment.ts` (auto-updated by the deploy script).

### On-chain + address helpers
- Deploy box minter (program + MPL Core collection + config):
  - Prereqs: Solana CLI + Anchor CLI installed; a deploy wallet funded.
  - One-command deploy (auto-generates a fresh program id each run):
    - `npm run box-minter:deploy-all -- --cluster devnet --keypair ~/.config/solana/id.json --rpc https://api.devnet.solana.com --core-collection <MPL_CORE_COLLECTION_PUBKEY>`
  - Reuse the existing program id/keypair (upgrade in-place): add `--reuse-program-id` (skips init if the config PDA already exists).
  - Updates tracked config files:
    - `src/config/deployed.ts` (frontend)
    - `functions/src/config/deployment.ts` (cloud functions)
  - Prints remaining required env secrets (including `COSIGNER_SECRET`, which is sensitive).
- Single-master-key mode: the deploy/admin keypair is also the delivery treasury/vault (no separate vault keypair).
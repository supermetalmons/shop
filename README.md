# mons.shop

React + TypeScript Solana dapp for the mons IRL blind boxes. **Box minting is fully on-chain** via a custom Solana program that mints **MPL Core (uncompressed) assets**. Cloud Functions are used for flows that require off-chain coordination (open box assignments, delivery order pricing, IRL claim locking). Inventory is fetched client-side via Helius DAS.

Default mint params (configurable at deploy): **max 333 boxes**, **0.001 SOL per box**, **max 15 per tx**.

## Frontend
- Install deps: `npm install`
- Copy `.env.example` to `.env` and fill values (RPC, Firebase config, functions base URL, encryption pubkey, secondary links).
- Run dev server: `npm run dev`
- Build for production: `npm run build`

### Deploy to Amplify (sync `.env` → Amplify branch env vars)
- Prereqs: AWS CLI configured locally with permissions to `amplify:GetBranch`, `amplify:UpdateBranch`, and `amplify:StartJob`.
- Set `AMPLIFY_APP_ID` (and optionally `AMPLIFY_REGION`, `AWS_PROFILE`) in your shell or in `.env`.
- Push your branch (Amplify builds from the connected git repo).
- Deploy: `npm run deploy -- <branch>`
  - Dry run (prints keys only): `npm run deploy -- <branch> --dry-run`
  - Wait for the Amplify job to finish: `npm run deploy -- <branch> --wait`
- Note: this **replaces** the Amplify branch env vars with **all non-reserved keys** from `.env`. For Vite, anything referenced in client code can end up in the public bundle—don’t put secrets in `.env`.

### Required Vite env
```
VITE_SOLANA_CLUSTER=devnet|testnet|mainnet-beta
VITE_RPC_URL=https://your-rpc
VITE_HELIUS_API_KEY=<helius-api-key>
VITE_BOX_MINTER_PROGRAM_ID=<deployed box minter program id>
VITE_FIREBASE_*=...
VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY=<base64 curve25519 pubkey for delivery encryption>
```
- Required: `VITE_COLLECTION_MINT` (MPL-Core collection address for Helius `grouping: ['collection', ...]` queries)

#### Address encryption key
- Generate a Curve25519 keypair (TweetNaCl-compatible) and copy the base64 public key into `VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY`:
  ```bash
  node -e "const nacl=require('tweetnacl');const kp=nacl.box.keyPair();console.log('pub',Buffer.from(kp.publicKey).toString('base64'));console.log('secret',Buffer.from(kp.secretKey).toString('base64'));"
  ```
- Keep the secret key offline for ops to decrypt shipping addresses; never ship it to the frontend or Firebase config.
- Only the public key is needed by the UI to encrypt addresses before they are stored.

## Firebase functions
- Install and build: `cd functions && npm install && npm run build`
- Set env vars (see `deployment-plan.md`), then deploy: `firebase deploy --only firestore:rules,functions`
- Emulate locally with `firebase emulators:start --only functions,firestore`.
- Firestore rules live in `firestore.rules` (profiles+addresses are user-restricted, everything else locked down).

### Function env (set as runtime config or shell env)
- `BOX_MINTER_PROGRAM_ID` (same program id as `VITE_BOX_MINTER_PROGRAM_ID`)
- `HELIUS_API_KEY`
- `SOLANA_CLUSTER` (`devnet`/`testnet`/`mainnet-beta`)
- `COSIGNER_SECRET` (bs58 secret key for the server cosigner; must match the on-chain box minter admin)
- `COLLECTION_MINT` (MPL-Core collection address for this drop)
- `DELIVERY_VAULT` (SOL recipient for shipping)
- `METADATA_BASE` (drop base URI, e.g. `https://assets.mons.link/shop/drops/1` with `collection.json`, `json/boxes`, `json/figures`, `json/receipts`)

### What the functions do
- `solanaAuth`: SIWS message verification → Firebase custom token + profile + saved addresses.
- `saveAddress`: stores an encrypted address blob + country/label under the wallet.
- `prepareOpenBoxTx`: burns a box Core asset and mints 3 figure Core assets; assigns dudes deterministically per box.
- `prepareDeliveryTx`: validates requested items + address, allocates a compact on-chain delivery id + fee, builds a single-instruction `deliver` tx (fee + transfers + delivery record PDA), and cosigns it server-side.
- `prepareIrlClaimTx`: validates IRL claim code + box receipt ownership, then prepares a `mint_receipts` tx (figure receipts) and cosigns it.

### On-chain + address helpers
- Deploy box minter (program + MPL Core collection + config):
  - Prereqs: Solana CLI + Anchor CLI installed; a deploy wallet funded.
  - One-command deploy (auto-generates a fresh program id each run):
    - `npm run box-minter:deploy-all -- --cluster devnet --keypair ~/.config/solana/id.json --rpc https://api.devnet.solana.com --core-collection <MPL_CORE_COLLECTION_PUBKEY>`
  - Reuse the existing program id/keypair (upgrade in-place): add `--reuse-program-id` (skips init if the config PDA already exists).
  - Prints both frontend + functions env values (including `COSIGNER_SECRET`, which is sensitive).
- Generate a delivery vault keypair: `npm run keygen` (prints public key and base58 + JSON secrets).

## Notes
- If you see an Apple Silicon error like `You installed esbuild for another platform than the one you're currently using` (e.g. `@esbuild/darwin-x64` vs `@esbuild/darwin-arm64`), your `node_modules` were installed under the wrong architecture (often via Rosetta). Fix with a clean reinstall under the same arch you run Node with:
  - `node -p process.arch` (should match `uname -m`)
  - `rm -rf node_modules package-lock.json && npm install`
  - If you also run Cloud Functions locally, repeat inside `functions/`: `cd functions && rm -rf node_modules package-lock.json && npm install`
- If `anchor build` fails with `lock file version 4 requires -Znext-lockfile-bump`, delete `onchain/Cargo.lock` and re-run. The bundled Cargo in Solana/Anchor toolchains can’t parse v4 lockfiles.
- Supply is capped on-chain by the box minter config PDA (default deploy script: 333 boxes → 999 dudes).
- Delivery addresses are encrypted client-side with TweetNaCl; only country + label are stored in clear.
- Secondary links & email form swap in automatically once the drop is minted out.

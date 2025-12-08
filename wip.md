## 1) Solana setup (collection, cNFT tree, vault)
All commands run from repo root unless noted.

1. Pick a cluster and fund the payer keypair:
   ```bash
   # example
   solana config set --url https://api.devnet.solana.com
   solana airdrop 2
   ```
2. Create the collection (or derive PDAs from an existing mint):
   - Mint a new collection NFT:
     ```bash
     npm run collection:create -- \
       --cluster devnet \
       --keypair ~/.config/solana/id.json \
       --name "test boxes" \
       --symbol testboxes \
       --uri https://assets.mons.link/collection.json
     ```
     Outputs: `COLLECTION_MINT`, `COLLECTION_METADATA`, `COLLECTION_MASTER_EDITION`, `COLLECTION_UPDATE_AUTHORITY`.
   - If a collection mint already exists: `npm run tree:derive-collection -- --mint <mint> [--authority <update-auth-pubkey>]`.
3. Create the Bubblegum Merkle tree (defaults depth 14 / buffer 64):
   ```bash
   npm run tree:create -- \
     --cluster devnet \
     --keypair ~/.config/solana/id.json \
     --depth 14 --buffer 64 --canopy 0 \
     --rpc https://api.devnet.solana.com
   ```
   Outputs: `MERKLE_TREE` and `TREE_AUTHORITY_SECRET` (bs58 of payer secret). Keep the secret safe; it signs every mint/burn.
4. Generate the shipping vault:
   ```bash
   npm run keygen
   ```
   Output: `DELIVERY_VAULT` (public key) and the private key (store securely).
5. Decide supplies & metadata:
   - `METADATA_BASE` should host `box.json`, `dude/<id>.json`, `certificate/...`.
   - `TEST_SUPPLY` (dev/test, default 11) and `TOTAL_SUPPLY` (prod, default 333).
6. Optional cosigner: set `COSIGNER_SECRET` (bs58) if you want a separate key from the tree authority.

Record all outputs for the function environment in step 2.

## 2) Function runtime environment
Use `functions/.env.example` as the template for both local emulation and deployment. Copy and fill it:
```bash
cd functions
cp .env.example .env.local   # for emulators
cp .env.example .env.deploy  # for deployment; edit with real values
```
Keys in the template:
- `HELIUS_API_KEY`
- `SOLANA_CLUSTER` (devnet|testnet|mainnet-beta)
- `SOLANA_RPC_URL` (match the cluster; can be Helius RPC)
- `MERKLE_TREE`
- `TREE_AUTHORITY_SECRET`
- `COSIGNER_SECRET` (optional, defaults to tree authority if left blank)
- `COLLECTION_MINT`
- `COLLECTION_METADATA`
- `COLLECTION_MASTER_EDITION`
- `COLLECTION_UPDATE_AUTHORITY`
- `DELIVERY_VAULT`
- `METADATA_BASE`
- `TEST_SUPPLY` (dev cap) and `TOTAL_SUPPLY` (prod cap)

Push the filled deployment file to Cloud Functions env vars (2nd-gen):
```bash
cd functions
xargs -a .env.deploy firebase functions:env:set
# Optional: firebase functions:secrets:set HELIUS_API_KEY
```

## 3) Firebase services deployment
1. Point CLI at the project: `firebase use <project-id>`.
2. Deploy Firestore rules: `firebase deploy --only firestore:rules`.
3. Build and deploy functions:
   ```bash
   cd functions
   npm run build
   firebase deploy --only functions
   ```
   Functions default to `us-central1`; base URL: `https://us-central1-<project-id>.cloudfunctions.net`.
4. Optional local test: `firebase emulators:start --only functions,firestore` (ensure env vars are set).

## 4) Frontend configuration & hosting
1. Create `.env` in repo root:
   ```
   VITE_SOLANA_CLUSTER=devnet
   VITE_RPC_URL=https://api.devnet.solana.com
   VITE_FUNCTIONS_BASE_URL=https://us-central1-<project-id>.cloudfunctions.net
   VITE_FIREBASE_API_KEY=<api-key>
   VITE_FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=<project-id>
   VITE_FIREBASE_STORAGE_BUCKET=<project-id>.appspot.com
   VITE_FIREBASE_MESSAGING_SENDER_ID=<sender-id>
   VITE_FIREBASE_APP_ID=<app-id>
   VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY=<base64 curve25519 pubkey>
   VITE_SECONDARY_TENSOR=<tensor-url>
   VITE_SECONDARY_MAGICEDEN=<magic-eden-url>
   ```
2. Run locally: `npm run dev`.
3. Build: `npm run build` (outputs to `dist/`).
4. Deploy the static site with your provider:
   - AWS Amplify is pre-configured via `amplify.yml` (serves `dist/`).
   - Any static host works (Netlify/Vercel/Firebase Hosting); ensure env vars are set in that platform.

## 5) End-to-end smoke test (after deploy)
1. Connect a funded wallet on the chosen cluster.
2. Sign in (wallet message) → verify profile created in Firestore.
3. Mint a small quantity (≤20) → call `/prepareMintTx`, sign & submit → call `/finalizeMintTx`, confirm mint stats increments.
4. Open one box via `/prepareOpenBoxTx` → sign → inventory shows 3 dudes.
5. Save an encrypted address → request delivery for 1–2 items → sign `/prepareDeliveryTx` tx (burn + certificates) → finalize `/finalizeDeliveryTx` and confirm Firestore `deliveryOrders`.
6. Create a claim code via delivery, then test `/prepareIrlClaimTx` + `/finalizeClaimTx` with the same wallet and certificate present.

## 6) Production cutover checklist
- Switch `SOLANA_CLUSTER`, `SOLANA_RPC_URL`, `TOTAL_SUPPLY`, metadata base, and any secondary links to mainnet values.
- Re-run collection/tree/vault steps on mainnet; update function env vars accordingly.
- Fund the tree authority and shipping vault with sufficient SOL.
- Monitor Helius usage/limits; set alerts.
- Rotate keys: keep `TREE_AUTHORITY_SECRET`, `COSIGNER_SECRET`, and `DELIVERY_VAULT` secrets offline/backed up.


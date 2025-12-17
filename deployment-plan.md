# Deployment Plan

Step-by-step guide to ship mons.shop end-to-end (Solana + Firebase Cloud Functions + frontend).

## Prerequisites
- Tooling: Node 20+, npm, `firebase-tools` (latest), Solana CLI, and `tsx` is installed via dev deps.
- Accounts/keys: Firebase project with billing enabled (functions call external APIs), funded Solana keypair on the target cluster (devnet/testnet/mainnet-beta), Helius API key, RPC URL (can be Helius), address-encryption Curve25519 public key (see README snippet), hosting for drop metadata (`METADATA_BASE`, e.g. `https://assets.mons.link/shop/drops/1`), and a place to host the built web app (Amplify/Netlify/Vercel/etc.).
- Clone & install:
  ```bash
  cd /Users/ivan/.cursor/worktrees/shop/oov
  npm install
  cd functions && npm install
  ```

## 1) Solana setup (box minter program, collection, cNFT tree, vault)
All commands run from repo root unless noted.

1. Pick a cluster and fund the payer keypair:
   ```bash
   # example
   solana config set --url https://api.devnet.solana.com
   solana airdrop 2
   ```
2. Deploy the **box minter program** (Anchor) + create collection + create cNFT tree + configure delegation:
   - One-command deploy (auto-generates a fresh program id each run):
     ```bash
     npm run box-minter:deploy-all -- \
       --cluster devnet \
       --keypair ~/.config/solana/id.json \
       --rpc https://api.devnet.solana.com
     ```
   - Reuse the existing program id/keypair (upgrade in-place): add `--reuse-program-id`
   Outputs: `VITE_BOX_MINTER_PROGRAM_ID`, `VITE_COLLECTION_MINT`, `VITE_MERKLE_TREE` (frontend env).

3. (Optional / legacy) Create a separate Merkle tree for Cloud Functions mint flows:
   ```bash
   npm run tree:create -- \
     --cluster devnet \
     --keypair ~/.config/solana/id.json \
     --depth 14 --buffer 64 --canopy 0 \
     --rpc https://api.devnet.solana.com
   ```
   Outputs: `MERKLE_TREE` and `TREE_AUTHORITY_SECRET` (bs58 of payer secret).
4. Generate the shipping vault:
   ```bash
   npm run keygen
   ```
   Output: `DELIVERY_VAULT` (public key) and the private key (store securely).
5. Decide supplies & metadata:
   - Box minting parameters are set by `box-minter:deploy` (defaults: max supply 333, price 0.001 SOL, max 15/tx).
   - `METADATA_BASE` should host the drop under one root (used by Cloud Functions for open/delivery/claim), e.g. `https://assets.mons.link/shop/drops/1`.
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
- `MERKLE_TREE`
- `TREE_AUTHORITY_SECRET`
- `COSIGNER_SECRET` (optional, defaults to tree authority if left blank)
- `COLLECTION_MINT`
- `COLLECTION_METADATA`
- `COLLECTION_MASTER_EDITION`
- `COLLECTION_UPDATE_AUTHORITY`
- `DELIVERY_VAULT`
- `METADATA_BASE`
- `TOTAL_SUPPLY` (default 333; global cap)

Push the filled deployment file to Cloud Functions env vars (2nd-gen). Requires `firebase-tools` with `functions:env:*` support (update with `npm i -g firebase-tools@latest` if the command is missing):
```bash
cd functions
xargs -L1 firebase functions:env:set < .env.deploy
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
   VITE_FIREBASE_API_KEY=<api-key>
   VITE_FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=<project-id>
   VITE_FIREBASE_STORAGE_BUCKET=<project-id>.appspot.com
   VITE_FIREBASE_MESSAGING_SENDER_ID=<sender-id>
   VITE_FIREBASE_APP_ID=<app-id>
   VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY=<base64 curve25519 pubkey>
   ```
2. Run locally: `npm run dev`.
3. Build: `npm run build` (outputs to `dist/`).
4. Deploy the static site with your provider:
   - AWS Amplify is pre-configured via `amplify.yml` (serves `dist/`).
   - Any static host works (Netlify/Vercel/Firebase Hosting); ensure env vars are set in that platform.

## 5) End-to-end smoke test (after deploy)
1. Connect a funded wallet on the chosen cluster.
2. Sign in (wallet message) → verify profile created in Firestore.
3. Mint a small quantity (≤30) directly from the client → confirm the tx on-chain → refresh UI; mint progress is read from the box minter config PDA.
4. Open one box via `/prepareOpenBoxTx` → sign → inventory shows 3 dudes.
5. Save an encrypted address → request delivery for 1–2 items → sign `/prepareDeliveryTx` tx (burn + certificates) → finalize `/finalizeDeliveryTx` and confirm Firestore `deliveryOrders`.
6. Create a claim code via delivery, then test `/prepareIrlClaimTx` + `/finalizeClaimTx` with the same wallet and certificate present.

## 6) Production cutover checklist
- Switch `SOLANA_CLUSTER`, `SOLANA_RPC_URL`, metadata base, and any secondary links to mainnet values.
- Re-run collection/tree/vault steps on mainnet; update function env vars accordingly.
- Fund the tree authority and shipping vault with sufficient SOL.
- Monitor Helius usage/limits; set alerts.
- Rotate keys: keep `TREE_AUTHORITY_SECRET`, `COSIGNER_SECRET`, and `DELIVERY_VAULT` secrets offline/backed up.


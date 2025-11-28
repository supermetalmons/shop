# mons.shop

React + TypeScript Solana dapp for the mons IRL blind boxes: mint up to 20 boxes per tx, open boxes for 3 dudes, request delivery that burns items & mints certificates, and claim IRL codes. Firebase Cloud Functions back the Helius lookups, tx prep, and encrypted deliveries.

## Frontend
- Install deps: `npm install`
- Copy `.env.example` to `.env` and fill values (RPC, Firebase config, functions base URL, encryption pubkey, secondary links).
- Run dev server: `npm run dev`
- Build for production: `npm run build`

### Required Vite env
```
VITE_SOLANA_CLUSTER=devnet|testnet|mainnet-beta
VITE_RPC_URL=https://your-rpc
VITE_FUNCTIONS_BASE_URL=https://us-central1-<project>.cloudfunctions.net
VITE_FIREBASE_*=...
VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY=<base64 curve25519 pubkey for delivery encryption>
VITE_SECONDARY_TENSOR=...
VITE_SECONDARY_MAGICEDEN=...
```

## Firebase functions
- Install and build: `cd functions && npm install && npm run build`
- Deploy/emulate with the Firebase CLI (`firebase emulators:start --only functions,firestore`).
- Firestore rules live in `firestore.rules` (profiles+addresses are user-restricted, everything else locked down).

### Function env (set as runtime config or shell env)
- `HELIUS_API_KEY`
- `SOLANA_CLUSTER` (`devnet`/`testnet`/`mainnet-beta`)
- `SOLANA_RPC_URL`
- `TREE_AUTHORITY_SECRET` (bs58 secret key that owns the cNFT tree)
- `COSIGNER_SECRET` (optional, defaults to tree authority)
- `MERKLE_TREE`, `COLLECTION_MINT`, `COLLECTION_METADATA`, `COLLECTION_MASTER_EDITION`, `COLLECTION_UPDATE_AUTHORITY`
- `DELIVERY_VAULT` (SOL recipient for shipping)
- `METADATA_BASE` (base URI with box/dude/certificate JSON)
- `TEST_SUPPLY` (defaults 11) and `TOTAL_SUPPLY` (defaults 333)

### What the functions do
- `stats`: mint progress (dev/test cap 11, prod cap 333).
- `inventory`: Helius lookup for boxes/dudes/certificates shown in the grid.
- `solanaAuth`: SIWS message verification → Firebase custom token + profile + saved addresses.
- `saveAddress`: stores an encrypted address blob + country/label under the wallet.
- `prepareMintTx`: checks supply, mints 1-20 compressed boxes in one tx (server pre-signs tree authority).
- `prepareOpenBoxTx`: burns a box (with proof) and mints 3 dudes; assigns dudes deterministically per box.
- `prepareDeliveryTx`: burns selected boxes/dudes, charges SOL shipping, and mints per-item certificates.
- `prepareIrlClaimTx`: validates IRL claim code + blind box certificate ownership, mints dudes certificates.

### Tree + address helpers
- Create a new Merkle tree (defaults depth 14 / buffer 64): `npm run tree:create -- --cluster devnet --keypair ~/.config/solana/id.json --depth 14 --buffer 64 --canopy 0 --rpc https://api.devnet.solana.com`. Prints MERKLE_TREE + TREE_AUTHORITY_SECRET for function env.
- Derive collection PDAs from an existing mint: `npm run tree:derive-collection -- --mint <mintAddress>` (prints metadata + master edition for env).
- Generate a delivery vault keypair: `npm run keygen` (prints public key and base58 + JSON secrets).

## Notes
- Supply is capped by cluster: 11 on dev/test, 333 on mainnet. Adjust via env above.
- Delivery addresses are encrypted client-side with TweetNaCl; only country + label are stored in clear.
- Secondary links & email form swap in automatically once the drop is minted out.

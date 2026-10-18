# 111k Ethereum test collection

The first version runs on a local Anvil chain or Ethereum Sepolia. It does not deploy remotely, request faucet funds, publish CDN files, purchase shipping labels, or send customer emails automatically.

## Run locally

Use the existing project dependencies and Foundry installation. Start from the repository root.

Install the two approved contract dependencies once:

```sh
npm --prefix onchain/ethereum ci --ignore-scripts
```

Terminal 1 starts Anvil with one-second blocks so delivery confirmations advance automatically:

```sh
npm --prefix onchain/ethereum run chain:local
```

Terminal 2 deploys the SVG renderer and collection to that local chain, then starts the local API:

```sh
npm --prefix onchain/ethereum run deploy:local
npm run dev:ethereum:api
```

The deployment is written to `onchain/ethereum/.local/deployment.json`. The API validates the local chain, deployed bytecode and public test signer, creates fresh in-memory D1 databases, applies migrations, and prints its API origin.

The current authorization protocol is version 2. Restart Anvil and rerun `deploy:local` when upgrading an older local deployment; the API rejects legacy deployment files. Delivery quotes commit to the expected receipt identities, so a reorg that changes an artwork token's displayed number requires a fresh quote before delivery.

In Terminal 3, run the exact frontend command printed by the API, for example:

```sh
VITE_MONS_API_ORIGIN=http://127.0.0.1:PORT VITE_111K_LOCAL_ADDRESS_PUBLIC_KEY=PUBLIC_KEY_PRINTED_BY_API npm run dev
```

Open `http://localhost:5173/111k_devnet`, connect an Ethereum wallet, and allow the local network switch. Import one of the funded Anvil accounts displayed in Terminal 1 into a separate test wallet. These are public development keys and must never hold real assets.

The local API disables all production provider credentials and never uses remote D1. It generates an ephemeral address-encryption key, prints only its public key, and keeps the private key inside the local Worker so authorized fulfillment operators can view test shipping addresses. The frontend accepts this override only in development on Anvil.

Exported Ethereum claim QR codes use the current app origin, so local exports return to the local collection.

The API runs reconciliation every ten seconds to recover transactions after the browser closes. Database state and the local address key are discarded when it exits: restart Anvil and run `deploy:local` again when starting a fresh API session. The normal Solana inventory needs the regular API; this isolated local API only provides the Ethereum test flow.

For a different local RPC port, set `MONS_111K_LOCAL_RPC_URL` when deploying. The API reads that URL from the deployment file. `MONS_111K_LOCAL_DEPLOYMENT` can select another local deployment JSON file. Only HTTP loopback URLs, Anvil and chain ID `31337` are accepted.

## Collection behavior

- One collection contains artwork, crates, warehouses, artwork receipts and crate receipts. Artwork SVG numbers identify placeholders, independently of ERC-721 token IDs.
- A shared supply of 5,555 crate allocations covers individual purchases and warehouses. Each warehouse reserves 11 allocations immediately; warehouse opening burns it and mints the reserved crates.
- Crate `n` represents placeholder artworks `20 × (n − 1) + 1` through `20 × n`. Crate #5,555 instead represents #111,081–111,111, including the 11 bonus artworks.
- Minting accepts 1–15 crates or warehouses per transaction. Prices are 0.0001 test ETH per crate and 0.0011 test ETH per warehouse.
- Digital opening burns a crate and mints its 20/31 artworks atomically. All metadata and SVG media are onchain; the backend performs no randomness or reveal transaction.
- Delivery accepts up to 50 owned artworks/crates, requires a backend authorization, and charges 0.0001 test ETH per order. One user transaction burns the originals and mints their receipts. Warehouses and receipts are ineligible for delivery.
- The owner can use `setRedemptionsPaused(true)` as an emergency onchain stop for delivery and crate-receipt claims. It leaves sales, unpacking, transfers, and withdrawals unchanged. The app and API do not read this switch. Pausing does not consume or extend signatures; use the existing signer rotation before resuming after a signer compromise.
- After three confirmations, the order becomes available in fulfillment. Re-mining below that threshold returns it to processing. Physical crates receive stable secret codes and their fixed placeholder contents. Entering a matching code lets the current crate-receipt owner submit one signed claim transaction that burns it and mints 20/31 artwork receipts.
- Receipts use token IDs `1,000,000 + artwork number` and `2,000,000 + crate number`. Original display identities survive redemption; consumed token IDs and crate allocations are never reused.

Fulfillment uses existing Solana staff sign-in. The primary admin and designated address operator can view the Ethereum test drop. The app supports status/tracking updates, address editing, placeholder previews, contents, order/address exports and secret-code PNG/ZIP exports. Ethereum test orders are blocked from ShipStation and customer/shipper email paths on the server.

Re-mined claims awaiting three confirmations show “Confirming” in fulfillment. Pending and completed claims cannot export secret codes. Ethereum reconciliation limits its Commerce database work to 400 statements per run. Delivery and claim recovery run concurrently with separate 100-statement budgets and reuse verified receipts. Both stop after 30 seconds to leave time for event discovery; unfinished work resumes on later runs.

## Sepolia configuration

Funding, faucet choice, remote deployment and secret provisioning are separate decisions. When those are authorized, the API uses these settings:

| Setting | Meaning |
| --- | --- |
| `ETHEREUM_111K_CHAIN_ID` | `11155111` for Sepolia; `31337` for local testing |
| `ETHEREUM_111K_CONTRACT_ADDRESS` | Collection contract; blank keeps it undeployed |
| `ETHEREUM_111K_RENDERER_ADDRESS` | SVG renderer contract |
| `ETHEREUM_111K_DEPLOYMENT_BLOCK` | First block for bounded event reconciliation |
| `ETHEREUM_111K_RPC_URL` | Local loopback RPC only; unused for Sepolia |
| `ETHEREUM_111K_SIGNER_SECRET` | Backend authorization key matching `quoteSigner()`; required for delivery and claims, optional while undeployed |
| `ALCHEMY_MI_NOTE_API_KEY` | Existing server-only key for Sepolia RPC and NFT indexing |

The public A11CE fixture key is exclusively for isolated local testing. Provision a separate signer for Sepolia. Apply OPS migration `0008_ethereum_profiles.sql` and Commerce migrations `0037_ethereum_111k.sql`, `0038_ethereum_reconciliation.sql`, and `0039_ethereum_reconciliation_indexes.sql` through the existing reviewed migration workflow. These add Ethereum records, atomic state guards for fulfillment writes, and indexes for eligible recovery work. Never use the local helper to initialize a production database.

## API and verification

Public reads are under `/ethereum/111k/config`, `/stats`, `/inventory` and `/metadata`. `/ethereum/111k/transactions/confirm` returns minted/burned items at first inclusion. Customer auth is under `/ethereum/auth/challenge`, `/verify` and `/logout`; profile/address/shipment data use `/ethereum/profile`, `/addresses` and `/shipments`. Delivery and claims each have `/prepare` and `/confirm` routes under `/ethereum/111k`.

Sessions are scoped to wallet, chain, drop and browser origin. EOA and deployed ERC-1271 wallets are supported. Private routes use `X-Mons-Ethereum-Session`; POST requests also require `X-Mons-CSRF: 1`. Shipping addresses and secret codes stay offchain. The signer authorizes actions without paying gas or sending transactions.

Transactions require working persistent browser storage. The app saves a submission reservation before requesting the transaction, so a reload or another tab cannot silently submit again. If saving the returned transaction hash fails, the app displays the hash and keeps the reservation. Recover using the matching transaction hash from the wallet, or explicitly stop tracking after checking the wallet.

Run contract tests, the real local contract/API lifecycle, and targeted Worker tests with:

```sh
npm --prefix onchain/ethereum run check
npm run test:ethereum
npm run test:ethereum:e2e
node --import tsx --test cloud/workers/api/test/ethereum111k.test.ts
node --import tsx --test cloud/workers/api/runtime-test/ethereum-111k-runtime.test.ts
```

The real-chain test starts and stops its own Anvil process and does not use an external network. Existing frontend/API typechecks and regression suites cover the shared Solana integration boundaries.

## Validation as of 2026-10-18

- 66 Solidity checks and 45 isolated gas benchmarks pass, including 256 fuzz cases, stateful invariants, full 5,555-crate/111,111-artwork coverage, ownership lookup boundaries, pause behavior, signature tampering, callback reentrancy, purchase-counter visibility and rollback, transient-state cleanup, and both bonus-crate paths. The extended invariant campaign also passes 512 sequences of 128 calls (65,536 calls), with no unexpected handler reverts. Ten gas-check regressions verify rejection of missing or changed snapshots, skipped benchmarks, and missing or renamed runtime measurements without rewriting baselines; intentional updates use the separate `gas:update` command. See the [contract checks and gas comparison](../../onchain/ethereum/README.md).
- 3,821 repository tests and 2,382 API tests pass. Native Worker/D1 checks pass, including the new routes, atomic sessions, migrations, Ethereum commit guards and fulfillment pagination.
- The Anvil end-to-end lifecycle passes with real deployed contracts, backend signatures, encrypted addresses, three-confirmation publication, transferred crate receipts and code claims. It covers replacement delivery after a chain reorg, atomic rejection of a stale artwork-identity quote, and successful delivery with a fresh quote. Its report and five SVG previews are generated under `.cache/111k-e2e/`.
- Frontend, API and tools typechecks, generated schema/ABI checks, dead-code checks, production build, browser credential scan, Worker dry run and startup profiling pass.
- Runtime bytecode is 14,411 bytes for the collection and 7,752 bytes for the renderer, each below the 24,576-byte limit. Representative SVGs were rendered and visually inspected.

Live browser interaction was unavailable because local browser use is disabled in the app settings; component tests cover the mobile controls, wallet/recovery flows and modal behavior. No public-network contract, Worker, database migration, funding request or production secret was deployed by this implementation.

# 111K Ethereum test collection

The first version runs on a local Anvil chain or Ethereum Sepolia. It does not deploy remotely, request faucet funds, publish CDN files, purchase shipping labels, or send customer emails automatically.

## Run locally

Use the existing project dependencies and Foundry installation. Start from the repository root.

Install the contract and allowlist tooling dependencies once:

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

The current local deployment manifest uses `protocolVersion: 5`. Restart Anvil, rerun `deploy:local`, and restart the API when upgrading an older local deployment; the API rejects older manifests with redeployment instructions and probes the batch getters and wallet-aware stats before starting. A fresh deployment is required for discounted crate minting. EIP-712 retains the domain name `111K`, version `2`, and the existing signed field schemas; signatures remain bound to their original contract address.

Delivery quotes commit to the expected receipt identities, so a reorg that changes an artwork token's displayed number requires a fresh quote before delivery. New deliveries sort token IDs before signing without rewriting saved quotes or pending transactions.

In Terminal 3, run the exact frontend command printed by the API, for example:

```sh
VITE_MONS_API_ORIGIN=http://127.0.0.1:PORT VITE_111K_LOCAL_ADDRESS_PUBLIC_KEY=PUBLIC_KEY_PRINTED_BY_API npm run dev
```

Open `http://localhost:5173/111k_devnet`, connect an Ethereum wallet, and allow the local network switch. Import one of the funded Anvil accounts displayed in Terminal 1 into a separate test wallet. These are public development keys and must never hold real assets.

The local API disables all production provider credentials and never uses remote D1. It generates an ephemeral address-encryption key, prints only its public key, and keeps the private key inside the local Worker so authorized fulfillment operators can view test shipping addresses. The frontend accepts this override only in development on Anvil.

Exported Ethereum claim QR codes use the current app origin, so local exports return to the local collection.

The API runs reconciliation every ten seconds to recover transactions after the browser closes. Database state and the local address key are discarded when it exits: restart Anvil and run `deploy:local` again when starting a fresh API session. The normal Solana inventory needs the regular API; this isolated local API only provides the Ethereum test flow.

For a different local RPC port, set `ETHEREUM_111K_LOCAL_RPC_URL` when deploying. The API reads that URL from the deployment file. `ETHEREUM_111K_LOCAL_DEPLOYMENT` can select another local deployment JSON file. Only HTTP loopback URLs, Anvil and chain ID `31337` are accepted.

## Collection behavior

- One collection contains artwork, crates, warehouses, artwork receipts and crate receipts. Artwork metadata retains placeholder display numbers independently of ERC-721 token IDs; the flower SVGs intentionally omit visible numbers.
- A shared supply of 5,555 crate allocations covers individual purchases and warehouses. Each warehouse reserves 11 allocations immediately; warehouse opening burns it and mints the reserved crates.
- Crate `n` represents placeholder artworks `20 × (n − 1) + 1` through `20 × n`. Crate #5,555 instead represents #111,081–111,111, including the 11 bonus artworks.
- Minting accepts 1–15 crates or warehouses per transaction. Prices are 0.0001 test ETH per crate and 0.0011 test ETH per warehouse.
- Digital opening accepts 1–15 crates in one atomic transaction, producing up to 311 artworks when crate #5555 is included. All selected crates burn before the first receiver callback; any failure rolls back the complete batch. Warehouses open individually. All metadata and SVG media are onchain; the backend performs no randomness or reveal transaction.
- Delivery accepts up to 50 owned artworks/crates, requires a backend authorization, and charges 0.0001 test ETH per order. One user transaction burns the originals and mints their receipts. Warehouses and receipts are ineligible for delivery.
- New app deliveries sort a copied selection numerically by original token ID before signing. Receipt identities remain paired with those tokens. The contract validates the whole selection, burns every original, then safely mints receipts; callbacks see all originals already burned. Arbitrary signed input order remains supported.
- The owner can use `setRedemptionsPaused(true)` as an emergency onchain stop for delivery and crate-receipt claims. It leaves sales, unpacking, transfers, and withdrawals unchanged. The app and API do not read this switch. Pausing does not consume or extend signatures; use the existing signer rotation before resuming after a signer compromise.
- After three confirmations, the order becomes available in fulfillment. Re-mining below that threshold returns it to processing. Physical crates receive stable secret codes and their fixed placeholder contents. Entering a matching code lets the current crate-receipt owner submit one signed claim transaction that burns it and mints 20/31 artwork receipts.
- Receipts use token IDs `1,000,000 + artwork number` and `2,000,000 + crate number`. Original display identities survive redemption; consumed token IDs and crate allocations are never reused.

Fulfillment uses existing Solana staff sign-in. The primary admin and designated address operator can view the Ethereum test drop. The app supports status/tracking updates, address editing, placeholder previews, contents, order/address exports and secret-code PNG/ZIP exports. Ethereum test orders are blocked from ShipStation and customer/shipper email paths on the server.

Re-mined claims awaiting three confirmations show “Confirming” in fulfillment. Pending and completed claims cannot export secret codes. Ethereum reconciliation limits its Commerce database work to 400 statements per run. Delivery and claim recovery run concurrently with separate 100-statement budgets and reuse verified receipts. Both stop after 30 seconds to leave time for event discovery; unfinished work resumes on later runs.

## Discounted crates

The draft allowlist contains the 317 holders of Ethereum mainnet collection `0x30f9efa712dde239a13a5fef1a8c7a6ac530a26d` at finalized block `26235186`, plus `0xE26067c76fdbe877F48b0a8400cf5Db8B47aF0fE`: 318 addresses total. The block hash, source collection, token range, counts, and canonical address digest are recorded in `onchain/ethereum/fixtures/discounts/source.json`; the holder list and explicit additions remain reproducible. Contract wallets and delegated EOAs are included.

The initial allowance is one discounted crate per wallet, priced at 0.00005 ETH. The owner can change the total allowance to 1–10 using `setDiscountConfig(root, allowance)` without resetting usage. Setting the root to zero disables discounts. `setPrices(cratePrice, warehousePrice, discountCratePrice)` changes the three fixed prices together and rejects a discounted price above the public crate price. Changes to public prices do not automatically recalculate the discounted price.

Only successful `mintCratesDiscounted(quantity, proof)` purchases consume allowance. Public crate purchases, warehouse purchases, transfers, and unboxing do not change it. Warehouses always use public pricing. The existing discounted mint button appears when the connected wallet is listed and its entire selected crate quantity fits the remaining allowance. Selecting more uses public pricing for the entire purchase, matching the Solana drops.

The page loads the static Ethereum proof dataset once and reads the root, prices, allowance, and wallet usage through `GET /ethereum/111k/stats?owner=ADDRESS`, backed by one `stats(address)` contract call. It does not query the source collection while browsing. Connection, proof loading, and failed reads cannot silently submit a public-price transaction; mint terms are checked again before wallet submission. A root update requires publishing its matching proof dataset.

Generate and verify the committed artifacts offline:

```sh
npm --prefix onchain/ethereum run discounts:generate
npm --prefix onchain/ethereum run discounts:check
```

`npm --prefix onchain/ethereum run discounts:snapshot` rereads the same pinned mainnet block, with `ETHEREUM_DISCOUNT_SNAPSHOT_RPC_URL` available to select an RPC provider. It validates the complete ownership scan before writing. It does not advance the snapshot automatically.

Local deployment loads the committed root from `src/ethereum/discounts/111k.json`; `ETHEREUM_111K_LOCAL_DISCOUNT_ROOT` can override it for isolated tests. The Foundry deployment script requires `ETHEREUM_111K_DISCOUNT_ROOT`. The allowance and fixed discounted price start at their defaults on every fresh deployment.

## Sepolia configuration

The [first Sepolia release](../../releases/111k-sepolia/README.md) records an earlier contract interface; discounted minting requires a new collection deployment and updated API configuration. Sepolia activated Glamsterdam on October 6, 2026: estimate deployment gas against the live RPC and verify each exact creation payload with `eth_call`. Local Prague gas benchmarks underestimate state-creation costs on this network. The API uses these settings:

| Setting | Meaning |
| --- | --- |
| `ETHEREUM_111K_CHAIN_ID` | `11155111` for Sepolia; `31337` for local testing |
| `ETHEREUM_111K_CONTRACT_ADDRESS` | Collection contract; blank keeps it undeployed |
| `ETHEREUM_111K_RENDERER_ADDRESS` | SVG renderer contract |
| `ETHEREUM_111K_DEPLOYMENT_BLOCK` | First block for bounded event reconciliation |
| `ETHEREUM_111K_RPC_URL` | Local loopback RPC only; unused for Sepolia |
| `ETHEREUM_111K_SIGNER_SECRET` | Backend authorization key matching `quoteSigner()`; required for delivery and claims, optional while undeployed |
| `ALCHEMY_MI_NOTE_API_KEY` | Existing server-only key for Sepolia RPC and NFT indexing |

The public A11CE fixture key is exclusively for isolated local testing. Provision a separate signer for Sepolia. Apply OPS migration `0008_ethereum_profiles.sql` and Commerce migrations `0037_ethereum_111k.sql` through `0041_ethereum_111k_control.sql` using the existing reviewed migration workflow. These add Ethereum records, atomic state guards for fulfillment writes, indexes for eligible recovery work, resumable event scans, and scoped maintenance. Never use the local helper to initialize a production database.

## Ethereum maintenance and replacement

The `ethereum_111k_control` singleton starts paused with no allowed deployment. Public configuration reports minting unavailable until its chain and contract match the API configuration and it is resumed. The same control gates delivery and claim preparation/confirmation, Ethereum reconciliation, and fulfillment edits for `111k_devnet`. Database guards reject late writes from a paused or retired deployment. Other drops and shared wallet accounts remain available.

Read the current revision before each transition. Pause and resume commands are dry runs unless `--write` is present:

```sh
npm run ethereum111k-control -- status
npm run ethereum111k-control -- pause --chain-id 11155111 --contract OLD_ADDRESS --expected-revision REVISION
npm run ethereum111k-control -- pause --chain-id 11155111 --contract OLD_ADDRESS --expected-revision REVISION --write
```

For a replacement, bind the initial paused control to the old contract, publish the API with the new contract configuration, and allow at least 65 seconds for in-flight operations to drain. Recheck the revision, then preview the reset:

```sh
npm run reset:ethereum111k -- --chain-id 11155111 --old-contract OLD_ADDRESS --expected-revision REVISION
npm run reset:ethereum111k -- --chain-id 11155111 --old-contract OLD_ADDRESS --expected-revision REVISION --reset-id RESET_UUID --write
```

The write command rebuilds its snapshot, saves a private backup under `~/.mons-shop-backups/ethereum111k`, and deletes only the specified deployment's quotes, claims, cursor, and corresponding delivery projections/recovery records in one guarded batch. Unexpected outboxes, inventory, pack-status history, reveal submissions, or another deployment's documents stop the reset. Shared profiles, addresses, authentication data, and concurrency tombstones are preserved. If a response is uncertain, inspect status and rerun with the same reset ID to reconcile the recorded outcome.

After verifying the reset and publishing the matching frontend, resume using the new contract and current revision:

```sh
npm run ethereum111k-control -- resume --chain-id 11155111 --contract NEW_ADDRESS --expected-revision REVISION --write
```

Changing the allowed contract requires the old scope to be empty. The control does not change onchain sale or redemption switches; administer those separately and leave historical contracts as explicitly intended by the release.

## API and verification

Public reads are under `/ethereum/111k/config`, `/stats`, `/inventory` and `/metadata`. `/ethereum/111k/transactions/confirm` returns minted/burned items at first inclusion. Customer auth is under `/ethereum/auth/challenge`, `/verify` and `/logout`; profile/address/shipment data use `/ethereum/profile`, `/addresses` and `/shipments`. Delivery and claims each have `/prepare` and `/confirm` routes under `/ethereum/111k`.

Configuration advertises `maxUnboxQuantity: 15`. Select 2–15 crates to use **Open N crates**; larger selections keep delivery available and explain the opening limit. A batch is never silently truncated or split into multiple wallet transactions. Its final aggregate event proves the exact ordered selection during confirmation and recovery.

Inventory and transaction confirmation use contract batches of up to 150 token-info entries and 30 metadata entries. At most four calls share an RPC envelope, with two envelopes in flight and a 3 MiB response limit. Each response pins reads to one exact block hash and verifies it remains canonical before returning. A failed chunk or changed snapshot produces a retryable error instead of a partial inventory. A normal 30-item inventory page uses two contract calls instead of 60, excluding chain and snapshot checks and larger local ownership scans.

Sessions are scoped to wallet, chain, drop and browser origin. EOA and deployed ERC-1271 wallets are supported. Private routes use `X-Mons-Ethereum-Session`; POST requests also require `X-Mons-CSRF: 1`. Shipping addresses and secret codes stay offchain. The signer authorizes actions without paying gas or sending transactions.

Transactions require working persistent browser storage. The app saves a submission reservation before requesting the transaction, so a reload or another tab cannot silently submit again. If saving the returned transaction hash fails, the app displays the hash and keeps the reservation. Recover using the matching transaction hash from the wallet, or explicitly stop tracking after checking the wallet.

Inventory recovery retains 500 recent live IDs and 500 retained/rollback IDs per wallet/chain/contract. Requests send at most 100 expected IDs each, with two requests in flight. This preserves all 311 artworks from a maximum opening across first inclusion, stale indexing, refresh and reload. Contract-wallet confirmations remain able to return more than 311 items when a wrapper performs additional operations.

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

- 102 Solidity checks and 105 isolated gas benchmarks pass, including 256 fuzz cases, stateful invariants, full 5,555-crate/111,111-artwork coverage, and callback/reentrancy/rollback checks. Batch coverage includes 15 crates with the bonus crate in different positions, all sources burned before callbacks, exact aggregate events, repeated operations with cleared transient state, and maximum-sized reads. The extended invariant campaign passes 512 sequences of 128 calls (65,536 calls), with zero unexpected reverts, including 4,421 batch openings, 4,400 batch-read checks and 4,409 duplicate-batch rejection checks. Ten gas-check regressions reject missing or changed snapshots, skipped benchmarks, and missing or renamed measurements without rewriting baselines; intentional updates use `gas:update`.
- The full repository and API runs pass 3,943 and 2,418 tests respectively. Four focused native Worker runtime checks pass. Coverage includes 311-artwork recovery through delayed indexing and reload, batch transaction replacement, exact event commitments, 500/1,000-ID storage bounds, deployment-manifest rejection, read cardinality, bounded RPC concurrency, cancellation and snapshot reorgs.
- The Anvil end-to-end lifecycle passes with real deployed contracts, backend signatures, encrypted addresses, three-confirmation publication, transferred crate receipts and code claims. It also opens 15 crates including #5555, verifies all 311 artwork identities and the aggregate event, confirms them with 14 contract reads, and recovers every output through inventory. Existing stale-identity, replacement-delivery and unsorted mixed-delivery scenarios pass. Its report and five SVG previews are generated under `.cache/111k-e2e/`.
- Frontend, API and tools typechecks, generated schema and ABI/authorization fixtures, dead-code checks, production build and browser credential scan pass.
- The [batch benchmarks](../../onchain/ethereum/README.md#batch-operations-2026-10-18) measure 29.07% less gas for a real 15-crate opening after existing artwork: 1,219,236 versus 1,719,007 gas. The 30-item metadata read costs 18,989,148 gas in simulation and returns about 380 KB of RPC hex. Current runtime sizes are 17,206 bytes for the collection and 11,775 bytes for the renderer. Solidity 0.8.30, Prague, `via_ir = false` and 1000 optimizer runs remain configured. The [history index](../../onchain/ethereum/benchmarks/HISTORY.md) preserves earlier compiler comparisons without treating them as measurements of the current source.

Component tests cover the mobile controls, wallet/recovery flows and modal behavior; a live wallet/browser walkthrough was not performed for these changes. No public-network contract, Worker, database migration, funding request or production secret was deployed by this implementation.

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

Terminal 2 deploys the collection to that local chain, then starts the local API:

```sh
npm --prefix onchain/ethereum run deploy:local
npm run dev:ethereum:api
```

The deployment is written to `onchain/ethereum/.local/deployment.json`. The API validates the local chain, deployed bytecode and public test signer, creates fresh in-memory D1 databases, applies migrations, and prints its API origin.

Fresh deployments have `saleActive()` false. Before testing purchases, open the local sale explicitly from the unlocked Anvil owner. Use `contractAddress` and `owner` from the deployment manifest for these placeholders:

```sh
cast send LOCAL_CONTRACT_ADDRESS 'setSaleActive(bool)' true --from LOCAL_OWNER_ADDRESS --unlocked --rpc-url http://127.0.0.1:8545
```

Starting the API and provisioning local reveal inventory leave this switch unchanged. If you selected a custom owner or RPC port, use that owner's signer and the deployment's RPC URL.

The current local deployment manifest uses `protocolVersion: 11`. Restart Anvil, rerun `deploy:local`, and restart the API when upgrading an older local deployment; the API rejects older manifests with redeployment instructions and probes the batch, wallet-aware stats, and payout getters before starting. It checks immutable mint recipients and shares against the manifest while allowing owner rotation of the delivery receiver. The manifest records `metadataBaseURI`, which is verified against the collection’s `baseURI()`. Local deployment defaults to the complete `https://cdn.mons.shop/111k-sepolia/v9/` publication; `ETHEREUM_111K_LOCAL_METADATA_BASE_URI` can select another published namespace. No metadata server or generator runs in normal local development. CDN connectivity is required; unavailable metadata produces an error rather than a local fallback. All manifests older than version 11 require a fresh deployment with monument receipt support, including older manifests with matching CDN URLs. Use a published monument-ready namespace to read monument metadata locally. EIP-712 retains the domain name `111K`, version `2`, and the existing signed field schemas; signatures remain bound to their original contract address.

Both deployment scripts load `onchain/ethereum/config/proceeds.json`: four valid placeholder recipients at 50% / 25% / 15% / 10%, and a separate placeholder shipping receiver. Replace the placeholders before deploying for real proceeds. The configuration supports 2–32 mint recipients whose positive basis points total 10,000; addresses must be distinct and must not be the collection. Mint recipients/shares are fixed. The owner may rotate the shipping receiver using `setDeliveryPaymentReceiver(address)`, which moves all unpaid and future shipping fees to the new receiver. Treasury environment settings are no longer used.

Anyone can submit `releaseAllMint()` to attempt every mint payout in one transaction, `releaseMint(address)` for one recipient, or `releaseDelivery()` for shipping fees, without access to an owner key. The caller pays transaction gas. Read `releasableMint(address)` or `releasableDelivery()` first; zero balances are a no-op. Batch payouts use a bounded 100,000-gas call budget per receiver, skip failed transfers with `MintProceedsReleaseFailed`, and preserve their unpaid entitlement for retry or individual release. Estimate gas before submitting; insufficient transaction gas reverts the batch. Mint and shipping accounting remain separate, each recipient can withdraw independently, and pauses do not stop payouts. Existing deployments retain their original limits and functions. The contract no longer exposes a full-balance `withdraw()` function. See the [proceeds documentation](../../onchain/ethereum/README.md#mint-splits-and-delivery-proceeds) for rounding and accounting details.


Delivery quotes commit to the expected receipt identities. Artwork display numbers now equal their token IDs and stay stable across changes in crate-opening order. New deliveries sort token IDs before signing without rewriting saved quotes or pending transactions.

In Terminal 3, run the exact frontend command printed by the API, for example:

```sh
VITE_MONS_API_ORIGIN=http://127.0.0.1:PORT VITE_111K_LOCAL_ADDRESS_PUBLIC_KEY=PUBLIC_KEY_PRINTED_BY_API npm run dev
```

Open `http://localhost:5173/111k_devnet`, connect an Ethereum wallet, and allow the local network switch. Import one of the funded Anvil accounts displayed in Terminal 1 into a separate test wallet. These are public development keys and must never hold real assets.

The local API disables all production provider credentials and never uses remote D1. It generates an ephemeral address-encryption key, prints only its public key, and keeps the private key inside the local Worker so authorized fulfillment operators can view test shipping addresses. The frontend accepts this override only in development on Anvil.

Exported Ethereum claim QR codes use the current app origin, so local exports return to the local collection.

The API runs reconciliation every ten seconds to recover transactions after the browser closes. Database state and the local address key are discarded when it exits: restart Anvil and run `deploy:local` again when starting a fresh API session. The normal Solana inventory needs the regular API; this isolated local API only provides the Ethereum test flow.

For a different local RPC port, set `ETHEREUM_111K_LOCAL_RPC_URL` when deploying. The API reads that RPC URL from the deployment file; RPC access accepts only HTTP loopback URLs, Anvil and chain ID `31337`. `ETHEREUM_111K_LOCAL_METADATA_BASE_URI` accepts only the published HTTPS CDN namespaces `/111k-sepolia/` and `/111k/`, with Sepolia as the default. `ETHEREUM_111K_LOCAL_DEPLOYMENT` can select another local deployment JSON file.

## Collection behavior

- One collection contains artwork, crates, warehouses, monuments, artwork receipts, crate receipts and monument receipts. Digital artwork display numbers equal their sequential ERC-721 token IDs.
- A shared supply of 5,555 crate allocations covers individual purchases, warehouses and monuments. Each warehouse reserves 11 allocations immediately; each monument reserves 111. Opening either container burns it and mints its reserved crates.
- At most 18 monuments can ever be minted. Opening monuments does not restore this allowance or return crate allocations. A monument purchase requires enough remaining crate allocations for every requested monument and enough room below the lifetime cap.
- Digital opening assigns the next 20 artwork token IDs, or 31 for crate #5555. Physical-only claim artwork numbers use `111111 + 20 × (n − 1) + 1` onward; crate #5555 ends at #222222.
- Minting accepts 1–15 crates, warehouses or monuments per transaction. Initial prices are 0.0001 test ETH per crate, 0.0011 test ETH per warehouse and 0.0088 test ETH per monument. Each price is independently configurable.
- Sales start closed. Only the owner can open them with `setSaleActive(true)`; use `setSaleActive(false)` to close purchases again.
- Digital opening accepts 1–15 crates in one atomic transaction, producing up to 311 artworks when crate #5555 is included. All selected crates burn before the first receiver callback; any failure rolls back the complete batch. Warehouses and monuments open individually. Metadata is served from token-ID JSON files at `cdn.mons.shop`; crate opening uses the [reveal service](111k_reveal.md). See [offchain metadata](111k_metadata.md).
- Delivery accepts up to 50 owned artworks, crates and unopened monuments in mixed orders, requires a backend authorization, and charges 0.0001 test ETH per order. One user transaction burns the originals and mints their receipts. Warehouses and receipts are ineligible for delivery. A monument burns into its same-numbered terminal receipt; its 111 reserved crate allocations remain consumed.
- New app deliveries sort a copied selection numerically by original token ID before signing. Receipt identities remain paired with those tokens. The contract validates the whole selection, burns every original, then safely mints receipts; callbacks see all originals already burned. Arbitrary signed input order remains supported.
- The owner can use `setRedemptionsPaused(true)` as an emergency onchain stop for delivery and crate-receipt claims. It leaves sales, unpacking, transfers, and withdrawals unchanged. The app and API do not read this switch. Pausing does not consume or extend signatures; use the existing signer rotation before resuming after a signer compromise.
- After three confirmations, the order becomes available in fulfillment. Re-mining below that threshold returns it to processing. Physical crates receive stable secret codes and their fixed placeholder contents. Entering a matching code lets the current crate-receipt owner submit one signed claim transaction that burns it and mints 20/31 artwork receipts.
- Digital artwork receipts use token IDs `1,000,000 + original token ID`; physical-only artwork receipts use 1,111,112–1,222,222. Crate receipts use `2,000,000 + crate number`. Monument receipts use `3,000,000 + monument number` and the shared `receipt_background.webp` placeholder. They can transfer but cannot be unpacked, redeemed or claimed for contents. Artwork receipts retain their placeholder media. Consumed token IDs and crate allocations are never reused.

Fulfillment uses existing Solana staff sign-in. The primary admin and designated address operator can view the Ethereum test drop. The app supports status/tracking updates, address editing, placeholder previews, contents, order/address exports and secret-code PNG/ZIP exports. Ethereum test orders are blocked from ShipStation and customer/shipper email paths on the server.

Re-mined claims awaiting three confirmations show “Confirming” in fulfillment. Pending and completed claims cannot export secret codes. Ethereum reconciliation limits its Commerce database work to 400 statements per run. Delivery and claim recovery run concurrently with separate 100-statement budgets and reuse verified receipts. Both stop after 30 seconds to leave time for event discovery; unfinished work resumes on later runs.

## Discounted crates

The draft allowlist contains the 317 holders of Ethereum mainnet collection `0x30f9efa712dde239a13a5fef1a8c7a6ac530a26d` at finalized block `26235186`, plus `0xE26067c76fdbe877F48b0a8400cf5Db8B47aF0fE`: 318 addresses total. The block hash, source collection, token range, counts, and canonical address digest are recorded in `onchain/ethereum/fixtures/discounts/source.json`; the holder list and explicit additions remain reproducible. Contract wallets and delegated EOAs are included.

The initial allowance is one discounted crate per wallet, priced at 0.00005 ETH. The owner can change the total allowance to 1–10 using `setDiscountConfig(root, allowance)` without resetting usage. Setting the root to zero disables discounts. `setPrices(cratePrice, warehousePrice, discountCratePrice, monumentPrice)` changes the four fixed prices together and rejects a discounted price above the public crate price. Changes to public prices do not automatically recalculate the discounted price or the monument price.

Only successful `mintCratesDiscounted(quantity, proof)` purchases consume allowance. Public crate purchases, warehouse and monument purchases, transfers, and unboxing do not change it. Warehouses and monuments always use public pricing. The existing discounted mint button appears when the connected wallet is listed and its entire selected crate quantity fits the remaining allowance. Selecting more uses public pricing for the entire purchase, matching the Solana drops.

The page loads the static Ethereum proof dataset once and reads the root, prices, allowance, and wallet usage through `GET /ethereum/111k/stats?owner=ADDRESS`, backed by one `stats(address)` contract call. It does not query the source collection while browsing. Connection, proof loading, and failed reads cannot silently submit a public-price transaction; mint terms are checked again before wallet submission. A root update requires publishing its matching proof dataset.

Generate and verify the committed artifacts offline:

```sh
npm --prefix onchain/ethereum run discounts:generate
npm --prefix onchain/ethereum run discounts:check
```

`npm --prefix onchain/ethereum run discounts:snapshot` rereads the same pinned mainnet block, with `ETHEREUM_DISCOUNT_SNAPSHOT_RPC_URL` available to select an RPC provider. It validates the complete ownership scan before writing. It does not advance the snapshot automatically.

Local deployment loads the committed root from `src/ethereum/discounts/111k.json`; `ETHEREUM_111K_LOCAL_DISCOUNT_ROOT` can override it for isolated tests. The Foundry deployment script requires `ETHEREUM_111K_DISCOUNT_ROOT`. The allowance and fixed discounted price start at their defaults on every fresh deployment.

## Sepolia configuration

The [v9 release](../../releases/111k-sepolia-v9/README.md) records the monument receipt collection at `0x4d127fceeaa8b652744c4cb1f62f1101290180a8`, deployed at Sepolia block `12033427` in [transaction 0xcc2face2…69452d](https://sepolia.etherscan.io/tx/0xcc2face2cfc1dff178251d56732093c76fc06ee8e96673c2d74c6cc8ad69452d). It was deployed with sales closed and its [source is verified on Sourcify](https://repo.sourcify.dev/11155111/0x4d127fceeaa8b652744c4cb1f62f1101290180a8). Deployment ID `v9` uses metadata under `https://cdn.mons.shop/111k-sepolia/v9/` and a lifetime cap of 18 monuments, each reserving 111 crates. Unopened monuments can be delivered into terminal receipts numbered 3000001–3000018. The API configuration and reveal registration must use that exact contract, creation block, and metadata prefix. Consult the release for cutover and sale-opening results. The preceding [v8 release](../../releases/111k-sepolia-v8/README.md) and its metadata remain historical records.

The [v7 release](../../releases/111k-sepolia-v7/README.md) records the preceding collection at `0xc7571e9dc4b1cd646d092d51cfa89a76a6461fec`, block `12029091`; preserve its metadata and reveal ledger when replacing it. Earlier release records remain historical. Estimate deployment gas against the live Sepolia RPC and verify the exact creation payload with `eth_call`; local Prague benchmarks are not deployment gas limits. The API uses these settings:

| Setting | Meaning |
| --- | --- |
| `ETHEREUM_111K_CHAIN_ID` | `11155111` for Sepolia; `31337` for local testing |
| `ETHEREUM_111K_CONTRACT_ADDRESS` | Collection contract; blank keeps it undeployed |
| `ETHEREUM_111K_METADATA_BASE_URI` | Exact public R2 metadata prefix fetched over HTTP for this deployment |
| `ETHEREUM_111K_DEPLOYMENT_BLOCK` | First block for bounded event reconciliation |
| `ETHEREUM_111K_RPC_URL` | Local loopback RPC only; unused for Sepolia |
| `ETHEREUM_111K_SIGNER_SECRET` | Backend authorization key matching `quoteSigner()`; required for delivery and claims, optional while undeployed |
| `ALCHEMY_MI_NOTE_API_KEY` | Existing server-only key for Sepolia RPC and NFT indexing |

The public A11CE fixture key is exclusively for isolated local testing. Provision a separate signer for Sepolia. Apply all checked-in database migrations through the [Cloudflare deployment workflow](cloudflare_deployment.md), including its required maintenance procedure. The schema owns Ethereum records, atomic fulfillment guards, recovery indexes, resumable event scans, and scoped maintenance. Never use the local helper to initialize a production database.

## Ethereum maintenance and replacement

The `ethereum_111k_control` singleton starts paused with no allowed deployment. Public configuration reports minting unavailable until its chain and contract match the API configuration and it is resumed. The same control gates delivery and claim preparation/confirmation, Ethereum reconciliation, and fulfillment edits for `111k_devnet`. Database guards reject late writes from a paused or retired deployment. Other drops and shared wallet accounts remain available.

Read the current revision before each transition. Pause and resume commands are dry runs unless `--write` is present:

```sh
npm run ethereum111k-control -- status
npm run ethereum111k-control -- pause --chain-id 11155111 --contract OLD_ADDRESS --expected-revision REVISION
npm run ethereum111k-control -- pause --chain-id 11155111 --contract OLD_ADDRESS --expected-revision REVISION --write
```

Before resetting the old collection, close its onchain sale and call `setRedemptionsPaused(true)` so outstanding authorizations cannot execute. Before replacing a reveal-enabled collection, also pause its reveal admission using `npm run ethereum-reveal-control -- pause --deployment-id OLD_DEPLOYMENT_ID --expected-revision REVEAL_REVISION --write`. Keep its permanent OPS deployment record, private reservations, frozen assignments, and metadata objects. Ethereum commerce reset does not remove this reveal state. Publish and verify placeholders at a fresh `111k-sepolia/<deploymentId>/` prefix, pass that exact URL as `ETHEREUM_111K_METADATA_BASE_URI` to the new contract deployment, and register/provision the new reveal deployment using the [reveal operator guide](111k_reveal_ops.md#operator-setup). Never reuse the old metadata prefix.

The v9 replacement uses deployment ID `v9` and metadata URI `https://cdn.mons.shop/111k-sepolia/v9/`. Its full 344984-object baseline must be verified before deployment and registration. Keep its onchain sale closed while configuration, reveal provisioning, scoped commerce reset, and application verification complete.

For a replacement, bind the initial paused control to the old contract, publish the API with the new contract configuration, and allow at least 65 seconds for in-flight operations to drain. Recheck the revision, then preview the reset:

```sh
npm run reset:ethereum111k -- --chain-id 11155111 --old-contract OLD_ADDRESS --expected-revision REVISION
npm run reset:ethereum111k -- --chain-id 11155111 --old-contract OLD_ADDRESS --expected-revision REVISION --reset-id RESET_UUID --write
```

The write command rebuilds its snapshot, saves a private backup under `~/.mons-shop-backups/ethereum111k`, and deletes only the specified deployment's quotes, checkouts, checkout attempts, claims, cursor, and corresponding delivery projections/recovery records in one guarded batch. Unexpected outboxes, inventory, pack-status history, reveal submissions, or another deployment's documents stop the reset. Shared profiles, addresses, authentication data, and concurrency tombstones are preserved. If a response is uncertain, inspect status and rerun with the same reset ID to reconcile the recorded outcome.

After verifying the reset and publishing the matching frontend, resume using the new contract and current revision:

```sh
npm run ethereum111k-control -- resume --chain-id 11155111 --contract NEW_ADDRESS --expected-revision REVISION --write
```

Activate the new reveal deployment only after its status is `ready` and the matching API/frontend have been published. After the approved opening checks, the new owner separately calls `setSaleActive(true)` to enable purchases. Previously admitted work for the paused deployment continues to reconcile; its frozen artwork remains available by its original chain and contract.

Changing the allowed contract requires the old scope to be empty. The control does not change onchain sale or redemption switches; administer those separately and leave historical contracts as explicitly intended by the release.

## API and verification

Public reads are under `/ethereum/111k/config`, `/stats`, `/inventory` and `/metadata`. `/ethereum/111k/transactions/confirm` returns minted/burned items at first inclusion. Customer auth is under `/ethereum/auth/challenge`, `/verify` and `/logout`; profile/address/shipment data use `/ethereum/profile`, `/addresses` and `/shipments`. Delivery and claims each have `/prepare` and `/confirm` routes under `/ethereum/111k`.

Configuration advertises `maxUnboxQuantity: 15`. Select 2–15 crates to use **Open N crates**; larger selections keep delivery available and explain the opening limit. A batch is never silently truncated or split into multiple wallet transactions. Its final aggregate event proves the exact ordered selection during confirmation and recovery.

Inventory and transaction confirmation use contract batches of up to 150 token-info entries and 30 metadata entries. At most four calls share an RPC envelope, with two envelopes in flight and a 3 MiB response limit. Each response pins reads to one exact block hash and verifies it remains canonical before returning. A failed chunk or changed snapshot produces a retryable error instead of a partial inventory. A normal 30-item inventory page uses two contract calls instead of 60, excluding chain and snapshot checks and larger local ownership scans.

Sessions are scoped to wallet, chain, drop and browser origin. EOA and deployed ERC-1271 wallets are supported. Private routes use `X-Mons-Ethereum-Session`; POST requests also require `X-Mons-CSRF: 1`. Shipping addresses and secret codes stay offchain. The signer authorizes actions without paying gas or sending transactions.

Crate and artwork deliveries now open the standalone [hosted checkout](111k_checkout.md). Checkout persists its quote and submission attempt on the server, supports VVV entry/return links, and completes through background reconciliation even if the page closes before reporting the transaction hash. The existing five-minute schedule remains unchanged.

Other Ethereum transactions require working persistent browser storage. The app saves a submission reservation before requesting the transaction, so a reload or another tab cannot silently submit again. If saving the returned transaction hash fails, the app displays the hash and keeps the reservation. Recover using the matching transaction hash from the wallet, or explicitly stop tracking after checking the wallet.

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

Historical test counts, gas measurements, and implementation boundaries are in
[the October 18 validation record](../../releases/111k-validation-2026-10-18/README.md).

# 111K Ethereum test collection

The first version runs on a local Anvil chain or Ethereum Sepolia. It does not deploy remotely, request faucet funds, publish CDN files, purchase shipping labels, or send customer emails automatically.

The reserved relic claims implementation targets a fresh collection. Its contract, API, frontend, routing configuration, and commerce migration must roll out together; the new stats and claim interface is incompatible with existing collections. No existing deployment or live configuration is changed by local setup.

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

Fresh deployments have `saleActive()` false and zero allocated relics. Configure any relic supply and preorder proceeds as described below before opening the local sale explicitly from the unlocked Anvil owner. Use `contractAddress` and `owner` from the deployment manifest for these placeholders:

```sh
cast send LOCAL_CONTRACT_ADDRESS 'setSaleActive(bool)' true --from LOCAL_OWNER_ADDRESS --unlocked --rpc-url http://127.0.0.1:8545
```

Starting the API and provisioning local reveal inventory leave this switch unchanged. If you selected a custom owner or RPC port, use that owner's signer and the deployment's RPC URL.

The current local deployment manifest uses `protocolVersion: 15`. Restart Anvil, rerun `deploy:local`, and restart the API when upgrading an older local deployment; the API rejects older manifests with redeployment instructions and probes the batch, wallet-aware stats, and payout getters before starting. It checks immutable mint recipients and shares against the manifest and verifies the immutable constructor configuration 1 and its `initialDeliveryReceiver`. The backend signs a configuration ID; there is no global mutable receiver. The manifest records `metadataBaseURI`, which is verified against the collection’s `baseURI()`. Local deployment defaults to the replacement `https://cdn.mons.shop/111k-sepolia/v15/` publication; `ETHEREUM_111K_LOCAL_METADATA_BASE_URI` can select another published namespace. No metadata server or generator runs in normal local development. CDN connectivity is required; unavailable metadata produces an error rather than a local fallback. All manifests older than version 15 require a fresh deployment with relic claim availability, including older manifests with matching CDN URLs. The v10 namespace preserves its historical metadata names. Use a newly published relic namespace for the updated names; do not overwrite registered prefixes. The E2E test can validate newly generated metadata before publication. EIP-712 retains the domain name `111K`, version `2`, with the Delivery field `configId`; crate-claim signatures are unchanged and all signatures remain bound to their original contract address.

Both deployment scripts load `onchain/ethereum/config/proceeds.json`, which fixes the same 14 mint recipients for future Sepolia, mainnet, and local deployments. The shares total 10,000 basis points (100%). The three `vv` wallets divide their combined 17.5% as 5.83% / 5.83% / 5.84% in config order; the third wallet, `0xd9488d6687d656a55B3F1a36998d149f9b1bE2Cc`, receives the extra 0.01 percentage point. Two-letter `mintRecipientLabels` are descriptive metadata and may repeat; addresses identify recipients. The configuration supports 2–32 distinct, nonzero mint recipients whose positive basis points total 10,000; none may be the collection or the initial delivery receiver. Mint recipients/shares are fixed at deployment, and existing collections retain their original splits. See the [full configured split](../../onchain/ethereum/README.md#mint-splits-and-delivery-proceeds).

The local constructor's receiver comes from `onchain/ethereum/config/delivery-routing.json` as `{ "initialReceiver": "0x…" }`. It creates configuration 1 with 100% to that receiver. The backend uses `ETHEREUM_111K_DELIVERY_CONFIG_ID`, initially `"1"`; selecting a later ID requires the owner to register that immutable configuration first. Saved quotes retain their chosen ID across retries and configuration changes. The 32-configuration capacity includes the initial configuration, and unused capacity adds no withdrawal work.

For the new contract interface, anyone can submit `releaseAllMint()` to attempt every mint payout in one transaction, `releaseMint(address)` for one recipient, or `releaseDelivery()` for shipping fees, without access to an owner key. The caller pays transaction gas. Read `releasableMint(address)` or the cumulative delivery configuration records first; zero balances are a no-op. Batch payouts use a bounded 100,000-gas call budget per receiver, skip failed transfers with `MintProceedsReleaseFailed`, and preserve their unpaid entitlement for retry or individual release. Estimate gas before submitting; insufficient transaction gas reverts the batch. Mint and shipping accounting remain separate, each recipient can withdraw independently, and pauses do not stop payouts. Existing deployments retain their original limits and functions. The contract no longer exposes a full-balance `withdraw()` function. See the [proceeds documentation](../../onchain/ethereum/README.md#mint-splits-and-delivery-proceeds) for rounding and accounting details.


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

- One collection contains artwork, crates, warehouses, relics, artwork receipts, crate receipts and relic receipts. Digital artwork display numbers equal their sequential ERC-721 token IDs.
- A shared supply of 5,555 crate allocations covers individual purchases, warehouses and relics. Warehouse minting reserves 11 allocations per warehouse. Owner relic allocation reserves 111 per relic before claims or public sales. Opening either container burns it and mints its reserved crates without consuming supply again.
- Relic supply starts at zero. Before sales first open, the owner may allocate 1–18 relics once. Allowlisted wallets claim one selected ID from 1–18 at a time while sales are open, up to the allocated count. Transfers, opening and delivery never restore a claimed ID, wallet allowance or reserved crate allocation.
- Digital opening assigns the next 20 artwork token IDs, or 31 for crate #5555. Physical-only claim artwork numbers use `111111 + 20 × (n − 1) + 1` onward; crate #5555 ends at #222222.
- Public minting accepts 1–15 crates or warehouses per transaction. Initial prices are 0.0001 test ETH per crate and 0.0011 test ETH per warehouse. Relics have no public mint entrypoint or onchain price.
- Sales start closed. Only the owner can open them with `setSaleActive(true)`; use `setSaleActive(false)` to close purchases again.
- Digital opening accepts 1–15 crates in one atomic transaction, producing up to 311 artworks when crate #5555 is included. All selected crates burn before the first receiver callback; any failure rolls back the complete batch. Warehouses and relics open individually. Metadata is served from token-ID JSON files at `cdn.mons.shop`; crate opening uses the [reveal service](111k_reveal.md). See [offchain metadata](111k_metadata.md).
- Delivery accepts up to 50 owned artworks, crates and unopened relics in mixed orders, requires a backend authorization, and charges 0.0001 test ETH per order. One user transaction burns the originals and mints their receipts. Warehouses and receipts are ineligible for delivery. A relic burns into its same-numbered terminal receipt; its 111 reserved crate allocations remain consumed.
- New app deliveries sort a copied selection numerically by original token ID before signing. Receipt identities remain paired with those tokens. The contract validates the whole selection, burns every original, then safely mints receipts; callbacks see all originals already burned. Arbitrary signed input order remains supported.
- The owner can use `setRedemptionsPaused(true)` as an emergency onchain stop for delivery and crate-receipt claims. It leaves sales, unpacking, transfers, and withdrawals unchanged. The app and API do not read this switch. Pausing does not consume or extend signatures; use the existing signer rotation before resuming after a signer compromise.
- After three confirmations, the order becomes available in fulfillment. Re-mining below that threshold returns it to processing. Physical crates receive stable secret codes and their fixed placeholder contents. Entering a matching code lets the current crate-receipt owner submit one signed claim transaction that burns it and mints 20/31 artwork receipts.
- Digital artwork receipts use token IDs `1,000,000 + original token ID`; physical-only artwork receipts use 1,111,112–1,222,222. Crate receipts use `2,000,000 + crate number`. Relic receipts use `3,000,000 + relic number` and the shared `receipt_background.webp` placeholder. They can transfer but cannot be unpacked, redeemed or claimed for contents. Artwork receipts retain their placeholder media. Consumed token IDs and crate allocations are never reused.

Fulfillment uses existing Solana staff sign-in. The primary admin and designated address operator can view the Ethereum test drop. The app supports status/tracking updates, address editing, placeholder previews, contents, order/address exports and secret-code PNG/ZIP exports. Ethereum test orders are blocked from ShipStation and customer/shipper email paths on the server.

Re-mined claims awaiting three confirmations show “Confirming” in fulfillment. Pending and completed claims cannot export secret codes. Ethereum reconciliation limits its Commerce database work to 400 statements per run. Delivery and claim recovery run concurrently with separate 100-statement budgets and reuse verified receipts. Both stop after 30 seconds to leave time for event discovery; unfinished work resumes on later runs.

## Discounted crates

The draft allowlist contains the 317 holders of Ethereum mainnet collection `0x30f9efa712dde239a13a5fef1a8c7a6ac530a26d` at finalized block `26235186`, plus `0xE26067c76fdbe877F48b0a8400cf5Db8B47aF0fE`: 318 addresses total. The block hash, source collection, token range, counts, and canonical address digest are recorded in `onchain/ethereum/fixtures/discounts/source.json`; the holder list and explicit additions remain reproducible. Contract wallets and delegated EOAs are included.

The initial allowance is one discounted crate per wallet, priced at 0.00005 ETH. The owner can change the per-wallet allowance to 1–10 using `setDiscountConfig(root, allowance)` without resetting usage. Setting the root to zero disables discounts. `setPrices(cratePrice, warehousePrice, discountCratePrice)` changes the three prices together and rejects a discounted price above the public crate price. Changes to public prices do not automatically recalculate the discounted price.

Future deployments also enforce an immutable lifetime cap across all wallets. `onchain/ethereum/config/discount-caps.json` configures mainnet at 500 and Sepolia/local development at 5,555. Set each network value to an integer from 0 through 5,555 before deploying; zero disables discounted mints. `maxDiscountedMints` exposes the cap and `totalDiscountedMints` counts successful discounted crates, including purchases made when the configured discount price is zero. Changing the root, per-wallet allowance, or prices never resets that total.

Only successful `mintCratesDiscounted(quantity, proof)` purchases consume either discount allowance. Public purchases, free mints, transfers, and unboxing do not change it. Warehouses have no discounted-price path; relics use preorder claim allowances. The existing discounted mint button appears when the connected wallet is listed and its entire selected crate quantity fits both its wallet allowance and the remaining global cap. Selecting more uses public pricing for the entire purchase, matching the Solana drops.

The page loads the static Ethereum proof dataset once and reads the root, prices, allowance, wallet usage, and global cap counters through `GET /ethereum/111k/stats?owner=ADDRESS`, backed by one `stats(address)` contract call. Existing contracts with the legacy 12-field stats response remain supported without a global cap; new contracts append the cap and total usage as fields 13 and 14. It does not query the source collection while browsing. Connection, proof loading, and failed reads cannot silently submit a public-price transaction; mint terms are checked again before wallet submission. A root update requires publishing its matching proof dataset.

Generate and verify the committed artifacts offline:

```sh
npm --prefix onchain/ethereum run discounts:generate
npm --prefix onchain/ethereum run discounts:check
```

`npm --prefix onchain/ethereum run discounts:snapshot` rereads the same pinned mainnet block, with `ETHEREUM_DISCOUNT_SNAPSHOT_RPC_URL` available to select an RPC provider. It validates the complete ownership scan before writing. It does not advance the snapshot automatically.

Local deployment loads the committed root from `src/ethereum/discounts/111k.json`; `ETHEREUM_111K_LOCAL_DISCOUNT_ROOT` can override it for isolated tests. The Foundry deployment script requires `ETHEREUM_111K_DISCOUNT_ROOT`. The allowance and fixed discounted price start at their defaults on every fresh deployment.

## Free mint and relic claim allowances

Edit `onchain/ethereum/config/free-mints.json` before deploying. A/B/C are configuration group names; each group's `crates`, `warehouses`, and `relics` limits apply independently to every address in its `wallets` list. For example, set A to `100 / 1 / 0` and B to `5 / 0 / 0`. The committed templates have zero limits and empty wallet lists, so they grant nothing by default.

Both deployment paths flatten the groups into at most 32 unique wallet allocations and pass them to the constructor. Owner and deployer can differ. The constructor grants allowances without minting anything; the collection still starts closed. The local manifest records `freeMintAllocations`. The public Foundry script defaults to the same file and accepts `ETHEREUM_111K_FREE_MINT_CONFIG` for another file permitted by Foundry's filesystem configuration.

```sh
npm --prefix onchain/ethereum run free-mints:check
npm --prefix onchain/ethereum run free-mints:calldata -- COLLECTION_ADDRESS
```

The second command prepares unsigned owner calls for later updates and does not broadcast them. Execute the generated calls as the collection owner. Updates replace total limits while preserving lifetime usage; omitted wallets are unchanged, and zero limits explicitly revoke remaining entitlement. Limits are checked per wallet, but their sum does not reserve inventory. Relic inventory is reserved separately by the owner allocation call. The 32-wallet bound applies to one configuration or update batch, not all wallets ever configured.

Call `mintFree(uint8,uint256)` with kind `2` for crates or `3` for warehouses, and quantity 1–15. It requires `saleActive` and zero ETH. Free mints share paid-mint supply; warehouses consume 11 crate allocations. Relics use the separate `claimRelic(uint256)` call described below; kind `6` is rejected by `mintFree`. Usage is independent of discounts and is not restored by transfers, unpacking, or configuration changes. `freeMintAllowances(address)` exposes `crateLimit`, `warehouseLimit`, `relicLimit`, `cratesUsed`, `warehousesUsed`, and `relicsUsed`.

The shop exposes the selected-relic claim grid beside the crate and warehouse controls; generic free mint controls remain absent. Relic mode hides the quantity slider and price, shows all 18 IDs, and dims permanently claimed IDs. Availability refreshes every four seconds while visible and is rechecked before submission. Existing deployments retain their original bytecode. See the [contract documentation](../../onchain/ethereum/README.md#per-wallet-free-mints) for configuration examples, validation, events, and accounting details.

## Relic allocation and preorder proceeds

Before the first `setSaleActive(true)`, the owner can call `allocateRelics(uint256 quantity)` once with a quantity from 1 through 18 and the total preorder payment as transaction value. Zero ETH is allowed. The call permanently reserves `quantity * 111` crate allocations and adds exactly the attached ETH to `totalMintReceived`. It emits `RelicsAllocated`; `releaseAllMint()` and `releaseMint(address)` distribute that revenue through the fixed mint split, independently of delivery fees. No relic NFT is minted by allocation, and there is no general-purpose deposit endpoint.

For local testing, use the owner and contract from the deployment manifest:

```sh
cast send LOCAL_CONTRACT_ADDRESS 'allocateRelics(uint256)' RELIC_COUNT --value PREORDER_TOTAL_WEI --from LOCAL_OWNER_ADDRESS --unlocked --rpc-url http://127.0.0.1:8545
```

Set each preorder wallet's total `relics` allowance using the existing configuration and owner calldata tool, then open sales. Allocation cannot be repeated, increased, decreased, or performed after sales have ever opened, including after closing them again. If no allocation was made before opening, relic supply stays zero.

While `saleActive` is true, an allowed wallet calls `claimRelic(uint256 relicId)` with no ETH. The argument is the display ID from 1–18, not the ERC-721 token ID. Any unclaimed ID is selectable: allocating three relics allows three claims chosen from all eighteen IDs. Each successful claim uses one remaining wallet allowance and one reserved slot, mints the selected NFT to the caller, and emits `RelicClaimed`. Claims assign the next reserved 111-crate range without changing `allocatedCrates` or mint proceeds. Claimed IDs cannot be reused after transfers, unpacking, or delivery. There is no batch relic claim.

`stats(address)` includes `relicsAllocated` and `relicsMinted` as fields 11 and 12 (zero-based indices 10 and 11) in both the legacy 12-field and new 14-field responses; the API reports remaining relic supply as their difference. New deployments append `maxDiscountedMints` and `totalDiscountedMints` as fields 13 and 14. `getRelicClaimedMask()` returns bits 0–17 for permanently claimed IDs 1–18, including relics already opened or redeemed. The `/ethereum/111k/relics` API reads the mask, statistics and wallet allowance at one canonical block snapshot; direct contract calls are reflected without an application-side reservation.

## Explicit Sepolia claim preset

`onchain/ethereum/config/free-mints.sepolia.json` grants three relic claims to each of four test wallets and two each to three additional wallets, for 18 claims across seven wallets. The current preset replaces `0x440f0940F7fc3b5C4Efd087F8B947C85aD81FDe9` with `0x29f7a2cfe212492dDB343035479D062112284DDf` in a three-claim slot; historical deployment manifests retain their original constructor inputs. It grants no free crates or warehouses. It declares `chainId: 11155111`; both the JavaScript and Foundry configuration readers reject it on mainnet, Anvil, or without an explicit matching chain. Generic `config/free-mints.json` stays empty. Ordinary deployment starts closed with zero reserved relics and never reserves supply, deposits money, or opens sales.

The same wallet replacement was applied to live v12 on November 2, 2026. The [verification record](../../releases/111k-sepolia-v12/wallet-replacement-2026-11-02.json) contains both confirmed owner transactions, before/after allowances, and claim simulations: the new wallet has three unused relic claims and the old wallet has zero. Other wallet allowances and the eighteen-relic reservation are unchanged.

```sh
npm --prefix onchain/ethereum run free-mints:check -- config/free-mints.sepolia.json --chain-id 11155111
npm --prefix onchain/ethereum run free-mints:calldata -- SEPOLIA_COLLECTION_ADDRESS config/free-mints.sepolia.json --chain-id 11155111
```

Select the preset explicitly for a Sepolia deployment with `ETHEREUM_111K_FREE_MINT_CONFIG=config/free-mints.sepolia.json`. The checked-in Sepolia release runner uses separate, journaled deploy, reserve and open steps. Its owner reservation is exactly `allocateRelics(18)` with `18000000000000000` wei (0.018 Sepolia ETH), before opening. This reserves 1998 crates, leaving 3557 for public sales, and leaves all 18 claims untouched for the test wallets. The deposit is not automatically distributed.

For mainnet, provide its real preorder allowance configuration later and explicitly make the owner reservation/payment call before opening. Never use the Sepolia preset or derive mainnet launch actions from testnet defaults.

## Sepolia configuration

The [v15 release](../../releases/111k-sepolia-v15/README.md) deploys catalog `111k-v4` at `0xe665d1043f72886f49894006ea196450b33f0f89`, Sepolia block `12085980`, with metadata under `https://cdn.mons.shop/111k-sepolia/v15/`. It uses the final CDN dimensions map: 76,642 eggs, 30,990 paintings, 58 videos, 3,000 3D models, and 421 animated artworks. Egg IDs 1–76,642 fill the remaining supply from 76,700 available PNGs. Artwork media uses `https://cdn.lil.org/nft/111k/`. See the release record for opening and live QA status, and the [asset catalog guide](../ethereum-metadata/reveal-assets/111k_devnet/README.md) for future imports. New imports require a new catalog version and deployment prefix.

The historical [v14 release](../../releases/111k-sepolia-v14/README.md) deploys the `111k-v3` reveal catalog at `0x6d194e6cc762424e408b84907c25d60f0db29d12`, created at Sepolia block `12054659` in [transaction](https://sepolia.etherscan.io/tx/0x2ac17afbb6619f24f4085f3ff65cd56c35a893a65ac1062dd8227c7016f20fe8). Its fresh metadata namespace is `https://cdn.mons.shop/111k-sepolia/v14/`. The pool contains 22,222 eggs, 84,454 paintings, 3,333 videos, 1,000 3D models, and 102 animated artworks, totaling 111,111. Animated assets replace painting IDs 84,455–84,556 and use per-asset ratios, initially 466:503 (932 × 1006). Artwork categories remain offchain; this category addition changes no Solidity supply or artwork token ranges.

V14 was deployed with sales closed. The [closed reservation verification](../../releases/111k-sepolia-v14/deployment-reserved.json) records zero issuance and eighteen reserved relics with 0.018 Sepolia ETH, consuming 1,998 crate allocations and leaving 3,557 for public sales. Its immutable lifetime discounted-mint cap is 5,555, with zero discounted mints used. The Sepolia allowance profile preserves eighteen claims across seven wallets, including the November 2 wallet replacement. Release verification uses no public mint, unpack, or claim transactions. Application cutover and acceptance precede sale opening; consult the v14 release record for activation status.

The [v13 release](../../releases/111k-sepolia-v13/README.md) records the preceding `111k-v2` catalog and interactive 3D viewer at `0x8ef2789bc22098749a8ca746263fd85442949eff`, Sepolia block `12051125`, with metadata under `https://cdn.mons.shop/111k-sepolia/v13/`. The v14 cutover retires v13 from reveal API execution while preserving its NFTs, metadata, and ledger. V12 and earlier release records also remain preserved.

The [v9 release](../../releases/111k-sepolia-v9/README.md) preserves the preceding receipt collection under its original terminology at `0x4d127fceeaa8b652744c4cb1f62f1101290180a8`, block `12033427`, with metadata under `https://cdn.mons.shop/111k-sepolia/v9/`. V9 and older metadata and reveal ledgers remain historical records.

The [v7 release](../../releases/111k-sepolia-v7/README.md) records the preceding collection at `0xc7571e9dc4b1cd646d092d51cfa89a76a6461fec`, block `12029091`; preserve its metadata and reveal ledger when replacing it. Earlier release records remain historical. Estimate deployment gas against the live Sepolia RPC and verify the exact creation payload with `eth_call`; local Prague benchmarks are not deployment gas limits. The API uses these settings:

| Setting | Meaning |
| --- | --- |
| `ETHEREUM_111K_CHAIN_ID` | `11155111` for Sepolia; `31337` for local testing |
| `ETHEREUM_111K_CONTRACT_ADDRESS` | Collection contract; blank keeps it undeployed |
| `ETHEREUM_111K_METADATA_BASE_URI` | Exact public R2 metadata prefix fetched over HTTP for this deployment |
| `ETHEREUM_111K_DEPLOYMENT_BLOCK` | First block for bounded event reconciliation |
| `ETHEREUM_111K_RPC_URL` | Local loopback RPC only; unused for Sepolia |
| `ETHEREUM_111K_DELIVERY_CONFIG_ID` | Registered delivery configuration selected for new quotes; initial value `1` |
| `ETHEREUM_111K_REDEMPTION_SIGNING_ENABLED` | Set to `"true"` and redeploy the API Worker to resume issuing delivery and crate-receipt claim signatures. The production setting is `"false"` during the pause. |
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

Before resetting the old collection, close its onchain sale and call `setRedemptionsPaused(true)` so outstanding authorizations cannot execute. Set `old_manifest` to its saved deployment manifest, inspect it with `npm run ethereum-reveal-control -- status --manifest "$old_manifest"`, then pause its reveal admission using `npm run ethereum-reveal-control -- pause --manifest "$old_manifest" --expected-revision REVEAL_REVISION --write`. Keep this path separate from the replacement's `new_manifest`. Keep its permanent OPS deployment record, private reservations, frozen assignments, and metadata objects. Ethereum commerce reset does not remove this reveal state. Publish and verify placeholders at a fresh `111k-sepolia/<deploymentId>/` prefix, pass that exact URL as `ETHEREUM_111K_METADATA_BASE_URI` to the new contract deployment, and register/provision the new reveal deployment using the [reveal operator guide](111k_reveal_ops.md#operator-setup). Never reuse the old metadata prefix.

Use the replacement manifest's globally unique deployment ID and metadata URI for every new-collection operation. Its full 344984-object baseline must be verified before deployment and registration. Keep its onchain sale closed while configuration, reveal provisioning, scoped commerce reset, and application verification complete.

For a replacement, keep the control paused on the old contract and allow at least 65 seconds for in-flight operations to drain. Recheck the revision, privately back up and reset the old scope before applying the new config-ID migration or publishing the replacement API:

```sh
npm run reset:ethereum111k -- --chain-id 11155111 --old-contract OLD_ADDRESS --expected-revision REVISION
npm run reset:ethereum111k -- --chain-id 11155111 --old-contract OLD_ADDRESS --expected-revision REVISION --reset-id RESET_UUID --write
```

The write command rebuilds its snapshot, saves a private backup under `~/.mons-shop-backups/ethereum111k`, and deletes only the specified deployment's quotes, checkouts, checkout attempts, claims, cursor, and corresponding delivery projections/recovery records in one guarded batch. Unexpected outboxes, inventory, pack-status history, reveal submissions, or another deployment's documents stop the reset. Shared profiles, addresses, authentication data, and concurrency tombstones are preserved. If a response is uncertain, inspect status and rerun with the same reset ID to reconcile the recorded outcome.

After verifying the reset, applying the migration, and publishing the matching API and frontend, resume using the new contract and current revision:

```sh
npm run ethereum111k-control -- resume --chain-id 11155111 --contract NEW_ADDRESS --expected-revision REVISION --write
```

Use `npm run ethereum-reveal-control -- status --manifest "$new_manifest"` to obtain the replacement's current revision. Activate that same manifest only after its status is `ready` and the matching API/frontend have been published, following the reveal runbook. After the approved opening checks, the new owner separately calls `setSaleActive(true)` to enable purchases. Pausing a current-catalog deployment preserves admitted recovery and frozen API reads. Retiring an older catalog stops its API and background execution while preserving its published CDN metadata and saved ledger; retired v1–v3 requests return `409`.

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

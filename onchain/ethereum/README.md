# 111K contracts

The separate [pre111k reservation contract](PRE111K.md) accepts backend-authorized relic preorders and forwards withdrawals to the fixed treasury. It does not change this NFT collection's issuance or claim allowances.

An ERC721A collection with public crate and warehouse sales, allocated preorder relic claims, allowlist crate discounts, per-wallet free mint allowances, atomic unpacking, signed delivery quotes, physical crate claims, and offchain JSON metadata. Contract logic is non-upgradeable. The owner can change prices, discount eligibility and allowance, free mint allowances, sale status, the emergency redemption pause, the authorization signer and metadata base URL, and register immutable delivery configurations. Mint recipients, their shares, and the lifetime discounted-mint cap are fixed at deployment.

The [v16 release](../../releases/111k-sepolia-v16/README.md) is the supported Sepolia collection: `0x938b6a488951b2797b29284d6939dd70efe146a0`, block `12087015`, catalog `111k-v5`, and metadata under `https://cdn.mons.shop/111k-sepolia/v16/`. It keeps the 111,111-artwork allocation, eighteen reserved relics, and a lifetime discounted-mint cap of 5,555. The [testnet cleanup record](../../releases/111k-testnet-cleanup-2026-11-08/README.md) tracks retirement of superseded testnet metadata and backend state. Prior deployment evidence remains in [Git history](https://github.com/supermetalmons/shop/tree/8c3de5aea944c3c7d67f1f5c9800c78afb7d6340/releases); onchain contracts and transactions remain unchanged. Sepolia's Glamsterdam state-creation pricing requires live RPC gas estimates; local Prague benchmarks and Forge simulation estimates must not be used as Sepolia deployment limits.

Ownership transfers require the new owner to accept. `renounceOwnership()` is disabled and reverts with `OwnershipRenunciationDisabled()` for the owner, preserving signer rotation and emergency controls. Proceeds releases are permissionless. Existing deployments need a fresh deployment to gain this protection; the authorization protocol remains version 2.

The contract dependencies are `erc721a@4.3.0` and `@openzeppelin/contracts@5.6.1`; allowlist tooling uses OpenZeppelin's standard Merkle-tree generator. Foundry and Solidity 0.8.38 must already be installed. Builds and tests use `--offline` and do not download compilers. Historical benchmark reproductions also require Solidity 0.8.30. No Hardhat or forge-std dependency is needed.

## Check

Run from `onchain/ethereum`:

```sh
npm ci --ignore-scripts
npm run check
```

`npm test` regenerates deterministic authorization/calldata vectors in `fixtures/eip712.json`. `scripts/check-fixtures.mjs` validates those authorization fixtures. Regenerate `shared/ethereum/abi.generated.ts` after changing the contract interface:

```sh
npm run build
npm run abi
```

The repository-root `npm run check:all` runs these checks and the extended invariants in a disposable source copy, keeping committed fixtures unchanged. It also covers the application, Ethereum E2E, Solana SBF, and native renderer suites; see the [validation prerequisites](../../README.md#validation).

The tests cover relic supply and lifetime caps, mixed relic/warehouse/direct allocation, every allocation in a 5,555-crate mixed warehouse/direct sale, all 111,111 resulting artwork identities, the 31-item bonus on both routes, sequential digital identities and disjoint physical receipts, arbitrary unpacking order, transfers and burns, replay protection, receiver callbacks, rollback, independent payout failures, and metadata. Delivery tests also verify receipt commitments and confirm that token-based artwork identities stay stable after an opening-order reorg.

Stateful invariant tests mix public and discounted purchases, free mints and allowance changes, transfers, unpacking, delivery, claims, and pause changes across multiple owners. An independent model checks token identities, ownership, balances, allocations, discount and free mint usage, and consumed authorizations. A separate payout model mixes accepting, rejecting, and expensive receivers, new revenue, delivery configuration registration, individual withdrawals, and batch retries. It checks cumulative entitlements, retained credits, receiver balances, and ETH conservation after every action. Normal checks use 128 sequences of 64 calls and fail on unexpected handler reverts. Run both suites with the longer campaign:

```sh
npm run test:invariants:extended
```

That campaign uses 512 sequences of 128 calls. Receiver regressions also exercise reentrancy, rejected callbacks, transfers during callbacks, and multiple operations within a single transaction. Reentrancy locks use transient storage, which requires EIP-1153; the configured Prague EVM supports it. The locks are cleared before a successful call returns so subsequent calls in the same transaction remain safe.

Gas snapshots exclude scenario setup and signature preparation. With `--isolate`, write-call measurements include transaction intrinsic gas and any applicable calldata floor; view calls remain ordinary call-gas measurements. `npm run check` requires every benchmark to succeed and produce its expected runtime measurement, then compares those measurements with the committed snapshots without updating them. Filtered tests and missing or renamed measurements fail the check. Use these commands for a separate check or an intentional baseline update:

```sh
npm run gas:check
npm run gas:update
```

Compare snapshots using the same Foundry, Solidity, optimizer, and EVM settings. Snapshot values are gas units, not ETH fees, and omit any outer contract-wallet transaction overhead. Differently ordered authorizations can also differ slightly in signature-byte calldata cost. Gas isolation applies only to the benchmark suite; security tests retain same-transaction execution.

## Offchain metadata

`NFT111K` constructs metadata URLs from its deployment's registered prefix: `https://cdn.mons.shop/111k-sepolia/{deploymentId}/{tokenId}.json` on Sepolia and `https://cdn.mons.shop/111k/{deploymentId}/{tokenId}.json` on mainnet. These URLs serve authoritative JSONs directly from public R2. The [metadata guide](../../scripts/docs/111k_metadata.md) is the canonical reference for identities, template generation, publication, access, caching, and testing.

The repository's metadata CLI generates collection JSONs from committed templates for publication. Runtime metadata comes from the CDN; normal local development does not run a metadata generator or server. Unit tests use synthetic responses, while the Anvil end-to-end flow reads the current CDN JSONs or an explicitly configured local metadata directory.

## Local chain

Follow the [local chain, API, and frontend setup](../../scripts/docs/111k_testnet.md#run-locally) for commands, configuration, sale activation, and manifest upgrades. The deployment helper accepts only loopback Anvil RPC on chain ID 31337 and writes `.local/deployment.json`. The isolated API uses temporary databases and local test keys. Public deployments require a separately provisioned signer.

## Future public network deployments

Every Sepolia replacement includes [immediate retirement of the superseded
deployment](../../scripts/docs/111k_reveal_ops.md#superseded-testnet-retirement)
once the new deployment is active and verified. Deploy the retirement migration
and Worker before cutover. The runner's `open` action automatically finalizes
cleanup, including same-catalog replacements, and does not report success until
old backend data, release artifacts, caches, and backups are purged and verified.

The checked-in Sepolia release runner uses an encrypted Foundry keystore and a
private transaction journal. From the repository root, prepare a new, unused
deployment ID and absolute release directory:

```sh
deployment_id='<new-deployment-id>'
release_dir="$PWD/.cache/111k-${deployment_id}-release/contract"
npm --prefix onchain/ethereum run nft111k:deploy -- prepare --network sepolia \
  --deployment-id "$deployment_id" --previous-contract OLD_ADDRESS --directory "$release_dir"
```

Preparation requires an explicit fresh deployment ID. It derives the predecessor
from matching repository and live Sepolia configuration; an explicit
`--previous-contract` must match that current predecessor. Paused storefronts are
accepted. Frozen release resumes keep their original predecessor after cutover.
Private release locations are recorded for the next cleanup. For a predecessor
created before location tracking in a custom directory, pass `--previous-directory
PATH` to `prepare` or recovery `finalize`. Use an empty dedicated directory for
new releases and keep keystores outside it.
Preparation freezes the current contract sources, compiler input/output,
constructor configuration, nonce, predicted address, and gas allowance. It reads
the fourteen-recipient split, seven-wallet Sepolia allowance preset, delivery
routing, and discount configuration. Publish and verify the full baseline at
the deployment's exact metadata prefix before broadcasting `deploy`.

Use the same directory for `deploy`, `reserve`, `pause-old`, `open`, `mint-qa`,
and `unpack-qa`, supplying `--keystore PATH --password-file PATH` for signing.
Passwords must come from private temporary files, never command-line values.
Each action saves the signed transaction before broadcasting and waits for three
canonical confirmations. Retry the same action after an uncertain response;
the journal prevents duplicate deployment, reservation, or QA purchases.
Retries reject signed actions whose canonical prerequisites have changed.
New directory locks recover stopped owners safely; a leftover lock file from
the earlier runner is rejected and must be removed only after confirming its
process has stopped.
`reserve` allocates eighteen relics with 0.018 Sepolia ETH. `pause-old` closes
the frozen previous collection's sale and redemptions. Complete the
[application cutover](../../scripts/docs/111k_testnet.md#ethereum-maintenance-and-replacement)
before `open`; `mint-qa` buys one ordinary crate for 0.0001 Sepolia ETH and
`unpack-qa` uses its purchase event to select the exact crate.

During cutover, update the API metadata URI, the shared default in
`shared/ethereum/config.ts`, and this project's `Deploy111K.s.sol` local fallback
together. The finalizer blocks retirement while supported local/default consumers
still point at the old namespace.

`open` verifies the replacement and automatically invokes the reusable finalizer,
which requires existing Cloudflare operator credentials. The opening transaction
stays journaled if retirement fails. Resume cleanup with
`nft111k:deploy finalize --network sepolia --directory "$release_dir"`; it does not
rebroadcast opening or require another signature. The finalizer protects the new
deployment, retires and drains the predecessor, purges its data and owned local
artifacts, and checks for recreation after a scheduler interval. `verify` remains
read-only. See [finalization commands](../../scripts/docs/111k_reveal_ops.md#automatic-finalization).

`npm --prefix onchain/ethereum run nft111k:verify -- verify --directory "$release_dir" --stage STAGE`
checks `closed`, `reserved`, `open`, `mint-qa`, or `unpack-qa` against one canonical
snapshot, including the complete runtime and constructor immutables. The same
verification command provides `prepare-sources`, `sourcify-submit`,
`sourcify-status`, `sourcify-verify`, `etherscan-submit`, `etherscan-status`, and
`etherscan-verify`. Supply RPC credentials and `ETHERSCAN_API_KEY` through the
environment. Only sanitized verification reports belong in `releases/`; retain
the signed-transaction journal in the private directory. These tools support
Sepolia only. Their tests run the complete lifecycle on a local Anvil instance.

`script/Deploy111K.s.sol` prepares a fresh collection on Ethereum mainnet (chain ID 1) or Sepolia (11155111) using `ETHEREUM_111K_DEPLOYER_KEY`, `ETHEREUM_111K_OWNER`, `ETHEREUM_111K_QUOTE_SIGNER`, `ETHEREUM_111K_INITIAL_DELIVERY_RECEIVER`, `ETHEREUM_111K_DISCOUNT_ROOT`, and `ETHEREUM_111K_METADATA_BASE_URI`. It reads the immutable mint split from `config/proceeds.json`, and initial free allowances from `config/free-mints.json`. `ETHEREUM_111K_FREE_MINT_CONFIG` can select another readable configuration file. Existing contracts are non-upgradeable; deployments that predate free-mint support require a new collection address to add it. Contracts with free-mint support can update allowances through owner-only `setFreeMintAllowances`. Replacing the existing Sepolia collection also uses its scoped commerce-state reset. The first mainnet deployment starts with fresh state.

The lifetime discounted-mint cap is selected from [`config/discount-caps.json`](config/discount-caps.json): mainnet starts at **500**, while Sepolia and local development start at **5,555**. Edit the network value before a future deployment to choose a cap from 0 through 5,555; zero disables discounted mints. `ETHEREUM_111K_DISCOUNT_CAP_CONFIG` selects an alternate readable config for the Foundry script. The local deployment helper reads the `local` value from the committed file and records it as `maxDiscountedMints` in its manifest. The constructor fixes `maxDiscountedMints` for the life of that collection. Existing contracts retain their original behavior and require a fresh deployment to gain this cap. Granular free mint and relic claim allowances are separate and never consume it.

Sales are closed from contract creation. Verify the fresh collection's zero issuance, configuration, bytecode, and metadata while it remains closed, then have the owner call `setSaleActive(true)` as a separate launch action. Public acceptance uses read-only checks; minting and opening tests run on the local EVM. No deployment-time pause transaction is needed. Existing deployed contracts retain their current sale state.

Each public deployment requires its own metadata namespace: `https://cdn.mons.shop/111k/{deploymentId}/` on mainnet or `https://cdn.mons.shop/111k-sepolia/{deploymentId}/` on Sepolia. Deployment IDs must be unique across networks; use distinct IDs such as `mainnet-relics-v1` and `sepolia-relics-v1`. The script rejects bare collection roots, the other network's prefix, and unsupported chain IDs. Publish and validate the full seven-kind metadata set for the selected namespace before configuring it on a deployed collection. The set includes relic tokens 117172–117189 alongside the existing artwork, crate, warehouse, and receipt ranges.

`NFT111KDeploymentTest` executes the deployment script locally for both public chain IDs with test keys and configuration. It checks the deployed collection's owner, signer, EIP-712 domain, proceeds configuration, initial free allowances, lifetime discounted-mint cap, default prices, runtime size, and metadata boundaries for all seven kinds. It verifies zero issuance while closed, rejects paid, discounted, and free mint paths and unauthorized activation, and explicitly opens sales as the owner. It allocates the lifetime maximum of 18 relics with a preorder deposit before activation, claims their chosen IDs one at a time, transfers one through the network's default Seaport approval, opens its 111 reserved crates, verifies the cap remains consumed, and releases the deposit to the configured recipients. Run this focused integration check without a public RPC:

```sh
forge test --offline --match-contract '^NFT111KDeploymentTest$' --gas-snapshot-emit=false
```

This check runs in Foundry's local EVM. Public deployment, funding, metadata publication, and the commerce-state reset remain separate operator actions.

## Seaport trading

Future deployments automatically approve Seaport 1.6 at `0x0000000000000068F116a894984e2DB1123eB395` on Ethereum mainnet (chain ID 1) and Sepolia (11155111). `isApprovedForAll(holder, SEAPORT)` returns true by default, allowing direct Seaport trades without an initial `setApprovalForAll` transaction. Other chains, including local Anvil, retain explicit approvals. Existing deployments are non-upgradeable and retain their original approval behavior.

Each holder can revoke this default with `setApprovalForAll(SEAPORT, false)` and restore it with `setApprovalForAll(SEAPORT, true)`. These calls emit the standard `ApprovalForAll` event. Revocation remains in effect for that wallet across mints, unboxing, redemption, and incoming transfers. Other holders retain their own approval settings. As with ordinary ERC721 approvals, revoking an operator does not clear a separately granted token-specific approval.

The fixed Seaport operator is authorized for every token kind: artworks, crates, warehouses, relics, and receipts. Seaport still validates order authorization and settlement; a seller normally signs an offchain listing and the buyer submits the fulfillment transaction. Unboxing, delivery, and receipt claims still require the actual token owner. The collection owner cannot replace or extend the automatically approved operator.

The NFT transfer must use direct Seaport routing: a seller's listing uses a zero `conduitKey`, while a seller accepting an offer uses a zero `fulfillerConduitKey`. Conduits, including OpenSea's conduit, require separate explicit approvals. Integrations must query `isApprovedForAll` before requesting approval; the default permission does not emit an initial `ApprovalForAll` event. This removes the NFT approval step only; ERC20 payment approvals and settlement transactions retain their normal requirements.

`NFT111KSeaportTest` covers automatic approvals, transfers, revocation, other operators and chains, and owner-only product actions offline. The optional fork suite checks signed order fulfillment, invalid signatures, and revocation against the deployed Seaport 1.6 contract. Set `ETHEREUM_RPC_URL` to an Ethereum mainnet or Sepolia RPC and run:

```sh
forge test --offline --match-contract '^NFT111KSeaportForkTest$' --fork-url "$ETHEREUM_RPC_URL" --gas-snapshot-emit=false
```

These tests deploy and trade only inside the local fork. They are explicitly skipped in ordinary offline runs without an active fork. Add `--fork-block-number` to pin a reproducible chain snapshot.

## Mint splits and delivery proceeds

Both deployment scripts read [`config/proceeds.json`](config/proceeds.json). The committed configuration fixes the same 14 mint recipients for future mainnet, Sepolia, and local deployments, totaling 10,000 basis points (100%). In config order, the split is `bi` 27.5%, `Pa` 26%, `Me` / `Tu` / `Gr` / `To` 5% each, `na` / `di` / `Lu` / `ch` 1% each, `mo` 5%, and the three `vv` wallets 5.83% / 5.83% / 5.84%. Their combined 17.5% is divided as evenly as basis points allow; the third `vv` wallet, `0xd9488d6687d656a55B3F1a36998d149f9b1bE2Cc`, receives the extra 0.01 percentage point. The parallel `mintRecipientLabels` array is descriptive two-letter metadata; duplicate labels are allowed and addresses identify recipients. There are no treasury environment overrides. Configuration is validated before broadcasting, including duplicate mint recipients and the predicted collection address. Existing deployed collections retain their original splits.

A deployment accepts 2–32 distinct, nonzero mint recipients with positive integer basis points totaling 10,000. Their addresses and shares cannot change. Basis-point precision remains 0.01%; 32 exactly equal shares are not representable, but sixteen shares of 313 and sixteen of 312 total 10,000. Existing deployed contracts retain their original limits and functions; the expanded limit and batch release require a new deployment. Public crates, discounted crates, warehouses, and relics credit their actual ETH payment to `totalMintReceived`; unboxing and receipt claims do not earn additional proceeds. Delivery fees increment only the signed configuration's cumulative `totalReceived` counter.

`mintRecipientCount()`, `mintRecipients(index)`, and `mintSharesBps(recipient)` expose the fixed split. `mintReleased(recipient)`, `totalMintReleased`, and `releasableMint(recipient)` expose mint payouts and pending amounts. `deliveryConfigCount()` and `deliveryConfigs(id)` expose delivery recipients, shares, cumulative receipts, and released amounts. Each mint recipient is entitled to `floor(totalMintReceived * shareBps / 10000) - mintReleased(recipient)`. Entitlements use cumulative receipts, so small payments do not repeatedly lose rounding fractions; after everyone claims, at most 13 wei remain with the configured 14 recipients (31 wei at the supported maximum of 32). These fractions remain reserved for later accrual and can remain permanently after the final sale.

Anyone may call `releaseAllMint()` to attempt all configured mint payouts in one transaction, `releaseMint(address)` for one known recipient, or `releaseDelivery()` for all registered delivery configurations. The caller pays transaction gas; no payout is automatically triggered by a purchase. Zero pending amounts are skipped. Callers cannot redirect or choose an amount. The batch forwards an explicit gas budget of 100,000 per ETH call (`MINT_PAYOUT_GAS_LIMIT`, plus the EVM value-transfer stipend), skips failed transfers, and emits `MintProceedsReleaseFailed(recipient, amount)` while preserving the full unpaid entitlement. Successful transfers emit `MintProceedsReleased`. Estimate transaction gas before submitting: insufficient remaining gas for a full payout attempt reverts the entire transaction with `InsufficientMintPayoutGas`, rather than misreporting underfunded calls as recipient failures. Contract wallets requiring more callback gas can use the individual `releaseMint(address)` fallback, which retains normal gas forwarding and reverts on a failed transfer.

Batch and individual releases share reentrancy protection. Recipient failure cannot block minting, delivery, or independent releases to other recipients. Sale and redemption pauses do not block releases. Batch release pays only claimable mint proceeds; it does not release delivery fees or rounding dust. The old `withdraw()`, `treasury()`, and `setTreasury(address)` interfaces are removed; there is no unrestricted balance sweep. Approvals and transfers reject nonzero ETH payments. Forced ETH is not counted as either kind of revenue and cannot be recovered through these functions.

The constructor creates configuration **1** atomically: `initialDeliveryReceiver` receives 100% of delivery proceeds, with zero secondary receiver and zero secondary basis points. It validates the receiver after mint recipients are known. The contract starts with one configuration and closed sales, even if the deployer and initial owner differ.

The owner can add immutable configurations with `registerDeliveryConfig(address receiver1, address receiver2, uint16 receiver2Bps)`. IDs start at 1 and the lifetime capacity is 32, including the constructor configuration. Single mode requires zero secondary receiver and zero basis points. Split mode requires distinct receivers and 1–9,999 secondary basis points. Active receivers cannot be zero, the collection, or mint recipients. Changing recipients or percentages requires a new ID; existing configurations and earned funds cannot be reassigned.

The signed quote contains only `configId` for payment routing. Redemption validates that it exists and credits its cumulative revenue, without ETH callbacks or per-receiver writes. `releaseDelivery()` is public, takes no arguments, and attempts all unpaid entitlements for all registered configurations. For cumulative revenue `T`, the secondary entitlement is `floor(T * receiver2Bps / 10000)` and the primary receives the remainder, minus their previous payouts. Fractional secondary shares carry across orders. Withdrawals never reset the cumulative revenue counter.

Batch payouts use the same bounded-call mechanism as mint payouts, skip failed receivers, and retain their unpaid amounts without blocking others. `releaseDeliveryFor(uint256 configId, bool secondary)` is the optional permissionless normal-gas fallback for a receiver that needs more callback gas; a failed fallback reverts. Mint and delivery accounting remain separate. There are no mutable global delivery totals or per-address delivery balance getters; aggregate reporting can sum the public configuration records or events.

The API selects the server-only `ETHEREUM_111K_DELIVERY_CONFIG_ID`, initially `"1"`. Before creating a quote it validates the selected onchain configuration. Each quote saves its ID once, and retries/deadline refreshes reuse it despite later environment changes. Clients cannot select a configuration. `DeliveryRedeemed` includes the signed ID, and transaction/receipt recovery checks it against the saved quote. Migration 0047 requires the old test quotes to be cleared through the guarded reset before application, then adds a required immutable `config_id` with no legacy backfill.

Local deployments read `{ "initialReceiver": "0x…" }` from `config/delivery-routing.json` and record `initialDeliveryReceiver` and `deliveryConfigId: 1` in manifest version 14. The local API verifies configuration 1 and may select another registered ID via `ETHEREUM_111K_DELIVERY_CONFIG_ID`. Public deployment requires an explicit bootstrap receiver, read and rechecked from the old collection before broadcast. Historical contracts, metadata and release reports remain separate; the application has one registered-configuration protocol.

## Allowlist crate discounts

`mintCratesDiscounted(uint256 quantity, bytes32[] proof)` proves the caller's address against `discountMerkleRoot` using OpenZeppelin's standard double-hashed address leaf. It accepts only the exact `quantity * discountCratePrice` payment and increments both `discountUsed[msg.sender]` and `totalDiscountedMints` before receiver callbacks. A purchase must fit both the wallet allowance and the remaining lifetime cap; crossing the cap reverts the entire purchase with `DiscountCapExceeded`. Reverts roll both counters back. Updating the root, allowance, or prices never resets global usage, and transfers and unboxing never restore it. Discounted purchases share public crate inventory and emit the same `CratesPurchased` event with the actual payment. Warehouses and relics have no discounted mint entrypoint.

Every eligible wallet initially receives one discounted crate. The owner can call `setDiscountConfig(root, allowance)` with an allowance from 1 through 10. Usage remains cumulative across root replacements and allowance changes, including removing and re-adding an address. Increasing the allowance from 1 to 3 gives a wallet that already used one two more discounted crates. Setting the root to zero disables discounted minting. Public purchases, transfers, and unpacking do not consume or restore discount usage.

`setPrices(cratePrice, warehousePrice, discountCratePrice)` updates all three fixed prices atomically and rejects a discounted price above the public crate price. A public-price change does not automatically change the discounted price. Failed transactions revert payment, allocation, and discount usage.

`stats(address wallet)` preserves the first twelve fields: the existing six global statistics followed by the root, discounted crate price, allowance, queried wallet's used count, allocated relic supply, and lifetime claimed relic count. New deployments append `maxDiscountedMints` and `totalDiscountedMints` as fields 13 and 14; legacy deployments return only the first twelve fields and have no global discount cap. This gives the page one coherent contract read for price and remaining allowance. Passing the zero address returns zero wallet usage while still reporting global discounted usage. The draft holder snapshot and its generated proof fixture are checked independently of the live collection; no source-collection ownership query is required during minting.

The page uses the same discount button behavior as Solana: if the selected crate quantity exceeds the remaining allowance, the entire selection uses the public mint price. There is no partial discount within a transaction.

## Preorder relic allocation and claims

Relic supply starts at zero. Before the first `setSaleActive(true)`, the owner may call `allocateRelics(uint256 quantity)` once with a quantity from 1 through 18 and the preorder ETH attached as `msg.value`. A zero-value allocation is allowed. This reserves `quantity * 111` crate identities immediately, adds the payment to `totalMintReceived`, and emits `RelicsAllocated(quantity, paid)` without minting NFTs. Existing `releaseMint` and `releaseAllMint` distribute that payment using the fixed mint recipient shares. Direct ETH transfers remain rejected.

The allocation is permanent and cannot be increased, reduced, or repeated. Opening sales permanently closes allocation, even if no token has minted and sales are later paused. Configure the desired reservation before opening the sale. Per-wallet `relicLimit` values can be supplied at deployment or adjusted with `setFreeMintAllowances`; those limits do not reserve additional inventory.

While sales are active, an entitled wallet calls nonpayable `claimRelic(uint256 id)` for any still-unclaimed ID from 1 through 18. Allocating two relics permits any two distinct IDs, such as 18 and 4. Claims happen one at a time and consume one lifetime allowance each. Their 111-crate blocks are assigned in claim order, independently of the chosen ID. A claim does not change `allocatedCrates` or mint proceeds. The contract emits `RelicClaimed(wallet, relicId, tokenId)`. IDs cannot be reused after transfer, unpacking, or delivery. Failed receiver callbacks roll back the claim and allowance usage while retaining the original global reservation and deposit.

## Per-wallet free mints

Future deployments read [`config/free-mints.json`](config/free-mints.json). Its A/B/C templates start with zero limits and empty wallet lists. Group names organize configuration only; the constructor receives flattened per-wallet limits and initializes them atomically, including when the deployer and owner differ. The local deployment manifest records the resulting `freeMintAllocations`. Configuring allowances does not mint tokens or open sales.

For example, the following limits grant each wallet in A 100 crates and one warehouse, and each wallet in B five crates. Add the intended addresses to each `wallets` list:

```json
{
  "groups": [
    { "name": "A", "crates": 100, "warehouses": 1, "relics": 0, "wallets": [] },
    { "name": "B", "crates": 5, "warehouses": 0, "relics": 0, "wallets": [] },
    { "name": "C", "crates": 0, "warehouses": 0, "relics": 0, "wallets": [] }
  ]
}
```

Configuration preserves group and wallet order, rejects duplicate names or wallet membership, and allows at most 32 distinct wallets in total. Wallets must be nonzero Ethereum addresses other than the collection itself. Limits are nonnegative integers capped at 5,555 crates, 505 warehouses, and 18 relics per wallet. Write plain decimal integer literals such as `100`, not strings, `100.0`, or `1e2`, so both deployment parsers read the same values. The sum of all allowances may exceed inventory: **allowances do not reserve supply**. Free and paid crate/warehouse mints compete for the unreserved inventory. Relic claims use the separately reserved global relic allocation; per-wallet allowances do not increase that allocation.

Validate configuration or generate unsigned owner transactions from the repository root:

```sh
npm --prefix onchain/ethereum run free-mints:check
npm --prefix onchain/ethereum run free-mints:calldata -- COLLECTION_ADDRESS
```

Both commands accept an optional configuration path after their displayed arguments, resolved from `onchain/ethereum`. Calldata generation emits one `{group, to, data, value}` entry per nonempty group and never connects to an RPC or broadcasts. The owner executes these calls to `setFreeMintAllowances(address[] wallets, uint16 crates, uint16 warehouses, uint16 relics)`. Each call replaces total limits for its 1–32 listed wallets while preserving usage. It does not affect omitted wallets: explicit zero limits revoke remaining entitlement. Repeated batches can configure more than 32 wallets over the collection's lifetime.

`mintFree(uint8 kind, uint256 quantity)` accepts crate kind `2` or warehouse kind `3`, and mints 1–15 items to the caller. It requires `saleActive`, rejects ETH payments, and charges no mint price; the wallet still pays gas. A 100-crate allowance needs at least seven transactions. Claiming a warehouse consumes one warehouse allowance and 11 shared crate allocations, without consuming the wallet's free-crate allowance. Relics use `claimRelic(id)` instead, consuming one relic allowance from already reserved supply. Transfers, unpacking, and paid or discounted purchases do not change free usage.

`freeMintAllowances(wallet)` returns `crateLimit`, `warehouseLimit`, `relicLimit`, `cratesUsed`, `warehousesUsed`, and `relicsUsed`. All six counters fit in one storage slot. Remaining entitlement is `max(0, limit - used)` independently for each item. Increasing a limit from 100 to 120 grants 20 additional items; reducing a limit below usage leaves none available, and revocation/re-addition never restores used allowance. Discount accounting remains separate. `relicsAllocated` and `relicsMinted` remain fields 11 and 12 of `stats()` (zero-based indices 10 and 11) in both the legacy 12-field and new 14-field responses. `getRelicClaimedMask()` returns the permanent claimed-ID bitmap: bit `id - 1` is set for each claimed relic. Transfers, opening, and delivery do not clear it. The view derives all eighteen flags from existing reservations without additional claim storage writes.

Configuration emits `FreeMintAllowanceUpdated`; successful claims emit `FreeMintClaimed` and the existing purchase event with payment zero. Claims produce no mint proceeds. Usage and supply are updated before receiver callbacks, and a rejected callback reverts the whole mint. The shop does not expose generic free crate or warehouse mints; use the contract interface for those. The relic icon on `111k_devnet` exposes separate one-at-a-time relic claims.

## Supply and identities

| Kind | NFT token IDs | Display number |
| --- | --- | --- |
| Artwork | 1–111111, issued sequentially in unpacking order | Same as token ID |
| Crate | 111112–116666 | 1–5555 |
| Warehouse | 116667–117171 | 1–505 |
| Relic | 117172–117189 | 1–18 |
| Digital artwork receipt | 1000001–1111111 | Original digital token ID |
| Physical-only artwork receipt | 1111112–1222222 | 111112–222222 |
| Crate receipt | 2000000 + crate number | Original crate number |
| Relic receipt | 3000000 + relic number | Original relic number |

Digital unboxing assigns the next sequential artwork token IDs, and each artwork display number equals its token ID. A physical claim for crate `n` instead uses artwork display numbers `111111 + 20 × (n − 1) + 1` through `111111 + 20 × n`. Crate 5555 always contains 31 items and its physical range ends at 222222. These are placeholder identities; no randomness or reveal process is implemented.

Warehouse purchases reserve eleven crate identities immediately. Owner relic allocation reserves 111 crate identities per relic from the same 5,555-crate pool before the first sale activation. `relicsMinted` counts lifetime successful claims and cannot exceed `relicsAllocated`, including relics already unpacked or delivered. Claims use their reserved supply even after public inventory sells out. `unboxRelic(uint256)` burns the relic and mints its 111 reserved crates to the owner. Unpacking mints those reserved crates without consuming supply again. A crate can either be unpacked into artworks or redeemed into a crate receipt. Claiming a physical crate burns its receipt and creates its fixed physical-only artwork receipt numbers. Digital artwork `T` redeems into receipt `1000000 + T` with the same artwork number. Mutually exclusive crate paths cap actual artwork issuance at 111111. An unopened relic can instead be delivered, burning into terminal receipt `3000000 + relic number`. Its 111 crate allocations and lifetime relic slot remain consumed. Relic receipts cannot unpack or claim crate/artwork receipts. Warehouses and all receipts are ineligible for delivery. Receipts remain transferable.

The contract rejects reuse of every spot-minted ID, including IDs burned earlier. Product actions require the actual token owner, even if a caller is an approved operator. Public purchases accept 1–15 crates or warehouses; warehouse supply checks count eleven crate allocations per item. Each `claimRelic(id)` claims exactly one selected relic. `unboxCrate`, `unboxWarehouse`, and `unboxRelic` each open one container. `unboxCrates(uint256[])` opens 1–15 distinct owned crates in one transaction. Delivery accepts 1–50 artworks, crates and unopened relics in mixed orders.

`getTokenInfo` returns `(0, 0, address(0))` for nonexistent or burned tokens. The artwork count in `stats(address)` counts digital artwork NFTs ever minted, including those subsequently redeemed; physical artwork receipts are not part of that counter. Digital artwork display numbers equal token IDs and remain stable through ownership changes.

### Batch crate opening

`unboxCrates` validates and burns every input before any artwork receiver callback. A duplicate, invalid, or unowned input, or a rejected receiver callback, reverts the whole operation. Crates are opened in the caller's input order, using a separate sequential ERC721A artwork batch for each crate. A maximum batch containing crate #5555 creates 311 artworks; warehouses remain single-item openings.

Each crate emits its existing `CrateUnboxed` event. The final `CratesUnboxed(address indexed owner, bytes32 indexed tokenIdsHash, uint256 firstArtToken, uint256 artworkCount)` event commits to `keccak256(abi.encode(tokenIds))` in input order. Confirmation and recovery require exactly one matching aggregate event for a batch intent, including the owner, ordered ID commitment, output count and token range. Single-crate calls do not emit the aggregate event.

### Bounded reads

`getTokenInfos(uint256[])` accepts up to 150 IDs and returns `(uint8 kind, uint256 displayId, address holder)[]`. `previewTokenURIs(uint8[],uint256[])` accepts up to 30 corresponding kind/display-number pairs and returns `string[]`. Both preserve order and duplicates and return empty arrays for empty inputs. Token-info reads preserve zero tuples for absent or burned IDs. Oversized reads, mismatched metadata array lengths, or any invalid metadata pair revert the call.

The API chunks inventory and confirmation reads through these getters, with at most four contract calls per JSON-RPC envelope and two envelopes in flight. The existing 3 MiB response bound and request deadlines remain enforced. All chunks in an inventory or confirmation response use the same exact block hash; the API verifies that snapshot is still canonical before returning and also rechecks a confirmed transaction's inclusion block. Pinning the hash prevents RPC nodes on different forks from mixing state at the same height. Failed chunks never produce a partial success. A normal 30-item inventory requires one token-info call and one metadata call, excluding chain checks, snapshot verification and any larger local ownership scan.

## Authorization

The EIP-712 domain is `111K`, version `2`, with the current chain ID and collection address. The accepted types are:

```text
Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline,uint256 configId)
CrateClaim(address wallet,uint256 receiptId,bytes32 claimId,uint256 deadline)
```

`tokenIdsHash` is `keccak256(abi.encode(tokenIds))`, including the ABI array offset and length. `receiptIdsHash` is `keccak256(abi.encode(expectedReceiptIds))`, using the expected receipt for each token in the same order. Both hashes bind array order and length. The calldata quote tuple is `(orderId, wallet, fee, deadline, receiptIdsHash, configId)`. The Delivery typehash binds the immutable configuration ID while the domain stays version `2`; crate-claim signing is unchanged. Old delivery signatures do not authorize the new schema.

Before any burn or mint, delivery derives every receipt ID from the current token identity, validates ownership and item kind, and compares the receipt commitment. An incorrect receipt commitment reverts with `InvalidAuthorization`. Digital identity no longer changes when a reorg changes crate-opening order. All selected originals are then burned before any receipt is safely minted. Burn hooks make no external calls, so the upfront ownership checks remain valid throughout the burn phase.

Transfer logs contain all original burns followed by receipt mints; `DeliveryRedeemed` remains last and preserves the token/receipt pairing in the signed order. During a receipt callback, all selected originals are nonexistent, and balance/supply reflect all burns plus only receipts minted so far. A receiver may transfer a new receipt or an unrelated token. Rejecting any receipt still rolls back every burn, mint, payment and consumed authorization.

The frontend sorts a copy of each new delivery selection numerically by original token ID before requesting a quote. It uses the same order when checking calldata and receipt identities, without changing displayed inventory or selection order. Receipt IDs are never independently sorted because their ranges differ from the original token ranges. Backend signing, retries and confirmation preserve request order; arbitrary-order quotes and saved pending transactions remain supported.

Delivery order IDs and claim IDs must be nonzero and can be consumed only once. The deadline must be current and at most ten minutes ahead of the executing block timestamp. Failed actions revert completely, including authorization consumption and payment.

### Emergency redemption pause

The owner can call `setRedemptionsPaused(true)` to stop both `redeemForDelivery` and `claimCrateReceipt`, then `setRedemptionsPaused(false)` to resume them. `redemptionsPaused()` starts false, and each setter call emits `RedemptionsPauseUpdated(bool)`. Paused actions revert with `RedemptionsPaused()` before burning, minting, retaining payment, or consuming an authorization.

This onchain switch is independent of `saleActive`: purchases, unpacking, transfers, and withdrawals keep their existing behavior. The API and page do not read the switch, so they may still prepare an authorization while paused; the contract rejects execution. Confirmation and fulfillment of transactions already mined continue normally.

Pausing does not revoke signatures or extend their deadlines. An unused signature can execute after resumption if it is still valid. If the signing key was compromised, use the existing signer rotation before resuming. Authorization encoding remains EIP-712 version `2`.

Secret codes and shipping details remain offchain. The backend authorizes a specific wallet and crate receipt only after validating its code. The contract derives the 20/31 output count and receipt numbers itself. Events bind completed operations to their offchain order/claim records.

New nonlocal deployments through `script/Deploy111K.s.sol` require an explicit `ETHEREUM_111K_METADATA_BASE_URI`: `https://cdn.mons.shop/111k/<deploymentId>/` on mainnet or `https://cdn.mons.shop/111k-sepolia/<deploymentId>/` on Sepolia. The script rejects legacy bare prefixes and unsupported chains. Choose an unused lowercase deployment ID of 1–64 letters, digits, or hyphens, starting with a letter or digit; publish its placeholders before deployment. Follow the [reveal provisioning guide](../../scripts/docs/111k_reveal_ops.md#operator-setup) before activating reveals. Existing contracts retain their original onchain namespaces; superseded testnet metadata may be removed under the retirement policy. Both local deployment entrypoints default to the v16 namespace.

The owner can change the metadata prefix with `setBaseURI(string)`. The constructor and setter validate the same URL rules. Every successful setter call emits `BaseURIUpdated` and ERC-4906 `BatchMetadataUpdate`, including calls that keep the same URL to refresh updated CDN files. Ownership, supply rules, and redemption logic are unchanged. Coordinate base URL changes with the API metadata configuration and its allowed URL policy.

## Gas comparison

### Solidity 0.8.38 and 500-run build

The active build uses Solidity 0.8.38, 500 optimizer runs, the legacy pipeline (`via_ir = false`), Prague, and no bytecode metadata hash. The earlier compiler-focused source refactors skip zero-value mint revenue writes, calculate the physical claim's first receipt token before its loop, and cache mint payout accounting for explicit restoration after a failed receiver call. Those refactors preserved the public ABI, storage layout, authorization formats, events, and callback ordering. The current source also adds the lifetime discounted-mint cap, extending the constructor, public ABI, and storage accounting.

The [current compiler comparison](benchmarks/compiler-solc-0.8.38-legacy-500-comparison.json) compares the selected 500-run candidate with the same source compiled at 200 runs. Both use one fixed 200-run harness and receiver. All 139 measured writes must remain below a 1% increase; the 21 read-only cases are reported separately. Normal [gas snapshots](snapshots/NFT111KGasTest.json) instead compile the harness and receiver at the production 500-run setting. Run `npm --prefix onchain/ethereum run gas:compiler-gate -- --check` to reproduce the gate and verify the committed report's stable inputs and measurements without updating it.

The selected runtime is 24,555 bytes, leaving 21 bytes under EIP-170. Creation bytecode plus maximum constructor arguments is 35,373 bytes. The contract's size tests enforce both runtime and initcode limits. Compiler settings affect new builds and deployments; historical deployed collections retain their original bytecode.

The following production snapshots compare the preceding build at commit `4514b4f34af39f18fd465171c9d03b3ff3590450` with the current build. These differences include the refactors, compiler settings, and discounted-mint cap; the compiler comparison above isolates optimizer settings on identical source.

| Operation | Previous 0.8.30 / 200 runs | Current 0.8.38 / 500 runs | Change |
| --- | ---: | ---: | ---: |
| Mint one crate | 143,063 | 143,087 | +24 |
| Mint 15 crates | 499,993 | 499,149 | -844 |
| Mint one free crate | 128,756 | 126,492 | -2,264 |
| Mint one free warehouse | 173,207 | 170,943 | -2,264 |
| Unbox one ordinary crate | 129,504 | 128,970 | -534 |
| Unbox 15 ordinary crates | 1,204,565 | 1,194,738 | -9,827 |
| Unbox one warehouse | 350,312 | 349,631 | -681 |
| Unbox one relic | 2,903,129 | 2,896,204 | -6,925 |
| Redeem one crate | 153,627 | 153,505 | -122 |
| Redeem one artwork | 161,014 | 160,925 | -89 |
| Redeem 50 mixed items | 2,475,497 | 2,469,536 | -5,961 |
| Claim 20 artwork receipts | 604,422 | 601,662 | -2,760 |
| Claim 31 artwork receipts | 891,151 | 886,851 | -4,300 |
| Release mint proceeds to 32 recipients, first payout | 2,098,520 | 2,089,655 | -8,865 |
| Release mint proceeds to 32 recipients, repeat payout | 734,220 | 725,355 | -8,865 |

### Historical relic claim availability and 200-run build (2026-11-01)

The preserved [relic claim compiler comparison](benchmarks/relic-claims-compiler-200-comparison.json) measures the preceding source using Solidity 0.8.30 at 200 and 500 runs, including owner allocation, individual claims, registered delivery configurations and payouts. All 139 measured writes passed its less-than-1% gate; the 21 read-only cases were reported separately.

The 200-run runtime is 23,922 bytes, leaving 654 bytes under EIP-170. Creation bytecode plus maximum constructor arguments is 34,639 bytes. The 500-run reference runtime is 24,394 bytes. All writes pass the compiler gate, with a maximum increase of about 0.835%; read-only increases reach about 1.99%. Exact fixed-width URI scheme comparisons preserve validation while avoiding repeated byte-index checks.

The [preorder-only compiler report](benchmarks/relic-preorders-compiler-200-comparison.json), [v10 registered delivery report](benchmarks/v10-registered-delivery.json), [v10 compiler comparison](benchmarks/v10-compiler-200-comparison.json), [original three-way experiment](benchmarks/registered-delivery.json), and [frozen references](benchmarks/reference/README.md) remain historical evidence. `npm --prefix onchain/ethereum run gas:delivery` reproduces the v10 study from pinned commit `b184cb4cbed24e0f306ee27d18c06d84debe3018`, writing `benchmarks/v10-registered-delivery-reproduction.json` and protecting the original report from overwrite. `npm --prefix onchain/ethereum run gas:delivery:history` reproduces the original three-way study independently of the canonical ABI. Its first configuration required a separate registration; the current constructor initializes it atomically.

### Historical signed-address experiment (2026-11-01)

The [delivery routing report](benchmarks/delivery-routing.json) compares the new single/split interface with the previous global receiver at commit `d37e03bc17db5fb6b08463f6a61c84c6a7335c2c`, using Solidity 0.8.30, 500 optimizer runs, and Prague. This preserves the signed-address study before registered configurations were adopted; it is not the active production ABI. The report contains 14 isolated Forge cases measured twice and 48 actual local Anvil receipts: two runs each of nine baseline and fifteen new scenarios.

| Redemption | Previous receiver | Signed single | Signed split |
| --- | ---: | ---: | ---: |
| One crate, fresh balances | 151,040 | 178,458 | 203,970 |
| One crate, pending credits | 116,840 | 127,158 | 135,558 |
| 50 mixed items, fresh balances | 2,467,066 | 2,494,502 | 2,520,014 |
| 50 mixed items, pending credits | 2,449,966 | 2,460,302 | 2,468,714 |
| One crate after withdrawal | 116,840 | 144,258 | 169,770 |

Values include transaction and calldata costs and refunds; setup/signing are excluded. The split assigns 25% to the secondary receiver. Compared with signed single mode, split mode adds 25,512 gas for fresh balances and about 8,400 gas when both receivers retain credits. A withdrawal clears its balance, so subsequent crediting pays the zero-to-nonzero storage cost again. Accumulating credits amortizes withdrawal transactions. The first and repeat withdrawals use 80,754 and 38,654 gas per receiver in the measured empty-account/previously-funded scenarios. Gas varies with calldata, receiver code and chain rules; these are measurements, not transaction limits.

That signed-address revision had a 23,832-byte runtime and used 500 optimizer runs. The new feature intentionally changes the ABI and storage layout, so it has its own comparison rather than the optimizer-only 1% gate below.

### Historical 500-run build (2026-11-01)

The [fixed-reference report](benchmarks/optimizer-500-comparison.json) compares the original source at commit `32841d396ca81eb25c77ccd30e3a5546d0bc91fd`, compiled at 1,000 runs, against the historical 500-run build with URI character caching. The ABI and storage layout must remain identical. This applies to future deployments; existing collections retain their bytecode.

Run the comparison from the repository root:

```sh
npm --prefix onchain/ethereum run gas:regression
```

Both historical commits must be available in local Git history; the command does not fetch them. The command reproduces the original comparison from pinned commit `d37e03bc17db5fb6b08463f6a61c84c6a7335c2c` in an isolated local checkout, including its original source, harness and signing helpers. Its default output is `benchmarks/optimizer-500-reproduction.json`; the original report is protected from overwrite. Remove `FOUNDRY_` and `DAPP_` environment overrides before running. The command builds both contracts in temporary directories with the same pinned dependencies. It repeats 141 isolated gas benchmarks using one fixed harness and receiver, then repeats 106 actual-receipt operations on a local Prague Anvil chain. The receipt cases include owner updates, approvals, transfers, warm contract-wallet calls, and malformed URI reverts. Addresses, calldata, timestamps, outcomes, and application state must match. Every measured operation must satisfy `candidateGas * 100 < referenceGas * 101`; exactly 1% fails. The report records per-operation gas and source, harness, dependency, compiler, and bytecode hashes. An optional output path selects another report destination.

The recorded comparison passed all cases. Maximum increases were **0.0153% / 306 gas** for successful transaction receipts, **0.0228% / 6 gas** for failed URI-update receipts, and **0.214% / 180 gas** for read-call execution. Each build runs the 106 receipt operations twice, producing 424 measured receipts in total. These are measured gas units, independent of the ETH gas price.

Normal gas snapshots compile the harness at the configured 500 runs; the fixed-reference comparison keeps its historical harness unchanged to isolate contract costs. After intentionally updating snapshots with `npm --prefix onchain/ethereum run gas:update`, verify them with `gas:check`. Historical compiler reports remain unchanged. The percentage gate covers measured scenarios under Prague rules, not every possible future input, receiver, or fork.

### Mint payout batches (2026-10-31)

The recorded collection runtime was 23,438 bytes, leaving 1,138 bytes below the EIP-170 limit. Runtime and maximum constructor payload sizes are enforced by tests. The isolated Prague benchmarks use 32 fixed recipients with positive basis points totaling 10,000. First payouts to ordinary wallets include creation of previously empty accounts; repeat payouts follow another purchase. Failure benchmarks exhaust the callback gas allowance for every receiver and verify all entitlements remain unpaid.

| Operation | Gas used |
| --- | ---: |
| Mint one crate, 8 or 32 recipients | 143,078 |
| Mint one free crate, first claim | 128,758 |
| Mint one free warehouse, first claim | 173,269 |
| Mint one free relic, first claim | 173,520 |
| Update base URI, 40 bytes | 59,787 |
| Update base URI, 100 bytes | 130,749 |
| Update base URI, 256 bytes | 288,195 |
| Update base URI, 1,024 bytes | 1,160,388 |
| Configure 32 free mint wallets, first assignment | 1,081,475 |
| Configure 32 free mint wallets after usage | 534,287 |
| Release all, 4 recipients, first payout | 304,385 |
| Release all, 4 recipients, repeat payout | 118,885 |
| Release all, 32 recipients, first payout | 2,099,437 |
| Release all, 32 recipients, repeat payout | 735,137 |
| Release all, 32 recipients, nothing pending | 268,571 |
| Release all, 32 receivers exhausting callback gas | 4,169,819 |

These are measured gas usage, including transaction overhead and refunds, not transaction gas limits. Estimate gas against the target chain before submitting; the batch also needs enough remaining gas to supply each full callback budget. Tests bound first and repeat 32-recipient payouts below 3 million and 1 million gas respectively, and the all-failing case below 5 million gas. The individual payout fallback retains normal gas forwarding for receivers that need more than the batch allowance.

### Batch operations (2026-10-27)

The [batch report](benchmarks/batch-operations.json) records the source/toolchain hashes, deployed code size and bounded-read response sizes for the collection before relic support. That revision had 113 gas measurements and a 21,780-byte runtime, leaving 2,796 bytes below the EIP-170 limit. The following table preserves that historical revision. Current measurements are checked in `snapshots/NFT111KGasTest.json`.

| Opening | One batch | Fifteen separate transactions | Gas saved |
| --- | ---: | ---: | ---: |
| 15 ordinary crates, EOA | 1,194,760 | 1,694,805 | 500,045 (29.50%) |
| 15 crates including #5555, EOA | 1,215,947 | 1,715,992 | 500,045 (29.14%) |
| 15 ordinary crates, minimal receiver | 1,653,481 | 2,153,355 | 499,874 (23.21%) |
| 15 crates including #5555, minimal receiver | 1,691,365 | 2,191,220 | 499,855 (22.81%) |

These isolated write measurements include intrinsic/calldata gas and refunds, with identical initial state and input order for each comparison. Setup and arbitrary contract-wallet callback work are excluded. The Anvil API lifecycle separately checks that batch opening saves gas using real transaction receipts.

The 150-entry sparse artwork-info benchmark costs 6,916,021 gas. A 30-entry artwork-receipt metadata URL read costs 95,310 gas and returns 3,904 ABI bytes (7,810 bytes of hex, excluding the RPC envelope). Tests enforce a 25-million-gas call budget and 512 KiB hex-response budget for that metadata scenario. These are read simulations; inventory users do not submit a paid transaction for them.

Regenerate the report after reviewing updated gas snapshots:

```sh
node scripts/benchmark-batch.mjs
```

### Historical compiler settings (2026-10-18)

The preserved [compiler comparison](benchmarks/compiler-settings.json) uses Solidity 0.8.30, Prague and the legacy pipeline (`via_ir = false`) to measure the renamed sources before batch operations were added, at legacy/200 and legacy/1000. Its 89 benchmarks, source/toolchain hashes, ABI comparisons, code sizes and deployment receipts describe that earlier revision, not the current batch implementation.

In that recorded comparison, all 77 write measurements and eight reads improve at 1000 runs; four reads are unchanged and none regress.

| Pipeline | Optimizer runs | Writes improved / regressed | Collection bytes | Renderer bytes | Combined deployment gas change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legacy | 200 (baseline) | 0 / 0 | 14,358 | 10,333 | 0 |
| **Legacy** | **1000 (selected in that revision)** | **77 / 0** | **15,476** | **11,775** | **+522,777** |

| Operation | Legacy/200 gas | Legacy/1000 gas | Saved |
| --- | ---: | ---: | ---: |
| Mint 15 crates | 484,246 | 483,304 | 942 |
| Mint 15 warehouses | 843,203 | 842,261 | 942 |
| Unpack warehouse | 353,461 | 352,687 | 774 |
| Unpack 20-artwork crate | 130,828 | 130,156 | 672 |
| Unpack 31-artwork crate | 135,234 | 134,243 | 991 |
| Deliver 50 artworks | 2,957,296 | 2,951,744 | 5,552 |
| Deliver 50 crates | 2,019,153 | 2,011,951 | 7,202 |
| Deliver 25 artworks + 25 crates | 2,480,424 | 2,474,047 | 6,377 |
| Claim 31 artwork receipts | 899,483 | 897,427 | 2,056 |

At that revision, collection deployment costs 3,619,228 gas (+230,924); renderer deployment costs 2,579,059 (+291,853). Those one-time costs are separate from user-call savings. Normal gas snapshots also compile the test receiver at the selected settings; the compiler comparison keeps its bytecode fixed to isolate the collection's improvements.

Every configuration uses the same legacy/200 test harness and receiver bytecode. Candidate contracts are deployed from their compiled artifacts at identical addresses, keeping signed calldata and callback costs constant. The [historical legacy/200 baseline](benchmarks/compiler-legacy-200.json) records the source, harness, dependency and compiler provenance for those 89 measurements. The [CDN legacy/200 baseline](benchmarks/compiler-legacy-200-cdn.json) preserves the former two-contract implementation. The [single-contract legacy/200 baseline](benchmarks/compiler-legacy-200-single-contract.json) and [single-contract comparison](benchmarks/compiler-single-contract.json) also remain historical. In these records, `sourceCommit` identifies the checkout’s base revision; SHA-256 hashes identify the exact measured working-tree inputs.

The source before relic support had 113 benchmarks and used the single-contract baseline. That revision’s selected legacy/1000 collection deploys in 5,338,642 gas on Prague Anvil; its creation bytecode is 25,616 bytes plus 640 constructor bytes for four recipients (896 for eight). Sepolia deployment gas must be estimated against the live chain. Reproduce the earlier comparison from its recorded source revision.

### Compiler benchmark tooling

Current tooling uses the [Solidity 0.8.38 legacy/200 baseline](benchmarks/compiler-solc-0.8.38-legacy-200-baseline.json). Normal runs reject changed provenance or measurements; they never silently replace this baseline. To compare the current 200- and 500-run builds against it, run:

```sh
node scripts/benchmark-compiler.mjs /tmp/111k-compiler-settings.json legacy 200 500
```

The full 14-configuration matrix remains available. Omitting pipeline and run arguments tests legacy runs 1, 50, 200, 500, 1000, 1500, 2000, 5000 and 10000, plus IR runs 1, 50, 200, 1000 and 10000:

```sh
node scripts/benchmark-compiler.mjs /tmp/111k-compiler-matrix.json
node scripts/benchmark-compiler.mjs /tmp/111k-ir-settings.json ir 1 50 200 1000 10000
```

After reviewing an intentional source, harness or toolchain change, explicitly regenerate the compiler baseline, then rerun the comparison without the update flag to verify it:

```sh
npm run gas:update
node scripts/benchmark-compiler.mjs /tmp/111k-compiler-baseline-update.json legacy 200 500 --update-baseline
node scripts/benchmark-compiler.mjs /tmp/111k-compiler-settings.json legacy 200 500
npm run gas:compiler-gate
npm run gas:compiler-gate -- --check
```

Compiler comparisons leave normal gas snapshots unchanged. Regenerate those separately with `npm run gas:update` when intended. The compiler settings affect future builds and deployments; existing deployed contracts retain their original bytecode.

### Historical comparisons

Superseded compiler, delivery and ownership comparisons, the rejected counter-packing candidate and the historical delivery runner are preserved in Git. The [history index](benchmarks/HISTORY.md) identifies their original immutable blobs and reproduction context. Those historical measurements describe their original sources and are not relabeled as current results.

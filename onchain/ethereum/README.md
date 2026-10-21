# 111K contracts

An ERC721A collection with public crate and warehouse sales, allowlist crate discounts, atomic unpacking, signed delivery quotes, physical crate claims, and onchain SVG placeholders. Contract logic is non-upgradeable. The owner can change prices, discount eligibility and allowance, sale status, the emergency redemption pause, the authorization signer, delivery-payment receiver, and metadata renderer. Mint recipients and their shares are fixed at deployment.

The [proceeds release](../../releases/111k-sepolia-proceeds/README.md) records the new collection and its verification. The [first Sepolia deployment](../../releases/111k-sepolia/README.md) remains the renderer's deployment record. Sepolia's Glamsterdam state-creation pricing requires live RPC gas estimates; the local Prague benchmarks and Forge simulation estimates must not be used as Sepolia deployment limits.

Ownership transfers require the new owner to accept. `renounceOwnership()` is disabled and reverts with `OwnershipRenunciationDisabled()` for the owner, preserving shipping-wallet rotation and emergency controls. Proceeds releases are permissionless. Existing deployments need a fresh deployment to gain this protection; the authorization protocol remains version 2.

The contract dependencies are `erc721a@4.3.0` and `@openzeppelin/contracts@5.6.1`; allowlist tooling uses OpenZeppelin's standard Merkle-tree generator. Foundry and Solidity 0.8.30 must already be installed. Builds and tests use `--offline` and do not download compilers. No Hardhat or forge-std dependency is needed.

## Check

Run from `onchain/ethereum`:

```sh
npm ci --ignore-scripts
npm run check
```

`npm test` regenerates deterministic authorization/calldata vectors in `fixtures/eip712.json` and metadata fixtures in `fixtures/metadata.json`. `scripts/check-fixtures.mjs` validates metadata and decodes SVG previews under `out/media-previews`. Regenerate `shared/ethereum/abi.generated.ts` after changing the contract interface:

```sh
npm run build
npm run abi
```

The tests cover every allocation in a 5,555-crate mixed warehouse/direct sale, all 111,111 resulting artwork identities, the 31-item bonus on both routes, arbitrary unpacking order, transfers and burns, replay protection, receiver callbacks, rollback, independent payout failures, and metadata. Delivery tests also revert a chain snapshot and change the artwork mapping to verify that an old quote cannot redeem a different physical identity.

Stateful invariant tests mix public and discounted purchases, transfers, unpacking, delivery, claims, and pause changes across multiple owners. An independent model checks token identities, ownership, balances, allocations, discount usage, and consumed authorizations. Normal checks use 128 sequences of 64 calls and fail on unexpected handler reverts. Run the longer campaign with:

```sh
npm run test:invariants:extended
```

That campaign uses 512 sequences of 128 calls. Receiver regressions also exercise reentrancy, rejected callbacks, transfers during callbacks, and multiple operations within a single transaction. Reentrancy locks and the temporary artwork offset use transient storage, which requires EIP-1153; the configured Prague EVM supports it. Both are cleared before a successful call returns so subsequent calls in the same transaction remain safe.

Gas snapshots exclude scenario setup and signature preparation. With `--isolate`, write-call measurements include transaction intrinsic gas and any applicable calldata floor; view calls remain ordinary call-gas measurements. `npm run check` requires every benchmark to succeed and produce its expected runtime measurement, then compares those measurements with the committed snapshots without updating them. Filtered tests and missing or renamed measurements fail the check. Use these commands for a separate check or an intentional baseline update:

```sh
npm run gas:check
npm run gas:update
```

Compare snapshots using the same Foundry, Solidity, optimizer, and EVM settings. Snapshot values are gas units, not ETH fees, and omit any outer contract-wallet transaction overhead. Differently ordered authorizations can also differ slightly in signature-byte calldata cost. Gas isolation applies only to the benchmark suite; security tests retain same-transaction execution.

## Onchain SVG artwork

Artworks show four simple flower families: narrow daisies, notched blossoms, broad poppies, and layered dahlias. They have curved stems and two leaves on full 720×720 backgrounds, with six palettes pairing soft backgrounds and colorful petals. An artwork receipt embeds the same composition. The filled flower center's position and radius encode a permutation of all 111,111 display IDs, so uniqueness does not depend on chance or hidden metadata. `test/Renderer.t.sol` checks the complete center mapping, deterministic SVG output, matching receipt artwork, and size budgets of 4 KiB per SVG and 12 KiB for the renderer runtime.

Standalone crates and warehouses are vertically centered on transparent canvases. Crates use warm wood colors, including within crate receipts; warehouses use muted sage green. Receipt canvases retain their paper and red redeemed sticker.

## Local chain

Start Anvil in one terminal:

```sh
npm run chain:local
```

In another terminal:

```sh
npm run deploy:local
```

The deployment helper accepts only a loopback Anvil RPC with chain ID 31337. It deploys the renderer and collection using Anvil's first unlocked account. It writes addresses, the deployment block, the discount root, the proceeds configuration, and `protocolVersion: 6` to `.local/deployment.json`. The default discount root comes from `src/ethereum/discounts/111k.json`. Optional overrides are `ETHEREUM_111K_LOCAL_RPC_URL`, `ETHEREUM_111K_LOCAL_OWNER`, `ETHEREUM_111K_LOCAL_QUOTE_SIGNER`, and `ETHEREUM_111K_LOCAL_DISCOUNT_ROOT`.

Local deployment manifest version 6 identifies built-in mint splits and separate delivery proceeds, alongside crate discounts, wallet-aware `stats(address)`, batch unpacking, and reads. Restart Anvil, rerun `deploy:local`, and restart the local API with its fresh database when upgrading any older local deployment. The API rejects older manifests, probes the payout getters, and verifies immutable mint recipients and shares before starting. It accepts a valid owner-rotated delivery receiver without requiring a new manifest. Existing contracts require a fresh deployment because they are not upgradeable. Both delivery and crate-claim authorizations retain EIP-712 domain name `111K`, version `2`, and their existing signed fields. Authorizations remain bound to their original chain and contract address.

Start the isolated API from the repository root:

```sh
npm run dev:ethereum:api
```

The helper reads `.local/deployment.json`, injects the public local test signer, and creates temporary databases. Follow the [local API and frontend setup](../../scripts/docs/111k_testnet.md#run-locally). Public networks require a separately provisioned signer.

Anvil's exposed accounts and keys are for local development only. The collection starts with sales active, crate price `0.0001 ETH`, warehouse price `0.0011 ETH`, and discounted crate price `0.00005 ETH`. Delivery fees are supplied by a signed quote; the local test flow uses `0.0001 ETH`. Mint and delivery payments accumulate in separate accounting pools in the collection. Anyone can trigger `releaseMint(recipient)` or `releaseDelivery()`; payment always goes to the configured receiver.

`script/Deploy111K.s.sol` prepares an explicitly configured deployment using `ETHEREUM_111K_DEPLOYER_KEY`, `ETHEREUM_111K_OWNER`, `ETHEREUM_111K_QUOTE_SIGNER`, and `ETHEREUM_111K_DISCOUNT_ROOT`. It is not invoked by the local helper or any check. Public testnet deployment and funding are separate operator actions.

## Mint splits and delivery proceeds

Both deployment scripts read [`config/proceeds.json`](config/proceeds.json). It starts with four valid placeholder mint addresses and shares of `5000 / 2500 / 1500 / 1000` basis points (50% / 25% / 15% / 10%), plus a different placeholder delivery receiver. Replace these placeholders before deploying for real proceeds. There are no treasury environment overrides. Configuration is validated before broadcasting, including duplicate receivers, shipping overlap, and the predicted collection address.

A deployment accepts 2–8 distinct, nonzero mint recipients with positive integer basis points totaling 10,000. Their addresses and shares cannot change. Public crates, discounted crates, and warehouses credit their actual ETH payment to `totalMintReceived`; unboxing and receipt claims do not earn additional proceeds. Delivery fees only credit `totalDeliveryReceived`.

`mintRecipientCount()`, `mintRecipients(index)`, and `mintSharesBps(recipient)` expose the fixed split. `mintReleased(recipient)`, `totalMintReleased`, `totalDeliveryReleased`, `releasableMint(recipient)`, and `releasableDelivery()` expose payouts and pending amounts. Each mint recipient is entitled to `floor(totalMintReceived * shareBps / 10000) - mintReleased(recipient)`. Entitlements use cumulative receipts, so small payments do not repeatedly lose rounding fractions; after everyone claims, at most seven wei remain reserved for later accrual and can remain permanently after the final sale.

Anyone may call `releaseMint(address)` for a known recipient or `releaseDelivery()`. Zero pending amounts are a no-op. Callers cannot redirect or choose an amount. A failed ETH transfer reverts only that payout, and cannot block minting, delivery, or independent releases to other recipients. Sale and redemption pauses do not block releases. The old `withdraw()`, `treasury()`, and `setTreasury(address)` interfaces are removed; there is no unrestricted balance sweep. Approvals and transfers reject nonzero ETH payments. Forced ETH is not counted as either kind of revenue and cannot be recovered through these functions.

The owner may call `setDeliveryPaymentReceiver(address)` to rotate the shipping wallet. The new receiver must be nonzero, different from the collection, and different from every mint recipient. It receives all unwithdrawn and future delivery fees. `DeliveryPaymentReceiverUpdated`, `MintProceedsReleased`, and `DeliveryProceedsReleased` record receiver changes and successful payments. The manifest records the initial delivery receiver; use `deliveryPaymentReceiver()` for its current value. Payouts need no new API route or customer UI and introduce no additional dependencies.

## Allowlist crate discounts

`mintCratesDiscounted(uint256 quantity, bytes32[] proof)` proves the caller's address against `discountMerkleRoot` using OpenZeppelin's standard double-hashed address leaf. It accepts only the exact `quantity * discountCratePrice` payment and increments `discountUsed[msg.sender]` before receiver callbacks. Discounted purchases share public crate inventory and emit the same `CratesPurchased` event with the actual payment. Warehouses have no discounted mint entrypoint.

Every eligible wallet initially receives one discounted crate. The owner can call `setDiscountConfig(root, allowance)` with an allowance from 1 through 10. Usage remains cumulative across root replacements and allowance changes, including removing and re-adding an address. Increasing the allowance from 1 to 3 gives a wallet that already used one two more discounted crates. Setting the root to zero disables discounted minting. Public purchases, transfers, and unpacking do not consume or restore discount usage.

`setPrices(cratePrice, warehousePrice, discountCratePrice)` updates all three fixed prices atomically and rejects a discounted price above the public crate price. A public-price change does not automatically change the discounted price. Failed transactions revert payment, allocation, and discount usage.

`stats(address wallet)` returns the existing six global statistics followed by the root, discounted crate price, allowance, and queried wallet's used count. This gives the page one coherent contract read for price and remaining allowance. Passing the zero address returns zero usage. The draft holder snapshot and its generated proof fixture are checked independently of the live collection; no source-collection ownership query is required during minting.

The page uses the same discount button behavior as Solana: if the selected crate quantity exceeds the remaining allowance, the entire selection uses the public mint price. There is no partial discount within a transaction.

## Supply and identities

| Kind | NFT token IDs | Display number |
| --- | --- | --- |
| Artwork | 1–111111, issued sequentially in unpacking order | Fixed by its source crate |
| Crate | 111112–116666 | 1–5555 |
| Warehouse | 116667–117171 | 1–505 |
| Artwork receipt | 1000000 + artwork display number | Original artwork number |
| Crate receipt | 2000000 + crate number | Original crate number |

Crate `n` corresponds to artwork display numbers `20 × (n − 1) + 1` through `20 × n`. Crate 5555 instead ends at 111111 and always contains 31 items, regardless of opening order. These are placeholder identities, not randomly allocated future artwork identities.

Warehouse purchases reserve eleven crate identities immediately. Unpacking mints those reserved crates without consuming supply again. A crate can either be unpacked into artworks or redeemed into a crate receipt. Claiming a physical crate burns its receipt and creates the same fixed artwork receipt numbers. Warehouses cannot be delivered, and artwork receipts cannot be redeemed again. Receipts remain transferable.

The contract rejects reuse of every spot-minted ID, including IDs burned earlier. Product actions require the actual token owner, even if a caller is an approved operator. Purchases accept 1–15 crates or warehouses; warehouse supply checks count eleven crate allocations per warehouse. `unboxCrate` and `unboxWarehouse` retain their single-container behavior. `unboxCrates(uint256[])` opens 1–15 distinct owned crates in one transaction. Delivery accepts 1–50 items.

`getTokenInfo` returns `(0, 0, address(0))` for nonexistent or burned tokens. The artwork count in `stats(address)` counts digital artwork NFTs ever minted, including those subsequently redeemed; physical artwork receipts are not part of that counter. Artwork display offsets are stored per ERC721A mint batch and preserved through ownership changes.

### Batch crate opening

`unboxCrates` validates and burns every input before any artwork receiver callback. A duplicate, invalid, or unowned input, or a rejected receiver callback, reverts the whole operation. Crates are opened in the caller's input order, using a separate ERC721A artwork batch and identity offset for each crate. The transient offset is cleared after each mint. A maximum batch containing crate #5555 creates 311 artworks; warehouses remain single-item openings.

Each crate emits its existing `CrateUnboxed` event. The final `CratesUnboxed(address indexed owner, bytes32 indexed tokenIdsHash, uint256 firstArtToken, uint256 artworkCount)` event commits to `keccak256(abi.encode(tokenIds))` in input order. Confirmation and recovery require exactly one matching aggregate event for a batch intent, including the owner, ordered ID commitment, output count and token range. Single-crate calls do not emit the aggregate event.

### Bounded reads

`getTokenInfos(uint256[])` accepts up to 150 IDs and returns `(uint8 kind, uint256 displayId, address holder)[]`. `previewTokenURIs(uint8[],uint256[])` accepts up to 30 corresponding kind/display-number pairs and returns `string[]`. Both preserve order and duplicates and return empty arrays for empty inputs. Token-info reads preserve zero tuples for absent or burned IDs. Oversized reads, mismatched metadata array lengths, or any invalid metadata pair revert the call.

The API chunks inventory and confirmation reads through these getters, with at most four contract calls per JSON-RPC envelope and two envelopes in flight. The existing 3 MiB response bound and request deadlines remain enforced. All chunks in an inventory or confirmation response use the same exact block hash; the API verifies that snapshot is still canonical before returning and also rechecks a confirmed transaction's inclusion block. Pinning the hash prevents RPC nodes on different forks from mixing state at the same height. Failed chunks never produce a partial success. A normal 30-item inventory requires one token-info call and one metadata call, excluding chain checks, snapshot verification and any larger local ownership scan.

## Authorization

The EIP-712 domain is `111K`, version `2`, with the current chain ID and collection address. The accepted types are:

```text
Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline)
CrateClaim(address wallet,uint256 receiptId,bytes32 claimId,uint256 deadline)
```

`tokenIdsHash` is `keccak256(abi.encode(tokenIds))`, including the ABI array offset and length. `receiptIdsHash` is `keccak256(abi.encode(expectedReceiptIds))`, using the expected receipt for each token in the same order. Both hashes bind array order and length. The calldata quote tuple appends `bytes32 receiptIdsHash` after its existing `orderId`, `wallet`, `fee`, and `deadline` fields.

Before any burn or mint, delivery derives every receipt ID from the current token identity, validates ownership and item kind, and compares the receipt commitment. A changed mapping, such as an artwork token ID allocated to a different crate after a reorg, reverts with `InvalidAuthorization`. The caller must prepare a fresh quote. All selected originals are then burned before any receipt is safely minted. Burn hooks make no external calls, so the upfront ownership checks remain valid throughout the burn phase.

Transfer logs contain all original burns followed by receipt mints; `DeliveryRedeemed` remains last and preserves the token/receipt pairing in the signed order. During a receipt callback, all selected originals are nonexistent, and balance/supply reflect all burns plus only receipts minted so far. A receiver may transfer a new receipt or an unrelated token. Rejecting any receipt still rolls back every burn, mint, payment and consumed authorization.

The frontend sorts a copy of each new delivery selection numerically by original token ID before requesting a quote. It uses the same order when checking calldata and receipt identities, without changing displayed inventory or selection order. Receipt IDs are never independently sorted because artwork token IDs and displayed artwork numbers can differ. Backend signing, retries and confirmation preserve request order; arbitrary-order quotes and saved pending transactions remain supported.

Delivery order IDs and claim IDs must be nonzero and can be consumed only once. The deadline must be current and at most ten minutes ahead of the executing block timestamp. Failed actions revert completely, including authorization consumption and payment.

### Emergency redemption pause

The owner can call `setRedemptionsPaused(true)` to stop both `redeemForDelivery` and `claimCrateReceipt`, then `setRedemptionsPaused(false)` to resume them. `redemptionsPaused()` starts false, and each setter call emits `RedemptionsPauseUpdated(bool)`. Paused actions revert with `RedemptionsPaused()` before burning, minting, retaining payment, or consuming an authorization.

This onchain switch is independent of `saleActive`: purchases, unpacking, transfers, and withdrawals keep their existing behavior. The API and page do not read the switch, so they may still prepare an authorization while paused; the contract rejects execution. Confirmation and fulfillment of transactions already mined continue normally.

Pausing does not revoke signatures or extend their deadlines. An unused signature can execute after resumption if it is still valid. If the signing key was compromised, use the existing signer rotation before resuming. Authorization encoding remains EIP-712 version `2`.

Secret codes and shipping details remain offchain. The backend authorizes a specific wallet and crate receipt only after validating its code. The contract derives the 20/31 output count and receipt numbers itself. Events bind completed operations to their offchain order/claim records.

The owner can replace the renderer for a later metadata implementation. This changes metadata authority without allowing changes to ownership, supply rules, or redemption logic. Renderer changes emit ERC-4906 metadata refresh events.

## Gas comparison

### Batch operations (2026-10-18)

The [batch report](benchmarks/batch-operations.json) records the source/toolchain hashes, 105 verified gas snapshots, deployed code size and bounded-read response sizes at that revision, before crate discounts were added. The collection runtime at that revision was 17,206 bytes, leaving 7,370 bytes below the EIP-170 limit. The renderer was 11,775 bytes. Current measurements are checked in `snapshots/NFT111KGasTest.json`.

| Opening | One batch | Fifteen separate transactions | Gas saved |
| --- | ---: | ---: | ---: |
| 15 ordinary crates, EOA | 1,215,149 | 1,714,920 | 499,771 (29.14%) |
| 15 crates including #5555, EOA | 1,236,336 | 1,736,107 | 499,771 (28.79%) |
| 15 ordinary crates, minimal receiver | 1,668,470 | 2,168,070 | 499,600 (23.04%) |
| 15 crates including #5555, minimal receiver | 1,706,156 | 2,205,737 | 499,581 (22.65%) |

These isolated write measurements include intrinsic/calldata gas and refunds, with identical initial state and input order for each comparison. Setup and arbitrary contract-wallet callback work are excluded. The Anvil API lifecycle also compares real transaction receipts after 40 artworks already exist: opening 15 crates including #5555 costs 1,219,236 gas versus 1,719,007 separately, saving 499,771 gas (29.07%).

The 150-entry sparse artwork-info benchmark costs 6,942,976 gas. A 30-entry large artwork-receipt metadata read costs 18,989,148 gas and returns 190,144 ABI bytes (380,290 bytes of hex, excluding the RPC envelope). Tests enforce a 25-million-gas call budget and 512 KiB hex-response budget for that metadata scenario. These are read simulations; inventory users do not submit a paid transaction for them.

Regenerate the report after reviewing updated gas snapshots:

```sh
node scripts/benchmark-batch.mjs
```

### Compiler settings (2026-10-18)

The build uses Solidity 0.8.30, Prague and the legacy pipeline (`via_ir = false`), with `optimizer_runs = 1000`. The preserved [compiler comparison](benchmarks/compiler-settings.json) measures the renamed sources before batch operations were added, at legacy/200 and legacy/1000. Its 89 benchmarks, source/toolchain hashes, ABI comparisons, code sizes and deployment receipts describe that earlier revision, not the current batch implementation.

In that recorded comparison, all 77 write measurements and eight reads improve at 1000 runs; four reads are unchanged and none regress.

| Pipeline | Optimizer runs | Writes improved / regressed | Collection bytes | Renderer bytes | Combined deployment gas change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legacy | 200 (baseline) | 0 / 0 | 14,358 | 10,333 | 0 |
| **Legacy** | **1000 (selected)** | **77 / 0** | **15,476** | **11,775** | **+522,777** |

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

Every configuration uses the same legacy/200 test harness and receiver bytecode. Candidate contracts are deployed from their compiled artifacts at identical addresses, keeping signed calldata and callback costs constant. The [checked-in legacy/200 baseline](benchmarks/compiler-legacy-200.json) records source, harness, dependency and compiler provenance as well as all 89 measurements. Normal runs reject changed provenance or measurements; they never silently replace the baseline. In both records, `sourceCommit` identifies the checkout’s base revision; SHA-256 hashes identify the exact measured working-tree inputs.

The current source has 113 benchmarks, so the preserved 89-benchmark compiler baseline intentionally fails provenance/name checks against it. Reproduce the earlier comparison from its recorded source revision. To compare modified sources, explicitly refresh the compiler baseline with `--update-baseline` as shown below before running:

```sh
node scripts/benchmark-compiler.mjs /tmp/111k-compiler-settings.json legacy 200 1000
```

The full 14-configuration matrix remains available. Omitting pipeline and run arguments tests legacy runs 1, 50, 200, 500, 1000, 1500, 2000, 5000 and 10000, plus IR runs 1, 50, 200, 1000 and 10000:

```sh
node scripts/benchmark-compiler.mjs /tmp/111k-compiler-matrix.json
node scripts/benchmark-compiler.mjs /tmp/111k-ir-settings.json ir 1 50 200 1000 10000
```

After reviewing an intentional source, harness or toolchain change, explicitly regenerate the compiler baseline, then rerun the comparison without the update flag to verify it:

```sh
node scripts/benchmark-compiler.mjs /tmp/111k-compiler-baseline-update.json legacy 200 1000 --update-baseline
node scripts/benchmark-compiler.mjs benchmarks/compiler-settings.json legacy 200 1000
```

Compiler comparisons leave normal gas snapshots unchanged. Regenerate those separately with `npm run gas:update` when intended. The compiler settings affect future builds and deployments; existing deployed contracts retain their original bytecode.

### Historical comparisons

Superseded compiler, delivery and ownership comparisons, the rejected counter-packing candidate and the historical delivery runner are preserved in Git. The [history index](benchmarks/HISTORY.md) identifies their original immutable blobs and reproduction context. Those historical measurements describe their original sources and are not relabeled as current results.

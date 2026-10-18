# 111K contracts

An ERC721A collection with public crate and warehouse sales, atomic unpacking, signed delivery quotes, physical crate claims, and onchain SVG placeholders. Contract logic is non-upgradeable. The owner can change prices, sale status, the emergency redemption pause, the authorization signer, treasury, and metadata renderer.

Ownership transfers require the new owner to accept. `renounceOwnership()` is disabled and reverts with `OwnershipRenunciationDisabled()` for the owner, preserving withdrawals and emergency controls. Existing deployments need a fresh deployment to gain this protection; the authorization protocol remains version 2.

The isolated package uses only the approved `erc721a@4.3.0` and `@openzeppelin/contracts@5.6.1`. Foundry and Solidity 0.8.30 must already be installed. Builds and tests use `--offline` and do not download compilers. No Hardhat, ethers, viem, or forge-std dependency is needed.

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

The tests cover every allocation in a 5,555-crate mixed warehouse/direct sale, all 111,111 resulting artwork identities, the 31-item bonus on both routes, arbitrary unpacking order, transfers and burns, replay protection, receiver callbacks, rollback, treasury failure, and metadata. Delivery tests also revert a chain snapshot and change the artwork mapping to verify that an old quote cannot redeem a different physical identity.

Stateful invariant tests mix purchases, transfers, unpacking, delivery, claims, and pause changes across multiple owners. An independent model checks token identities, ownership, balances, allocations, and consumed authorizations. Normal checks use 128 sequences of 64 calls and fail on unexpected handler reverts. Run the longer campaign with:

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

The deployment helper accepts only a loopback Anvil RPC with chain ID 31337. It deploys the renderer and collection using Anvil's first unlocked account. It writes addresses, the deployment block, and `protocolVersion: 3` to `.local/deployment.json`. Optional overrides are `ETHEREUM_111K_LOCAL_RPC_URL`, `ETHEREUM_111K_LOCAL_OWNER`, `ETHEREUM_111K_LOCAL_QUOTE_SIGNER`, and `ETHEREUM_111K_LOCAL_TREASURY`.

Local deployment manifest version 3 identifies the renamed collection and signing domain. Restart Anvil, rerun `deploy:local`, and restart the local API with its fresh database when upgrading any older local deployment. Older manifests are rejected with these redeployment instructions. Existing contracts require a fresh deployment to acquire the new collection name and domain; they are not upgradeable. Both delivery and crate-claim authorizations use EIP-712 domain name `111K` and version `2`. Authorizations remain bound to their original domain, chain and contract address, so old-domain signatures cannot authorize the renamed collection.

Start the isolated API from the repository root:

```sh
npm run dev:ethereum:api
```

The helper reads `.local/deployment.json`, injects the public local test signer, and creates temporary databases. Follow the [local API and frontend setup](../../scripts/docs/111k_testnet.md#run-locally). Public networks require a separately provisioned signer.

Anvil's exposed accounts and keys are for local development only. The collection starts with sales active, crate price `0.0001 ETH`, and warehouse price `0.0011 ETH`. Delivery fees are supplied by a signed quote; the local test flow uses `0.0001 ETH`. Mint and delivery payments accumulate in the collection until the owner calls `withdraw()`, which sends the balance to the configured treasury.

`script/Deploy111K.s.sol` prepares an explicitly configured deployment using `ETHEREUM_111K_DEPLOYER_KEY`, `ETHEREUM_111K_OWNER`, `ETHEREUM_111K_QUOTE_SIGNER`, and `ETHEREUM_111K_TREASURY`. It is not invoked by the local helper or any check. Public testnet deployment and funding are separate operator actions.

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

The contract rejects reuse of every spot-minted ID, including IDs burned earlier. Product actions require the actual token owner, even if a caller is an approved operator. Purchases accept 1–15 crates or warehouses; warehouse supply checks count eleven crate allocations per warehouse. Each unpacking call handles one warehouse or crate. Delivery accepts 1–50 items.

`getTokenInfo` returns `(0, 0, address(0))` for nonexistent or burned tokens. `stats().artworksMinted` counts digital artwork NFTs ever minted, including those subsequently redeemed; physical artwork receipts are not part of that counter. Artwork display offsets are stored per ERC721A mint batch and preserved through ownership changes.

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

### Compiler settings (2026-10-18)

The current build uses Solidity 0.8.30, Prague and the legacy pipeline (`via_ir = false`), with `optimizer_runs = 1000`. The [current compiler comparison](benchmarks/compiler-settings.json) measures the renamed sources at legacy/200 and legacy/1000. The comparison includes all 89 benchmarks, source/toolchain hashes, ABI comparisons, code sizes and actual deployment receipts.

All 77 write measurements and eight reads improve at 1000 runs; four reads are unchanged and none regress. These are fresh measurements of the renamed contract and signing domain.

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

Collection deployment costs 3,619,228 gas (+230,924); renderer deployment costs 2,579,059 (+291,853). Both remain within Ethereum's deployment size limits, and the renderer stays within its 12 KiB project budget. These one-time costs are separate from user-call savings. Normal gas snapshots also compile the test receiver at the selected settings; the compiler comparison keeps its bytecode fixed to isolate the collection's improvements.

Every configuration uses the same legacy/200 test harness and receiver bytecode. Candidate contracts are deployed from their compiled artifacts at identical addresses, keeping signed calldata and callback costs constant. The [checked-in legacy/200 baseline](benchmarks/compiler-legacy-200.json) records source, harness, dependency and compiler provenance as well as all 89 measurements. Normal runs reject changed provenance or measurements; they never silently replace the baseline. In both records, `sourceCommit` identifies the checkout’s base revision; SHA-256 hashes identify the exact measured working-tree inputs.

Reproduce the current comparison from `onchain/ethereum`:

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

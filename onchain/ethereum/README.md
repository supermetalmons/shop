# Mons 111k contracts

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

## Local chain

Start Anvil in one terminal:

```sh
npm run chain:local
```

In another terminal:

```sh
npm run deploy:local
```

The deployment helper accepts only a loopback Anvil RPC with chain ID 31337. It deploys the renderer and collection using Anvil's first unlocked account. It writes addresses, the deployment block, and `protocolVersion: 2` to `.local/deployment.json`. Optional overrides are `MONS_111K_LOCAL_RPC_URL`, `MONS_111K_LOCAL_OWNER`, `MONS_111K_LOCAL_QUOTE_SIGNER`, and `MONS_111K_LOCAL_TREASURY`.

Protocol v2 requires a fresh collection deployment because the contract is not upgradeable. Restart the local chain, rerun `deploy:local`, and restart the local API with its fresh database before testing v2. Existing v1 addresses, delivery quotes, claim authorizations, and local deployment files are incompatible. Both delivery and crate-claim authorizations now use EIP-712 domain version `2`.

The burn-first delivery implementation also requires a fresh collection deployment, while retaining protocol version 2. Frontend delivery sorting works with existing v2 contracts. Existing authorizations remain order-sensitive and bound to their original contract address; the optimization does not rewrite saved quotes or pending transactions.

Start the isolated API from the repository root:

```sh
npm run dev:ethereum:api
```

The helper reads `.local/deployment.json`, injects the public local test signer, and creates temporary databases. Follow the [local API and frontend setup](../../scripts/docs/111k_testnet.md#run-locally). Public networks require a separately provisioned signer.

Anvil's exposed accounts and keys are for local development only. The collection starts with sales active, crate price `0.0001 ETH`, and warehouse price `0.0011 ETH`. Delivery fees are supplied by a signed quote; the local test flow uses `0.0001 ETH`. Mint and delivery payments accumulate in the collection until the owner calls `withdraw()`, which sends the balance to the configured treasury.

`script/Deploy111k.s.sol` prepares an explicitly configured deployment using `MONS_111K_DEPLOYER_KEY`, `MONS_111K_OWNER`, `MONS_111K_QUOTE_SIGNER`, and `MONS_111K_TREASURY`. It is not invoked by the local helper or any check. Public testnet deployment and funding are separate operator actions.

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

The EIP-712 domain is `Mons111k`, version `2`, with the current chain ID and collection address. The accepted types are:

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

### Delivery ordering and burn-first (2026-10-18)

The burn-first implementation was accepted against `678dd7cf` using an identical expanded 89-scenario harness. All 52 delivery scenarios improve, and none of the 77 measured write calls regress. The original 45 baseline measurements reproduce exactly. Coverage includes 20/31/50 artworks, ascending/reversed/deterministically shuffled selections, sparse/fragmented/initialized ownership, crates, mixed deliveries, and both EOA and contract receivers.

| Operation | Before | Burn-first | Gas saved |
| --- | ---: | ---: | ---: |
| 50 artworks, ascending | 2,976,674 | 2,957,308 | 19,366 |
| 50 crates | 2,040,119 | 2,019,153 | 20,966 |
| 25 artworks + 25 crates, ascending | 2,500,590 | 2,480,424 | 20,166 |

These are isolated write-transaction snapshots, including intrinsic gas while excluding setup. Each before/after pair uses identical calldata, so its difference isolates the contract change. Sorting provides an additional, order-dependent saving: on the accepted contract, ascending delivery of 50 fresh artworks saves 75,960 snapshot gas versus reverse order and 12,606 versus the recorded shuffle. Crate-only and fully initialized ownership controls show at most 24 gas of signature-byte variation across orderings, rather than a structural execution saving. Sorting runs offchain and changes neither the ABI nor EIP-712 version or fixtures.

Collection runtime decreases from 14,411 to 14,358 bytes; creation bytecode decreases from 15,876 to 15,823 bytes. Actual deployment transactions on the same restored Prague Anvil state cost 3,399,940 gas before and 3,388,448 after, saving 11,492 gas. Renderer runtime and deployment cost remain 7,752 bytes and 1,728,982 gas.

[The comparison record](benchmarks/delivery-order.json) contains all measurements, source/harness hashes, tool versions, deployment receipts and the acceptance decision. Reproduce it from this package with:

```sh
node scripts/benchmark-delivery.mjs /tmp/111k-delivery-comparison.json
```

The script compares baseline sources from the recorded commit with the working-tree candidate in temporary projects using the same harness and compiler settings. It starts and stops its own local Anvil node, updates no snapshots, and exits unsuccessfully if any measured write call regresses or no delivery improves. The committed snapshots contain the accepted 89-scenario measurements.

### Ownership lookup optimization (2026-10-18)

The accepted change resolves ownership once in `getTokenInfo`: sequential artwork lookup uses one bounded backward scan, while spot tokens read their explicit ownership entry. Both supply counters retain their existing storage representation. Compared with `abe1a634`, all 33 write benchmarks improve or stay unchanged. Fresh 20-item artwork lookup saves 5,044 gas (9.55%), fresh 31-item lookup saves 7,893 (9.87%), and fragmented lookup saves 1,159 (7.33%). Delivering 50 artworks saves 115,217 gas (3.73%).

The read tradeoff is explicit: absent sequential/spot lookups cost 270/272 more gas; burned sequential/spot lookups cost 648/286 more. Their return values and `tokenURI` error behavior are unchanged. The generated ABI and authorization/metadata fixtures are unchanged.

Counter packing was measured separately on top of the accepted ownership change, using a single word and the same `uint256` getter ABI. It saves 173 gas on direct crate purchases, 22,406 on first warehouse purchases (including after direct crate sales), 5,306 on later warehouse purchases, and 2,055 on `stats()`. It was rejected because 19 write benchmarks increase by 12 or 600 gas relative to the ownership candidate. The acceptance rule checks each write benchmark, without averaging gains against regressions. Packing's getter overhead is also shown below.

The collection runtime grows from 14,233 to 14,411 bytes (+178) for the accepted change; the rejected packing candidate is 14,459 bytes (+48 more). The renderer remains 7,752 bytes. All are below the 24,576-byte runtime limit.

All 45 measurements use the same harness, Foundry 1.7.1-Homebrew, Solidity 0.8.30, optimizer 200 runs, Prague, and the default non-IR pipeline. The write snapshots include isolated transaction overhead; view snapshots measure call gas. Setup, signature preparation and any outer wallet execution are excluded. The historical JSON record's execution-only label is inaccurate; its unchanged numerical comparisons remain valid. `Ownership Δ` compares with the baseline; `Packing Δ` compares with the accepted ownership implementation. Negative values save gas.

| Operation | Baseline | Ownership | Ownership Δ | Packing | Packing Δ |
| --- | ---: | ---: | ---: | ---: | ---: |
| allocatedCrates | 2,362 | 2,362 | 0 | 2,377 | +15 |
| claim20 | 609,895 | 609,808 | -87 | 609,820 | +12 |
| claim20Crate10 | 609,895 | 609,808 | -87 | 609,820 | +12 |
| claim20Receiver | 644,562 | 644,475 | -87 | 644,487 | +12 |
| claim31 | 899,582 | 899,495 | -87 | 899,507 | +12 |
| claim31Receiver | 953,320 | 953,234 | -86 | 953,246 | +12 |
| deliverArtwork1 | 137,200 | 137,199 | -1 | 137,211 | +12 |
| deliverArtworks50 | 3,091,891 | 2,976,674 | -115,217 | 2,977,274 | +600 |
| deliverArtworks50Receiver | 3,178,904 | 3,063,725 | -115,179 | 3,064,325 | +600 |
| deliverCrate1 | 129,752 | 129,663 | -89 | 129,675 | +12 |
| deliverCrates50 | 2,043,799 | 2,040,119 | -3,680 | 2,040,719 | +600 |
| deliverCrates50Receiver | 2,130,709 | 2,127,108 | -3,601 | 2,127,708 | +600 |
| deliverMixed50 | 2,556,682 | 2,500,590 | -56,092 | 2,501,190 | +600 |
| deliverMixed50Receiver | 2,643,667 | 2,587,634 | -56,033 | 2,588,234 | +600 |
| getTokenInfoAbsentSequential | 2,732 | 3,002 | +270 | 3,002 | 0 |
| getTokenInfoAbsentSpot | 2,848 | 3,120 | +272 | 3,120 | 0 |
| getTokenInfoBurnedSequential | 4,951 | 5,599 | +648 | 5,599 | 0 |
| getTokenInfoBurnedSpot | 2,848 | 3,134 | +286 | 3,134 | 0 |
| getTokenInfoFragmented | 15,802 | 14,643 | -1,159 | 14,643 | 0 |
| getTokenInfoFresh | 52,837 | 47,793 | -5,044 | 47,793 | 0 |
| getTokenInfoFresh31 | 79,996 | 72,103 | -7,893 | 72,103 | 0 |
| getTokenInfoInitialized | 5,805 | 5,803 | -2 | 5,803 | 0 |
| getTokenInfoSpot | 3,532 | 3,442 | -90 | 3,442 | 0 |
| mintCrates1 | 120,918 | 120,918 | 0 | 120,745 | -173 |
| mintCrates15 | 484,246 | 484,246 | 0 | 484,073 | -173 |
| mintCrates15After1 | 432,946 | 432,946 | 0 | 432,773 | -173 |
| mintCrates15After240 | 432,946 | 432,946 | 0 | 432,773 | -173 |
| mintCrates15AfterWarehouse | 432,946 | 432,946 | 0 | 432,773 | -173 |
| mintCrates15Receiver | 510,253 | 510,253 | 0 | 510,080 | -173 |
| mintCrates1AfterWarehouse | 69,618 | 69,618 | 0 | 69,445 | -173 |
| mintWarehouses1 | 165,953 | 165,953 | 0 | 143,547 | -22,406 |
| mintWarehouses15 | 843,203 | 843,203 | 0 | 820,797 | -22,406 |
| mintWarehouses15AfterCrate | 791,903 | 791,903 | 0 | 769,497 | -22,406 |
| mintWarehouses15AfterWarehouse | 774,803 | 774,803 | 0 | 769,497 | -5,306 |
| mintWarehouses15Receiver | 869,210 | 869,210 | 0 | 846,804 | -22,406 |
| mintWarehouses1AfterCrate | 114,653 | 114,653 | 0 | 92,247 | -22,406 |
| mintWarehouses1AfterWarehouse | 97,553 | 97,553 | 0 | 92,247 | -5,306 |
| stats | 13,190 | 13,190 | 0 | 11,135 | -2,055 |
| unboxCrate20 | 130,918 | 130,828 | -90 | 130,840 | +12 |
| unboxCrate20Receiver | 162,027 | 161,938 | -89 | 161,950 | +12 |
| unboxCrate31 | 135,324 | 135,234 | -90 | 135,246 | +12 |
| unboxCrate31Receiver | 183,408 | 183,319 | -89 | 183,331 | +12 |
| unboxWarehouse | 353,550 | 353,461 | -89 | 353,473 | +12 |
| unboxWarehouseReceiver | 372,627 | 372,538 | -89 | 372,550 | +12 |
| warehousesMinted | 2,384 | 2,384 | 0 | 2,387 | +3 |

[The benchmark record](benchmarks/ownership-counters.json) preserves all measurements, percentage changes, exact tool versions, source/harness hashes, and the decision. [The rejected packing patch](benchmarks/counter-packing.patch) reproduces that candidate from the accepted ownership source in a separate checkout; it is evidence only and is not applied. To reproduce the baseline, use `src/Mons111k.sol` from `abe1a634` with the recorded 45-scenario harness. Run the command in the record for each source version with snapshot emission disabled. The committed [gas snapshots](snapshots/Mons111kGasTest.json) track the current accepted implementation; this comparison's historical measurements remain in its benchmark record.

### Historical comparisons

Disabling ownership renunciation and using `ECDSA.recoverCalldata` were measured against `72882e49` with the settings below. All 13 delivery/claim scenarios save 237–248 gas per call; the other 16 measurements are unchanged. That revision had a 14,233-byte collection runtime.

The historical comparison below records emergency-pause hardening at `8d260f49` against `9a95163b`, using Foundry 1.7.1, Solidity 0.8.30, optimizer 200 runs, and Prague. The same 29 isolated scenarios were captured before and after that change. Every measured call uses less gas, including the new pause check for delivery and claims. `Receiver` cases include minimal ERC-721 receiver callbacks; `After1`/`After240` use existing holdings; `Crate10` claims a different fixed artwork range.

| Operation | Before | After | Gas change | Change |
| --- | ---: | ---: | ---: | ---: |
| claim20 | 613,982 | 610,132 | -3,850 | -0.63% |
| claim20Crate10 | 613,982 | 610,132 | -3,850 | -0.63% |
| claim20Receiver | 648,649 | 644,799 | -3,850 | -0.59% |
| claim31 | 903,681 | 899,820 | -3,861 | -0.43% |
| claim31Receiver | 957,419 | 953,558 | -3,861 | -0.40% |
| deliverArtwork1 | 141,592 | 137,437 | -4,155 | -2.93% |
| deliverArtworks50 | 3,202,055 | 3,092,138 | -109,917 | -3.43% |
| deliverArtworks50Receiver | 3,289,069 | 3,179,152 | -109,917 | -3.34% |
| deliverCrate1 | 133,820 | 129,989 | -3,831 | -2.86% |
| deliverCrates50 | 2,047,920 | 2,044,040 | -3,880 | -0.19% |
| deliverCrates50Receiver | 2,134,831 | 2,130,951 | -3,880 | -0.18% |
| deliverMixed50 | 2,611,289 | 2,556,926 | -54,363 | -2.08% |
| deliverMixed50Receiver | 2,698,275 | 2,643,912 | -54,363 | -2.01% |
| getTokenInfoFragmented | 17,017 | 15,802 | -1,215 | -7.14% |
| getTokenInfoFresh | 57,022 | 52,837 | -4,185 | -7.34% |
| mintCrates1 | 124,864 | 120,918 | -3,946 | -3.16% |
| mintCrates15 | 488,206 | 484,246 | -3,960 | -0.81% |
| mintCrates15After1 | 436,906 | 432,946 | -3,960 | -0.91% |
| mintCrates15After240 | 436,906 | 432,946 | -3,960 | -0.91% |
| mintCrates15Receiver | 514,213 | 510,253 | -3,960 | -0.77% |
| mintWarehouses1 | 169,921 | 165,953 | -3,968 | -2.34% |
| mintWarehouses15 | 847,185 | 843,203 | -3,982 | -0.47% |
| mintWarehouses15Receiver | 873,192 | 869,210 | -3,982 | -0.46% |
| unboxCrate20 | 134,944 | 130,918 | -4,026 | -2.98% |
| unboxCrate20Receiver | 166,053 | 162,027 | -4,026 | -2.42% |
| unboxCrate31 | 139,350 | 135,324 | -4,026 | -2.89% |
| unboxCrate31Receiver | 187,434 | 183,408 | -4,026 | -2.15% |
| unboxWarehouse | 357,528 | 353,550 | -3,978 | -1.11% |
| unboxWarehouseReceiver | 376,605 | 372,627 | -3,978 | -1.06% |

That pause-control change grew the collection runtime from 14,080 to 14,345 bytes (+265). The renderer remains 7,752 bytes. Both remain below the 24,576-byte runtime limit. These snapshots are gas measurements, not ETH fee estimates. Isolated writes include transaction overhead; wallet-specific outer execution can add further cost.

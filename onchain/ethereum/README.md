# Mons 111k contracts

An ERC721A collection with public crate and warehouse sales, atomic unpacking, signed delivery quotes, physical crate claims, and onchain SVG placeholders. Contract logic is non-upgradeable. The owner can change prices, sale status, the authorization signer, treasury, and metadata renderer.

The isolated package uses only the approved `erc721a@4.3.0` and `@openzeppelin/contracts@5.6.1`. Foundry and Solidity 0.8.30 must already be installed. Builds and tests use `--offline` and do not download compilers. No Hardhat, ethers, viem, or forge-std dependency is needed.

## Check

Run from `onchain/ethereum`:

```sh
npm ci --ignore-scripts
npm run check
```

`forge test` regenerates deterministic authorization/calldata vectors in `fixtures/eip712.json` and metadata fixtures in `fixtures/metadata.json`. `scripts/check-fixtures.mjs` validates metadata and decodes SVG previews under `out/media-previews`. Regenerate `shared/ethereum/abi.generated.ts` after changing the contract interface:

```sh
npm run build
npm run abi
```

The tests cover every allocation in a 5,555-crate mixed warehouse/direct sale, all 111,111 resulting artwork identities, the 31-item bonus on both routes, arbitrary unpacking order, transfers and burns, replay protection, receiver callbacks, rollback, treasury failure, and metadata. Delivery tests also revert a chain snapshot and change the artwork mapping to verify that an old quote cannot redeem a different physical identity.

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

Before any burn or mint, delivery derives every receipt ID from the current token identity, validates ownership and item kind, and compares the receipt commitment. A changed mapping, such as an artwork token ID allocated to a different crate after a reorg, reverts with `InvalidAuthorization`. The caller must prepare a fresh quote. Ownership is checked again immediately before each burn so receiver callbacks cannot transfer a later selected token out from under the operation.

Delivery order IDs and claim IDs must be nonzero and can be consumed only once. The deadline must be current and at most ten minutes ahead of the executing block timestamp. Failed actions revert completely, including authorization consumption and payment.

Secret codes and shipping details remain offchain. The backend authorizes a specific wallet and crate receipt only after validating its code. The contract derives the 20/31 output count and receipt numbers itself. Events bind completed operations to their offchain order/claim records.

The owner can replace the renderer for a later metadata implementation. This changes metadata authority without allowing changes to ownership, supply rules, or redemption logic. Renderer changes emit ERC-4906 metadata refresh events.

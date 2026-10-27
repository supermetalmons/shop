# 111K Sepolia offchain metadata release

The replacement collection is live at [mons.shop/111k_devnet](https://mons.shop/111k_devnet). The [application release record](application-release.json) identifies the active services, resumed control state, completed reset, and acceptance evidence. Mainnet metadata is published for future deployments; no mainnet contract was deployed.

| Contract | Address | Deployment block |
| --- | --- | --- |
| Collection | [0x7f5f699b99e8feff9b9011f5b6f193d072186a92](https://sepolia.etherscan.io/address/0x7f5f699b99e8feff9b9011f5b6f193d072186a92) | 12004558 |
| URL renderer | [0x83dfce5d990bf564afd02ae63555799b51d7f181](https://sepolia.etherscan.io/address/0x83dfce5d990bf564afd02ae63555799b51d7f181) | 12004555 |

Digital artwork numbers now equal their sequential ERC-721 token IDs. Artwork `T` and receipt `1000000 + T` use the same flower. Physical-only artwork receipts occupy token IDs 1111112–1222222, avoiding collisions while preserving efficient digital batch minting. Actual artwork issuance remains capped at 111111 by mutually exclusive crate opening/redemption paths. The [metadata guide](../../scripts/docs/111k_metadata.md) documents the complete numbering and publishing workflow.

## Metadata publication

The private R2 bucket **cdn-mons-shop** was created in **Eastern North America (ENAM)**. The original empty `mons-shop-cdn` bucket was removed. The `mons-shop-cdn` Worker serves the replacement bucket through `cdn.mons.shop`; R2 public access and its development URL remain disabled.

- Sepolia: [111k-sepolia/1.json](https://cdn.mons.shop/111k-sepolia/1.json), 344948 objects.
- Mainnet: [111k/1.json](https://cdn.mons.shop/111k/1.json), 344948 objects.
- Total: **689896 JSON files**, verified for complete filename coverage and byte sizes in the [remote inventory audit](bucket-inventory-verification.json). Each upload also verified its content checksum.
- The [HTTP verification](cdn-http-verification.json) confirms no-store headers, CORS, HEAD, missing-object behavior, and immediate overwrite/restore visibility at the same URL.

The Worker enforces no-store independently of object metadata. JSONs contain embedded SVGs, and application metadata requests retain no persistent result cache. Marketplaces may retain their own indexed copies; future updates may need ERC-4906 or marketplace refresh requests. No reveal or automatic-update workflow is part of this release.

## Verification and cutover

The [paused verification](deployment-paused.json) confirmed frozen bytecode, constructor configuration, proceeds, discounts, Seaport behavior, and 12 metadata boundary samples. The collection was paused in the block immediately after deployment. [Open verification](deployment-open.json) completed before acceptance minting. Historical contracts remain unchanged and active.

[Sourcify verification](sourcify-verification.json) and [Routescan verification](external-verification.json) succeeded for both contracts. Frozen sources, creation bytecode, constructor arguments, and runtime were compared with the deployed contracts. Because the build uses `bytecodeHash: none`, Sourcify labels the result `match`. Automatic Etherscan forwarding reached its shared daily quota.

The source reports identify the checkout's base revision and explicitly record that the deployed build includes working-tree changes. The [source hashes and compiler inputs](source-manifest.json), rather than the base revision alone, identify the deployed code.

The API was published with the new collection, renderer, and metadata service binding. The required drain period ended at 2026-10-27T10:48:28.697Z. Scoped reset `796fe701-a050-4cec-a276-d56384e6592e` completed after that deadline, with a verified private backup outside Git. It retired one old reconciliation cursor; all other old-scope counts were zero. Shared accounts and unrelated drops were preserved. The [reset evidence](reset-verification.json) contains the backup checksum without private backup contents.

The frontend was published and Ethereum control resumed on the new collection at revision 13. [Paused HTTP checks](http-paused.json) verified seven write routes returned 503 during maintenance. [Open HTTP checks](http-open.json) verified the active configuration, prices, availability, and offchain metadata reads.

## Live acceptance

The [live acceptance](live-acceptance.json) passed with five finalized transactions:

- Minted three crates and opened #3 before #1, producing sequential artwork IDs 1–40.
- Delivered artwork #1 and crate #2; scheduled reconciliation independently recovered the fulfillment order.
- Verified the actual CDN artwork and receipt contain the same flower composition.
- Transferred crate receipt #2000002 and claimed all 20 physical receipts 1111132–1111151, with matching ownership and metadata.
- Confirmed no customer email or public pack-status side effects. The synthetic order is marked DO NOT SHIP.

At the recorded final block 12004698, three crates were allocated, 40 digital artworks had been minted, and total token supply was 60. This leaves 5552 crate allocations available. Acceptance spent 0.000400004614102 test ETH including fees.

Contract tests, gas checks, API unit/runtime suites, frontend checks, metadata validation, local end-to-end flows, and deployment integrity gates passed. The [validation record](validation.json) records their scope. The 311-artwork opening remains an efficient sequential batch at 1215801 Prague gas in the checked benchmark.

# 111K Sepolia single-contract release

Deployed October 27, 2026. The shop at [mons.shop/111k_devnet](https://mons.shop/111k_devnet) now uses one `NFT111K` contract with direct CDN metadata URLs.

| Item | Value |
| --- | --- |
| Collection | [0x8b4044dbd10c05d84d067208980de58e9d5fe915](https://sepolia.etherscan.io/address/0x8b4044dbd10c05d84d067208980de58e9d5fe915) |
| Deployment block | 12005467 |
| Metadata prefix | `https://cdn.mons.shop/111k-sepolia/` |
| API version | `f874a646-3177-4ed6-8988-252411c710b7` |
| Frontend version | `fdee4955-e27e-49ae-9c38-377b3d4d7efd` |
| Application control | Active, revision 16 |

## Contract changes

`NFT111K` stores `baseURI` and constructs token URLs directly. The separate URL renderer and renderer interface are removed from current source and deployment tooling. The owner can call `setBaseURI(string)`; every successful call emits `BaseURIUpdated` and ERC-4906 `BatchMetadataUpdate`, including an unchanged prefix after editing CDN files. Coordinate prefix changes with the API metadata configuration and its allowed URL policy.

Token IDs, preview methods, minting, discounts, proceeds, redemption, and EIP-712 domain version 2 retain their behavior. Existing owner, authorization signer, proceeds recipients/shares, delivery receiver, prices, and discount configuration were checked before freezing deployment inputs and verified on the replacement. The collection starts with fresh issuance state. Older NFTs stay in their original contracts, whose onchain behavior remains unchanged. CDN files were reused, and no mainnet contract or database schema was changed.

Local deployment manifests now use version 8, record one collection, and probe its `baseURI()` directly. Previous local deployments must be recreated.

## Deployment and cutover

The exact creation payload was simulated against live Sepolia RPC and deployed from frozen compiler inputs. The new sale was paused at block 12005469 while bytecode, constructor settings, 12 metadata boundary samples, proceeds, and signatures were verified. [Sourcify verification](sourcify-verification.json) compared published sources, creation bytecode, constructor arguments, and runtime with the frozen build. Its `match` label reflects the existing `bytecodeHash: none` compiler setting.

The application was paused at revision 14, and the new API was published before the 65-second drain. Scoped reset `eff5ab4d-a715-48e2-8535-5f371e6ce0f7` completed after the drain with a verified private backup outside Git. It removed one old synthetic delivery document, recovery row, quote, claim, and reconciliation cursor. All guarded outbox, inventory, and public-history counts were zero. The [post-reset check](reset-postcheck.json) confirmed the retired scope was empty; shared accounts and unrelated drops were preserved.

The matching frontend was published, the new sale was opened, and application control resumed at revision 16. [Paused HTTP checks](http-paused.json) verified all seven write routes returned 503 during maintenance. [Open HTTP checks](http-open.json) verified the active address, prices, inventory, and all metadata kinds. [Browser inspection](browser-acceptance.json) confirmed the mint controls and inventory, shipment, and receipt sections rendered normally.

## Validation

The [validation record](validation.json) covers 144 passing Solidity tests, 113 gas measurements, 486 Ethereum TypeScript tests, 2,630 API unit tests, 39 native runtime tests, 4,761 root tests, supporting frontend suites, and the real Anvil lifecycle. Three optional Seaport fork tests were skipped. An additional isolated deployment-helper regression verified nonzero nonce prediction, one deployment transaction, collection-payee rejection, and manifest version 8. One profile test timed out during parallel checking; its isolated file and the full isolated API rerun passed.

Runtime is 21,780 bytes, leaving 2,796 bytes below the EIP-170 limit. A 30-receipt metadata URL read costs 93,570 Prague gas, down from 151,196; opening 311 artworks remains 1,215,801 gas. The local deployment benchmark is 5,338,642 Prague gas. Live Sepolia deployment used its own RPC estimate, rather than local deployment limits.

Source attribution uses the [source manifest](source-manifest.json) and published source hashes. The recorded Git revision identifies the checkout's base; this release includes the working-tree implementation.

## Live acceptance

The [live acceptance](live-acceptance.json) passed with five finalized transactions: mint three crates; open crates #3 and #1 together for 40 artworks; deliver artwork #1 and crate #2; transfer the crate receipt; and claim its 20 physical artwork receipts. Scheduled reconciliation recovered the delivery independently of client confirmation. Inventory metadata matched current CDN files, and the digital artwork receipt retained the redeemed artwork’s flower.

The synthetic delivery is marked **DO NOT SHIP**. Acceptance confirmed there were no customer-email or public pack-status side effects. The [application release record](application-release.json) captures final chain state, active services, control revision, and transaction fees.

## Evidence

- [Deployment](deployment.json), [paused verification](deployment-paused.json), and [open verification](deployment-open.json)
- [Preflight](preflight.json), [deployment transactions](deployment-transactions.json), and [source verification](sourcify-verification.json)
- [API publication and drain](api-release.json), [frontend publication](frontend-release.json), and [resumed control](resume-result.json)
- [Reset preview](reset-preview.json), [completed reset and backup checksum](reset-verification.json), and [empty retired scope](reset-postcheck.json)

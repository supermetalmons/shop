# 111K Sepolia v9

The monument receipt collection is live at [mons.shop/111k_devnet](https://mons.shop/111k_devnet). Unopened monuments can be physically redeemed in mixed orders with crates and artworks, up to 50 items. Redemption burns Monument #N and mints its terminal Monument Receipt #N. Receipts can transfer, but cannot be unpacked, redeemed again, or exchanged for other receipts. The monument's 111 reserved crate allocations and lifetime slot remain consumed.

| Item | Value |
| --- | --- |
| Chain | Sepolia, 11155111 |
| Deployment ID | v9 |
| Collection | [0x4d127fceeaa8b652744c4cb1f62f1101290180a8](https://sepolia.etherscan.io/address/0x4d127fceeaa8b652744c4cb1f62f1101290180a8) |
| Creation block | 12033427 |
| Creation transaction | [0xcc2face2cfc1dff178251d56732093c76fc06ee8e96673c2d74c6cc8ad69452d](https://sepolia.etherscan.io/tx/0xcc2face2cfc1dff178251d56732093c76fc06ee8e96673c2d74c6cc8ad69452d) |
| Monument receipt IDs | 3000001–3000018 |
| Receipt metadata | [Monument Receipt #1](https://cdn.mons.shop/111k-sepolia/v9/3000001.json) |
| Receipt image | [receipt_background.webp](https://wip.lil.org/111k/receipt_background.webp) |
| Source verification | [Sourcify](https://repo.sourcify.dev/11155111/0x4d127fceeaa8b652744c4cb1f62f1101290180a8) |
| Opening transaction | [0x20a93ca0e5bf9409eec8c131ce75a2fb4909530fe449133ba4e42d026e5e060c](https://sepolia.etherscan.io/tx/0x20a93ca0e5bf9409eec8c131ce75a2fb4909530fe449133ba4e42d026e5e060c) |
| Opening block | 12033497 |

All 344984 metadata objects were [published](metadata-publication.json) and [verified](metadata-verification.json), including the 18 new receipts. Every monument receipt uses the requested placeholder image. The [complete manifest](metadata-manifest.json) preserves the seven template hashes and object checksum. Historical metadata prefixes and reveal assignments remain intact; the [mainnet comparison](mainnet-approved-diff.json) found no object or registry changes.

The collection deployed with sales closed. [Initial](deployment-initial-zero.json) and [preopening](preopening-zero.json) checkpoints verified zero issuance, zero proceeds, and no mint or purchase events. The API and frontend were published, the scoped reset verified, and v9 commerce/reveal activated before opening. [HTTP acceptance](http-preopening.json) checked all 18 receipt metadata responses and the exact frontend bundle. [Browser acceptance](browser-acceptance.json) observed 18 / 18 monuments available and an enabled mint button. No QA tokens were minted on the live collection.

V8 at `0xab705be519d707a56f43abd63f0869e88fc882b7` has its sale, physical redemptions, and new reveal admission paused. The [guarded reset](reset-verification.json) cleared only its reconciliation cursor after the drain and private backup: there were no orders, quotes, checkouts, attempts, or claims to delete. Shared accounts, addresses, authentication, unrelated drops, and historical reveal records were preserved.

[Validation](validation.json) records 175 passing Solidity tests, the allocation invariant, 127 gas benchmarks, 21 contract-tooling tests, 4762 frontend tests plus 34 Worker/client checks, 2880 API tests, 49 runtime tests, and the [local real-chain lifecycle](local-lifecycle.json). Three optional fork tests were skipped. A focused metadata restoration test timed out under concurrent load, then passed in isolation and in the full frontend run without changing its timeout. The final deployment-boundary update passed its four targeted tests. [Database preflight](database-preflight.json), [source manifest](source-manifest.json), [source verification](NFT111K.sourcify-verification.json), [application versions](application-release.json), [cutover acceptance](cutover-acceptance.json), and [release summary](release.json) preserve the final evidence.

The current checkout remains a test delivery flow and does not make physical shipments.

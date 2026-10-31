# 111K Sepolia v8

The monument collection is live at [mons.shop/111k_devnet](https://mons.shop/111k_devnet), with a lifetime cap of **18 monuments**. Each monument reserves 111 crates and initially costs 0.0088 test ETH. Active code, APIs, UI, templates, tests and documentation use monument terminology.

| Item | Value |
| --- | --- |
| Chain | Sepolia, 11155111 |
| Deployment ID | v8 |
| Collection | [0xab705be519d707a56f43abd63f0869e88fc882b7](https://sepolia.etherscan.io/address/0xab705be519d707a56f43abd63f0869e88fc882b7) |
| Creation block | 12032655 |
| Creation transaction | [0x63d9d9227cac2cef0c004b626d66a49857aff2e759dae5e8d6dd7dd41640bbc8](https://sepolia.etherscan.io/tx/0x63d9d9227cac2cef0c004b626d66a49857aff2e759dae5e8d6dd7dd41640bbc8) |
| Metadata | [Monument #1](https://cdn.mons.shop/111k-sepolia/v8/117172.json) |
| Source verification | [Sourcify](https://repo.sourcify.dev/11155111/0xab705be519d707a56f43abd63f0869e88fc882b7) |
| Opening transaction | [0xdf2aee7656421469d0dbf2ba1d8812255955617c4268422938708ffc0e9e7bda](https://sepolia.etherscan.io/tx/0xdf2aee7656421469d0dbf2ba1d8812255955617c4268422938708ffc0e9e7bda) |
| Opening block | 12032756 |

All 344966 metadata objects were published and verified. Monument IDs are 117172–117189; the next ID is absent. The initial reveal pool contained all 111111 assets, with no reserved or frozen assignments. The collection deployed closed, passed the [zero-issuance checkpoint](preopening-zero.json), and opened after API/frontend publication, guarded commerce reset and reveal activation. No live QA tokens were minted. [Browser acceptance](browser-acceptance.json) observed 18 / 18 monuments available and an enabled mint button.

The [legacy metadata migration](cdn-migration-verification.json) renamed 90 existing container JSONs across the v7 and two preview namespaces. Existing URLs and legacy objects 19–30 remain available. Names and type traits changed; other JSON values and object coverage were preserved. Historical deployment manifests, verification sources and checksums remain unchanged. Their original publication checksums describe the earlier wording; the additive migration plan records exact before/after bytes.

The [mainnet comparison](mainnet-approved-diff.json) confirms exactly 30 approved preview JSON changes, no object additions or deletions, and unchanged reveal registry state. No mainnet transactions were submitted.

V7 at 0xc7571e9dc4b1cd646d092d51cfa89a76a6461fec has its sale and new reveal admission paused. Its registry, frozen artwork and reveal ledger remain intact. The [scoped reset](reset-verification.json) removed its reconciliation cursor after the drain and private backup; no delivery orders, quotes, checkouts or claims existed to clear. Shared profiles, addresses, authentication and unrelated drops were preserved.

[Validation](validation.json) records 171 Solidity tests, 734 Ethereum TypeScript tests, 125 gas benchmarks, 49 API runtime tests, the local lifecycle, migration tests and release checks. Three optional fork tests were skipped. The broad frontend/API runs encountered two load-related timeouts; both affected cases passed on clean reruns. [Local lifecycle evidence](local-lifecycle.json), [source manifest](source-manifest.json), [source verification](NFT111K.sourcify-verification.json), [application versions](application-release.json), [cutover acceptance](cutover-acceptance.json), and [release summary](release.json) preserve the final evidence.

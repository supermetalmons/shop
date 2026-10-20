# 111K Sepolia discount release

This release deploys the discounted-mint collection on Ethereum Sepolia, chain `11155111`. The [previous collection](../111k-sepolia/README.md) remains active; the renderer is reused.

Contract source revision: unrecorded; exact frozen working tree hashes are recorded in source-manifest.json.

The frozen base revision is `4415c1a4616727980f9353accce7ccd73a4cdd19`. It identifies HEAD at freeze time. The [source manifest](source-manifest.json) records the actual Solidity source hashes, compiler-input/artifact hashes, constructor arguments, and allowlist provenance.

| Contract | Address | Deployment block |
| --- | --- | --- |
| Discount collection | [`0x4b3a94a144fe99954c5d55f870081e40b360cfbf`](https://sepolia.etherscan.io/address/0x4b3a94a144fe99954c5d55f870081e40b360cfbf) | 11957341 |
| Reused renderer | [`0x08cded8258730bda384ff198001e47a1b50f7f9d`](https://sepolia.etherscan.io/address/0x08cded8258730bda384ff198001e47a1b50f7f9d) | See the previous release |

- Owner and treasury: `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93`.
- Quote signer: `0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca`.
- Discount root: `0x8f11db52cdc1977aaf2417edf0e40f2ac9e4adebef100b84aeda2bb705790f3b`.
- Discount allowance: 1 crate per eligible wallet at 0.00005 test ETH.
- Public crate and warehouse prices: 0.0001 and 0.0011 test ETH.
- Allowlist: 318 wallets from the pinned holder snapshot and the explicit additional wallet.

The [deployment record](deployment.json) contains the observed deployment and administration receipts, compiler settings, runtime hashes, and verification state. The most recent included verification observed the new sale paused with zero supply at block 11957347. All included transactions have at least three canonical confirmations according to their verification records. The previous sale was active at each recorded verification block.

- [Paused-sale verification](deployment-paused.json): block 11957347, 2026-10-20T19:22:15.831Z.

The local standard JSON compilation exactly matched both frozen artifacts. Explorer source publication and application rollout are separate checks; this report builder does not infer either outcome.

## Rollout status

The new collection is deployed and paused. Application cutover and final sale opening are pending. Etherscan confirms [Source Code Verified (Exact Match)](https://sepolia.etherscan.io/address/0x4b3a94a144fe99954c5d55f870081e40b360cfbf#code); the compiler input and constructor arguments are recorded in [source verification](etherscan-verification.json).

Before deployment, validation passed 115 non-gas contract tests, 108 gas cases, 10 gas-regression tests, 6 snapshot-generator tests, 4,082 root tests, 2,442 API tests, 36 native Worker tests, 35 Rust tests, and the Anvil lifecycle suite. Frontend/API/tools type checks, dead-code checks, the build, credential scan, API dry run and startup check, and frontend dry run also passed.

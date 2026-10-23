# 111K Sepolia Seaport release

Release status: **in progress**. These initial records document a confirmed, paused deployment. Application cutover, sale opening, final mint simulations, and final source attribution are not asserted complete by these records.

This release adds default Seaport approval with holder opt-out on Ethereum Sepolia, chain `11155111`. The [previous proceeds collection](../111k-sepolia-proceeds/README.md), [discount collection](../111k-sepolia-discounts/README.md), and [first collection](../111k-sepolia/README.md) remain active; the renderer is reused. Existing fixed mint splits, the separate delivery receiver, and the discount allowlist are preserved.

Contract source revision: unrecorded; exact frozen working tree hashes are recorded in source-manifest.json.

The frozen base revision is `4364727013a19090ea528b662607e1ac36064cd8`. It identifies HEAD at freeze time. The [source manifest](source-manifest.json) records the actual Solidity source hashes, compiler-input/artifact hashes, seven constructor arguments, the exact proceeds configuration, and allowlist provenance.

| Contract | Address | Deployment block |
| --- | --- | --- |
| Seaport collection | [`0xea8f813d8844cfdd6bd917e2efda0b18c0c79497`](https://sepolia.etherscan.io/address/0xea8f813d8844cfdd6bd917e2efda0b18c0c79497) | 11978544 |
| Reused renderer | [`0x08cded8258730bda384ff198001e47a1b50f7f9d`](https://sepolia.etherscan.io/address/0x08cded8258730bda384ff198001e47a1b50f7f9d) | See the previous release |

- Owner: `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93`.
- Mint recipients, in order: `0x1111111111111111111111111111111111111111` (50%), `0x2222222222222222222222222222222222222222` (25%), `0x3333333333333333333333333333333333333333` (15%), `0x4444444444444444444444444444444444444444` (10%). These testnet placeholder addresses and shares are fixed for this deployment.
- Delivery payment receiver: `0x5555555555555555555555555555555555555555`, a separate testnet placeholder that the owner can replace.
- All received, released, and releasable proceeds were zero at each verification snapshot.
- Quote signer: `0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca`.
- Seaport operator: `0x0000000000000068f116a894984e2db1123eb395`; default approval and absence of unrelated-operator approval were verified for two holders.
- Discount root: `0x8f11db52cdc1977aaf2417edf0e40f2ac9e4adebef100b84aeda2bb705790f3b`.
- Discount allowance: 1 crate per eligible wallet at 0.00005 test ETH.
- Public crate and warehouse prices: 0.0001 and 0.0011 test ETH.
- Allowlist: 318 wallets from the pinned holder snapshot and the explicit additional wallet.

The [deployment record](deployment.json) contains the observed deployment and administration receipts, compiler settings, runtime hashes, and verification state. The most recent included verification observed the new sale paused with zero supply at block 11978552. All included transactions have at least three canonical confirmations according to their verification records. All three historical sales were active at each recorded verification block.

- [Paused-sale verification](deployment-paused.json): block 11978552, 2026-10-23T18:47:11.143Z.

The local standard JSON compilation exactly matched both frozen artifacts. Explorer source publication and application rollout are separate checks; this report builder does not infer either outcome.

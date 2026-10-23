# 111K Sepolia Seaport release

The release is complete: Etherscan verified the contract source as an exact match, both services are published, and the application is active on the new collection. The [application release record](application-release.json) contains the verification evidence.

This release adds default Seaport approval with holder opt-out on Ethereum Sepolia, chain `11155111`. The [previous proceeds collection](../111k-sepolia-proceeds/README.md), [discount collection](../111k-sepolia-discounts/README.md), and [first collection](../111k-sepolia/README.md) remain active; the renderer is reused. Existing fixed mint splits, the separate delivery receiver, and the discount allowlist are preserved.

Contract source revision: f4fd7c1ca3587ee0a551ccb7bef9ed9539e6e59b.

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

The [deployment record](deployment.json) contains the observed deployment and administration receipts, compiler settings, runtime hashes, and verification state. The most recent included verification observed the new sale open with zero supply at block 11978660. All included transactions have at least three canonical confirmations according to their verification records. All three historical sales were active at each recorded verification block.

- [Paused-sale verification](deployment-paused.json): block 11978552, 2026-10-23T18:47:11.143Z.
- [Open-sale verification](deployment-open.json): block 11978660, 2026-10-23T19:08:48.710Z.

The [read-only mint simulations](mint-simulation.json) passed all five cases and observed unchanged supply, stats, and proceeds. No mint transaction was signed or broadcast by that helper.

The local standard JSON compilation exactly matched both frozen artifacts. [Etherscan verification](etherscan-verification.json) independently confirmed an exact source match.

## Application rollout

Both services were published from source revision `f4fd7c1ca3587ee0a551ccb7bef9ed9539e6e59b` and each serves 100% of traffic. The [application release record](application-release.json) contains the observed versions and acceptance evidence.

| Service | Version |
| --- | --- |
| API `mons-shop-api` | `d6e51db2-b4fe-44dc-80b1-a9c9c167731e` |
| Frontend `mons-shop` | `886d4dea-9cac-4411-b09f-d68f78a78f1f` |

## Reset

Scoped reset `63e851e5-ccfc-46b3-9f2f-388f0b7f0d40` retired 2 delivery orders, 2 recovery records, 2 quotes, 2 crate claims, 16 checkout URLs, 2 checkout attempts, and 1 reconciliation cursor from the previous collection. It was applied at 2026-10-23T19:04:23.000Z, after the API drain deadline 2026-10-23T19:03:49.739Z.

No database backup was created, as requested. The [preservation audit](reset-verification.json) accounted for shared identities, retained concurrency tombstones, preserved unrelated drops, and confirmed that global Commerce stayed active. Ethereum control resumed on the new collection at revision 10. All three historical onchain sales remained active.

## Acceptance

[Validation](validation.json), [paused HTTP checks](http-paused.json), [open HTTP checks](http-open.json), and [browser acceptance](browser-acceptance.json) passed. Seven fulfillment and checkout mutation endpoints returned 503 during maintenance. The deployed [proof asset](proof-asset-verification.json) matched the local build. [Etherscan verification](etherscan-verification.json) confirmed an exact source match.

The five [read-only mint simulations](mint-simulation.json) passed without signing or broadcasting mint transactions. [Normal scheduled reconciliation](reconciliation-verification.json) advanced the new cursor to block 11978668; the old scope remained empty and reconciliation was not triggered manually.

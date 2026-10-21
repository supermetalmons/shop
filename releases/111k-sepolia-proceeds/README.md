# 111K Sepolia proceeds release

This release deploys the collection with fixed mint splits and a separate delivery receiver on Ethereum Sepolia, chain `11155111`. Both the [previous discount collection](../111k-sepolia-discounts/README.md) and [first collection](../111k-sepolia/README.md) remain active; the renderer is reused.

Contract source revision: 1e16f0f192a39ba334cf233da0c9b1500636ca15.

The frozen base revision is `e68b79f4f5dce21c3938c4fd80ca1d24077ca746`. It identifies HEAD at freeze time. The [source manifest](source-manifest.json) records the actual Solidity source hashes, compiler-input/artifact hashes, seven constructor arguments, the exact proceeds configuration, and allowlist provenance.

| Contract | Address | Deployment block |
| --- | --- | --- |
| Proceeds collection | [`0x3fc9f53200d3f025dfd046490b744747749a7b54`](https://sepolia.etherscan.io/address/0x3fc9f53200d3f025dfd046490b744747749a7b54) | 11963848 |
| Reused renderer | [`0x08cded8258730bda384ff198001e47a1b50f7f9d`](https://sepolia.etherscan.io/address/0x08cded8258730bda384ff198001e47a1b50f7f9d) | See the previous release |

- Owner: `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93`.
- Mint recipients, in order: `0x1111111111111111111111111111111111111111` (50%), `0x2222222222222222222222222222222222222222` (25%), `0x3333333333333333333333333333333333333333` (15%), `0x4444444444444444444444444444444444444444` (10%). These testnet placeholder addresses and shares are fixed for this deployment.
- Delivery payment receiver: `0x5555555555555555555555555555555555555555`, a separate testnet placeholder that the owner can replace.
- All received, released, and releasable proceeds were zero at each verification snapshot.
- Quote signer: `0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca`.
- Discount root: `0x8f11db52cdc1977aaf2417edf0e40f2ac9e4adebef100b84aeda2bb705790f3b`.
- Discount allowance: 1 crate per eligible wallet at 0.00005 test ETH.
- Public crate and warehouse prices: 0.0001 and 0.0011 test ETH.
- Allowlist: 318 wallets from the pinned holder snapshot and the explicit additional wallet.

The [deployment record](deployment.json) contains the observed deployment and administration receipts, compiler settings, runtime hashes, and verification state. The most recent included verification observed the new sale open with zero supply at block 11963953. All included transactions have at least three canonical confirmations according to their verification records. Both historical sales were active at each recorded verification block.

- [Paused-sale verification](deployment-paused.json): block 11963856, 2026-10-21T17:19:39.760Z.
- [Open-sale verification](deployment-open.json): block 11963953, 2026-10-21T17:39:23.223Z.

The [read-only mint simulations](mint-simulation.json) passed all five cases and observed unchanged supply, stats, and proceeds. No mint transaction was signed or broadcast by that helper.

The local standard JSON compilation exactly matched both frozen artifacts. Etherscan reports **Source Code Verified (Exact Match)**; the [verification record](etherscan-verification.json) and [screenshot](etherscan-exact-match.png) document the published source.

## Application rollout

Both services were published from source revision `1e16f0f192a39ba334cf233da0c9b1500636ca15`. The [application release record](application-release.json) contains deployment times, versions, maintenance checks, and acceptance evidence.

| Service | Version |
| --- | --- |
| API `mons-shop-api` | `6f1090d5-7586-4af7-8854-6e3ea0b7750a` |
| Frontend `mons-shop` | `f5448daa-1ac7-4a06-bc3d-46a6bf3356ce` |

Both versions serve 100% of traffic. [The live drop](https://mons.shop/111k_devnet) shows 5,555 crates and 505 warehouses at the expected prices in the [browser acceptance snapshot](browser-acceptance.json). The deployed allowlist asset [matches the validated local build](proof-asset-verification.json).

## Scoped reset

Reset `d8a86bfb-bbbd-4951-9499-aaa961d12344` removed the previous collection’s single reconciliation cursor. There were no old delivery orders, recovery records, quotes, or claims to delete. The reset was applied at `2026-10-21T17:35:53.000Z`, after the API drain deadline `2026-10-21T17:35:02.903Z`.

The [preservation audit](reset-verification.json) passed: shared profiles and addresses, unrelated drops, other native scopes, and concurrency tombstones were preserved; global Commerce stayed active. Two expired anonymous sessions were accounted for separately, with no unaccounted changes or removals. Private backups and row-level evidence remain outside Git. Ethereum control resumed on the new collection at revision 7.

## Acceptance

The [release checks](validation.json) passed all repository stages, contract and gas tests, compiler-benchmark regeneration, end-to-end scenarios, type checks, database integrity gates, and worker/frontend dry runs. A pre-existing export-baseline mismatch was resolved by recording three exports used by operational tooling and tests; runtime behavior and dependencies were unchanged.

During maintenance, the new collection’s reads were available while all four fulfillment mutation endpoints returned 503. After resumption, [live HTTP checks](http-open.json) confirmed the new enabled configuration, zero-supply snapshot, empty representative inventory, metadata, health, and an unrelated drop. No live mint transaction was submitted for acceptance.

The [normal scheduled reconciliation](reconciliation-verification.json) advanced only the new cursor to block `11963982` at `2026-10-21T17:45:25.018Z`; the old scope stayed empty. No scheduler invocation was triggered manually.

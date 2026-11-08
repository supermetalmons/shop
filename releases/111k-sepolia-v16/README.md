# 111K Sepolia v16 — updated container and receipt assets

**Live and open.** The replacement
serves the [111K testnet page](https://mons.shop/111k_devnet).

| Item | Value |
| --- | --- |
| Contract | [0x938b6a488951b2797b29284d6939dd70efe146a0](https://sepolia.etherscan.io/address/0x938b6a488951b2797b29284d6939dd70efe146a0) |
| Deployment block | 12087015 |
| Creation transaction | [0xfce17726…c53af87](https://sepolia.etherscan.io/tx/0xfce1772654764f0068489003c3fd2c205231238566d84cf60eff1c84dc53af87) |
| Metadata prefix | `https://cdn.mons.shop/111k-sepolia/v16/` |
| Reveal catalog | `111k-v5` |

Crates use [crate.webp](https://cdn.lil.org/nft/111k/crate.webp), 1448 × 1086
(4:3). Warehouses use [warehouse.webp](https://cdn.lil.org/nft/111k/warehouse.webp),
1536 × 1024 (3:2). Unrevealed artwork and every receipt kind use
[placeholder.png](https://cdn.lil.org/nft/111k/placeholder.png), 932 × 1006
(466:503). Metadata includes these ratios. Mint previews, inventory, and both
rebuilt unpack scenes use the new artwork; local scene textures match the CDN
bytes exactly. See [asset verification](asset-verification.json).

All [344,984 metadata objects](metadata-verification.json) were published and
fully verified before deployment. The interrupted upload resumed from its
journal, retaining 316,240 matching objects and publishing the remaining 28,744.
The v5 catalog preserves the 111,111-artwork allocation: 76,642 eggs, 30,990
paintings, 3,000 3D models, 421 animated artworks, and 58 videos.

The constructor preserves the fourteen-recipient mint split, seven-wallet relic
allowances, discount configuration, prices, and delivery configuration 1.
[Reservation verification](deployment-reserved.json) confirms eighteen relics
reserved with 0.018 Sepolia ETH, consuming 1,998 crate allocations without using
any relic claims. Redemption signing remains disabled.

[Sourcify](NFT111K.sourcify-verification.json) verifies the frozen sources and
complete runtime including immutables. [Etherscan](NFT111K.etherscan-verification.json)
also verifies the exact contract and constructor arguments.

## Replacement and validation

V15 sales, redemptions, commerce, and reveal admission are paused. Its guarded
commerce reset created a private backup and removed one reconciliation cursor;
there were no orders or claims to remove. Historical NFTs, published metadata,
and reveal ledgers remain preserved. Obsolete local snapshots were removed from
the checkout; the [archive manifest](archived-snapshots.json) records their
original Git revision.

[Predeployment checks](validation-predeployment.json) passed 4,994 application
tests, 3,079 API unit tests, 58 native runtime tests, 266 Solidity tests, 125
contract-tooling tests, and the full local lifecycle. Four Solidity
tests were skipped. [Scene checks](scene-verification.json),
[mint and inventory checks](scene-ui-verification.json), and
[interactive reveal checks](scene-interactive-verification.json) cover desktop,
mobile, landscape, reduced motion, and WebGL failure fallbacks.

## Live acceptance

[Application rollout](application-release.json), [reveal activation](reveal-active.json),
[commerce resumption](control-resumed.json), and [sale opening](deployment-open.json)
are complete. [Closed acceptance](acceptance-closed.json) verified the new
identity, all image kinds and ratios, zero issuance, and unused relic allowances
before opening.

[Live acceptance](acceptance-live.json) purchased crate **113110** for
**0.0001 Sepolia ETH** and unpacked it into artwork tokens **1–20** held by the
deployer: **14 eggs, 5 paintings, and 1 3D model**. All twenty published metadata
objects, their images, the GLB companion, and the inventory response passed
verification. All seven wallets retain their unused relic allowances.

- [Mint transaction](https://sepolia.etherscan.io/tx/0x900ed527b698d34c3b42005b39e9697445c5bf521aa2bef2ea0c2775296e979e)
- [Unpack transaction](https://sepolia.etherscan.io/tx/0x5bd6d1d25449adcb121ab2ae347935fe9affea0654fc61cd8c42c2d1c39fcee2)
- [Post-unpack onchain verification](deployment-unpack-qa.json)
- [Live desktop/mobile UI verification](live-ui-verification.json): eight cases,
  correct asset dimensions, no obsolete asset requests, and no browser errors.

A fresh completion check confirms both [Worker deployments](final-worker-deployment-recheck.json)
serve these versions at 100% traffic, and the live frontend files match the
checked build. [Full metadata coverage](final-metadata-coverage-recheck.json)
contains all 344,984 expected objects with none missing or unexpected.
[Current onchain and application state](final-assurance.json) and a
[fresh production browser check](final-live-ui-recheck.json) both pass with
sales and reveal active.

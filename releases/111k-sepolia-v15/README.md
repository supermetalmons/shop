# 111K Sepolia v15 — final CDN assets

**Live and open.** The [111K testnet page](https://mons.shop/111k_devnet) uses v15, with minting and relic claims enabled.

| Item | Value |
| --- | --- |
| Contract | [0xe665d1043f72886f49894006ea196450b33f0f89](https://sepolia.etherscan.io/address/0xe665d1043f72886f49894006ea196450b33f0f89) |
| Deployment block | 12085980 |
| Creation transaction | [0x9c78986a…c5cd44a38](https://sepolia.etherscan.io/tx/0x9c78986a8dd5940be56d70c4b8522b10015ff016174bdf88cf1e7d8c5cd44a38) |
| Metadata prefix | `https://cdn.mons.shop/111k-sepolia/v15/` |
| Reveal catalog | `111k-v4` |
| Media root | `https://cdn.lil.org/nft/111k/` |
| Source verification | [Sourcify](https://repo.sourcify.dev/11155111/0xe665d1043f72886f49894006ea196450b33f0f89) |

The 111,111-artwork pool contains 76,642 eggs, 30,990 paintings, 3,000 3D models,
421 animated artworks, and 58 videos. Artwork names remain numeric and descriptions
remain empty. Painting alternatives are retained in the catalog; metadata uses
one primary image. The reusable importer preserves its source JSON and generates
exact ratios and media paths for future fresh deployments.

All [344,984 metadata objects](metadata-verification.json) were published and
verified before deployment. [Closed verification](deployment-closed.json) checks
zero issuance, the complete runtime including constructor immutables, the
fourteen-recipient mint split, seven-wallet allowances, prices, discount cap,
and metadata URI. The [reservation](deployment-reserved.json) allocates eighteen
relics with 0.018 Sepolia ETH, consuming 1,998 crate allocations without claiming
any relic. Delivery configuration 1 and disabled delivery signing are retained.

[Sourcify verification](NFT111K.sourcify-verification.json) confirms the frozen
sources and deployed bytecode. Etherscan currently reports a
[Similar Match to v14](etherscan-similar-match.json): its published sources match
all 22 frozen source files, but it does not publish v15's constructor arguments.
The API returned `Already Verified` to the exact-match submission. Etherscan's
[documented upgrade policy](https://info.etherscan.com/update-on-similar-match-contract-verification/)
requires an enabled author account. Constructor arguments and all immutable
values are independently verified by the onchain and Sourcify checks; no exact
Etherscan match is claimed.

V14's [sale and redemptions are paused](old-contract-paused.json), its reveal
admission is paused, and its guarded commerce reset backed up and removed one
reconciliation cursor. Its NFTs, proceeds, metadata, and reveal ledger remain
in place. No mainnet transaction was submitted.

[Predeployment validation](validation-predeployment.json) includes frontend/API
release checks, Solidity/tooling checks, importer tests, and a local five-category
reveal lifecycle. The checked-in `nft111k:deploy` runner journals signed
transactions privately before broadcast and requires three canonical
confirmations. Public transaction evidence is in
[deployment-transactions.json](deployment-transactions.json).

## Live acceptance

[Closed acceptance](acceptance-closed.json) checked the deployed application,
active v4 reveal registry, current contract identity, and unrevealed token
behavior before opening. [Opening verification](deployment-open.json) records
the confirmed sale opening. [Application release](application-release.json)
records the API and frontend Worker versions; all required checks and remote
D1 integrity checks passed, with no migrations to apply.

The [live QA acceptance](acceptance-qa.json) purchased crate token **113110** for
**0.0001 Sepolia ETH** and unpacked it into artwork tokens **1–20** held by the
deployer. The reveal produced **11 eggs, 8 paintings, and 1 3D model**. All twenty
public metadata objects, their twenty PNG images, the GLB companion, and the
shop's inventory response passed verification. The seven relic allowances
remain unused by the QA flow. Local E2E separately covers all five categories.

- [Mint transaction](https://sepolia.etherscan.io/tx/0x2439d943f6e77e190c3d51799893e30d7fae98b16b355cf6f62b79d03608441b)
- [Unpack transaction](https://sepolia.etherscan.io/tx/0x8f1faa77f950bc1708642dbd7e45df6510b8d037f2ea28db78fc074f2e7916f5)
- [Post-unpack onchain verification](deployment-unpack-qa.json)

An unrelated account called permissionless `releaseAllMint()` before opening.
[All fourteen payouts](proceeds-payout-verification.json) matched the configured
shares and totaled the 0.018 ETH reservation deposit. The release checks now
accept legitimate payouts while still verifying reservation, issuance, claims,
recipient entitlements, and remaining balance. The runner's final 31-test suite
covers this case and interrupted-broadcast recovery.

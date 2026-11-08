# 111K Sepolia v17 — staged public relic minting

**Live and open. Replacement and v16 retirement are complete.** Crate/warehouse
sales, reserved relic claims, and reveal are enabled. Public relic minting remains
disabled.

| Item | Value |
| --- | --- |
| Contract | [0xaca342968965ddb20badb1943b99ee6523658619](https://sepolia.etherscan.io/address/0xaca342968965ddb20badb1943b99ee6523658619) |
| Deployment block | 12092412 |
| Creation transaction | [0xa64760fd…a86d3b](https://sepolia.etherscan.io/tx/0xa64760fdefcb0d2bce0bc603a4dfa729507071a343d8879bb62920a4c1a86d3b) |
| Metadata prefix | `https://cdn.mons.shop/111k-sepolia/v17/` |
| Reveal catalog | `111k-v5` |
| Reserved relics | 7; one unused claim per existing test wallet |
| Reserved crates | 777 |
| Preorder deposit | 0.007 Sepolia ETH |
| Public relic sale | Disabled; quota 0, price 0, no public free allowances |

[Deployment evidence](deployment.json) records three canonical confirmations.
[Closed verification](deployment-closed.json) and
[reservation verification](deployment-reserved.json) confirmed the frozen runtime,
constructor configuration, seven unused claims, and zero NFT issuance before
opening. [Application rollout](application-release.json) confirms the API and
frontend serve v17 at 100% traffic, with the frontend matching its checked build.
[Final assurance](final-assurance.json) and the
[final chain verification](final-chain-verification.json) confirm the completed
replacement remains healthy.

Reserved claims continue through `claimRelic(id)`, choosing any unissued ID from
1–18 while sales are open. Capacity for eleven public relics remains. Public paid and
free mints consume 111 available crates only on issuance, share a cumulative
owner-controlled quota, and cannot consume preorder reservations. They remain
disabled in this release's initial configuration. The existing claim UI is
unchanged; no public purchasing interface was added.

The fourteen-recipient mint split, signer, delivery configuration, normal prices,
and lifetime discounted-mint cap of 5,555 are unchanged. The 0.007 ETH deposit is
credited to mint proceeds and is not automatically distributed.

All **344,984 metadata objects**, totaling **88,551,500 bytes**, were published
and [fully verified](metadata-verification.json) before deployment. Current
templates use the shared `cdn.lil.org/nft/111k/` media, including all eighteen
relic images. Catalog `111k-v5` preserves 111,111 artworks: 76,642 eggs, 30,990
paintings, 58 videos, 3,000 3D models, and 421 animated artworks.

[Sourcify verification](NFT111K.sourcify-verification.json) matches the frozen
sources and runtime including immutables. [Etherscan verification](NFT111K.etherscan-verification.json)
matches the frozen source and constructor arguments. The contract uses Solidity
0.8.38, legacy/200 optimization, and a 24,537-byte runtime.

[Predeployment validation](validation-predeployment.json) passed contract,
compiler/gas, API, frontend, and extended invariant checks. Four fork-only
contract tests were skipped.

## Live acceptance

The [QA acceptance report](acceptance-qa.json) verifies the paid purchase of crate
**111902**, its unpack into **20 artwork tokens, 61–80**, reveal/publication of
those artworks, matching media, and complete inventory recovery. Other users
also minted and unpacked ordinary items while the release completed. At the QA
snapshot, global totals were 791 crate allocations, one warehouse minted, and
80 artworks minted; the QA token range is derived from its own confirmed
transaction evidence.

- [QA mint transaction](https://sepolia.etherscan.io/tx/0x1d6c636666f876d498968f4ff83996ef0d2beee425eff25e6820c4ad4f55aed2)
- [QA unpack transaction](https://sepolia.etherscan.io/tx/0xcf2b1c10bc48daeee8d5bbf887b34d3c032ed0de600668ce2ea57caa3fba4950)
- [Canonical mint verification](deployment-mint-qa.json)
- [Canonical unpack verification](deployment-unpack-qa.json)

All seven wallets retained one unused reserved claim, all eighteen relic IDs
remained selectable, and public relic quota, price, issuance, and free allowances
remained zero. Both public mint paths rejected read-only simulations while the
existing reserved claim simulation succeeded. [Live UI verification](live-ui-verification.json)
passed ten desktop/mobile cases without API mocks or wallet submissions.

## Completed retirement

[Retirement verification](retirement-verification.json) confirms v16's irreversible
retirement, writer drain, and removal of **344,984 metadata objects** plus its
backend storage and alarms. Seven obsolete local artifact targets were removed:
**345,252 files, 238,935,650 bytes**, including the temporary reset backup.

The final absence and replacement-health check ran **362,629 ms after metadata
deletion**, exceeding the five-minute scheduler interval, with no recreation.
Mainnet, pre111k, shared media, profiles, and required v17 evidence were preserved.
The [final retirement recheck](final-retirement-recheck.json) confirms the old
metadata prefix is empty and the old reveal API rejects access.
The [historical v16 release](https://github.com/supermetalmons/shop/blob/b488f92ed8347163b2a4e2d58fe80e04b360b4b8/releases/111k-sepolia-v16/README.md)
remains in Git; no legacy archive was retained.

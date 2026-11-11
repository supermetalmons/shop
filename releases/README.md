# Release evidence

Release folders contain verification snapshots, immutable deployment identities,
and completed-operation evidence. Counts, URLs, versions, and state descriptions
apply to their recorded verification time. Use the [project runbooks](../README.md#operations-and-reference)
and committed deployment registry for current behavior.

The current 111K Sepolia release is [v17](111k-sepolia-v17/README.md), with
[completed v16 retirement](111k-sepolia-v17/retirement-verification.json).
The [earlier 111K testnet cleanup](111k-testnet-cleanup-2026-11-08/README.md) tracks
retirement of deployments preceding [v16](https://github.com/supermetalmons/shop/blob/b488f92ed8347163b2a4e2d58fe80e04b360b4b8/releases/111k-sepolia-v16/README.md). Historical
links are pinned to the pre-cleanup Git revision; they do not promise continued
metadata or reveal service for retired testnet NFTs. The cleanup creates no new
archive. Current publications use the CDN assets documented in the
[111K metadata guide](../scripts/docs/111k_metadata.md).

| Area | Evidence |
| --- | --- |
| pre111k relic preorders | [Mainnet v2](pre111k-mainnet-v2/README.md), [Sepolia v2](pre111k-sepolia-v2/README.md), [Mainnet v1 deployment and activation](pre111k-mainnet-v1/README.md), [Sepolia v1 contract and storefront](pre111k-sepolia-v1/README.md) |
| Mi Note mainnet launch | [Deployment and launch](mi-note-cards/README.md), [completed preorder conversion](mi-note-cards/preorder-upgrade/README.md) |
| Mi Note devnet rehearsal | [Deployment, activation, and conversion](mi-note-cards-devnet/README.md) |
| Mi Note metadata | [Public metadata](mi-note-cards-mainnet/README.md), [1396–1398](mi-note-cards-1396-1398/README.md), [1399–1400](mi-note-cards-1399-1400/README.md), [1409–1413](mi-note-cards-1409-1413/README.md), [1414–1419](mi-note-cards-1414-1419/README.md), [1420–1430](mi-note-cards-1420-1430/README.md) |
| 111K Sepolia | [v17 public relic support and live acceptance](111k-sepolia-v17/README.md), [v16 retirement](111k-sepolia-v17/retirement-verification.json), [historical v16 media](https://github.com/supermetalmons/shop/blob/b488f92ed8347163b2a4e2d58fe80e04b360b4b8/releases/111k-sepolia-v16/README.md), [earlier testnet retirement](111k-testnet-cleanup-2026-11-08/README.md), [earlier deployments and validation](https://github.com/supermetalmons/shop/tree/8c3de5aea944c3c7d67f1f5c9800c78afb7d6340/releases) |
| 111K online catalog expansions | [v8: 5,201 added paintings, 164 revealed eggs hatched](111k-catalog-v8/README.md), [v7](111k-catalog-v7/README.md), [v6 evidence](111k-catalog-v6/rollout.json) |
| 111K metadata hosting | [Public R2 migration](111k-public-r2/README.md), [minimal metadata](111k-minimal-metadata/README.md) |
| 111K relic images | [Mainnet and Sepolia PNG metadata with storefront mid WebPs](111k-relic-images-2026-11-11/README.md) |
| 111K historical reveals and recovery | [Original rollout and recovery evidence](https://github.com/supermetalmons/shop/tree/8c3de5aea944c3c7d67f1f5c9800c78afb7d6340/releases/111k-reveal-2026-10-29), [concurrency measurements](https://github.com/supermetalmons/shop/blob/8c3de5aea944c3c7d67f1f5c9800c78afb7d6340/releases/111k-concurrency-2026-10-30/README.md) |
| Binder packing replacements | [Completed issuance and current export path](binder-packing-replacements-2026-10-20/README.md) |
| Receipt claim Workflows | [Original rollout](receipt-claim-workflow-2026-09-23/README.md), [October 21 recovery verification](receipt-claim-recovery-2026-10-21/verification.json) |
| Mainnet URI migrations | [Migration records and historical tooling](mainnet-uri-migrations-2026-08-05/README.md) |
| Authentication provider retirement | [Recorded retirement](legacy-auth-retirement/README.md) |

Preserve applied SQL, current transaction journals and signed evidence, mainnet
asset identities, and URI aliases required by supported collections. Retired
testnet identities remain reserved even after their metadata and ledgers are
purged; their obsolete local backups are removed by the scoped cleanup. Historical
operation tooling is recovered from the full source revisions recorded in its
release folder, with matching dependencies and runbooks. Private claim credentials
and operator journals remain outside the repository.

# Release evidence

Release folders contain verification snapshots, immutable deployment identities,
and completed-operation evidence. Counts, URLs, versions, and state descriptions
apply to their recorded verification time. Use the [project runbooks](../README.md#operations-and-reference)
and committed deployment registry for current behavior.

| Area | Evidence |
| --- | --- |
| Mi Note mainnet launch | [Deployment and launch](mi-note-cards/README.md), [completed preorder conversion](mi-note-cards/preorder-upgrade/README.md) |
| Mi Note devnet rehearsal | [Deployment, activation, and conversion](mi-note-cards-devnet/README.md) |
| Mi Note metadata | [Public metadata](mi-note-cards-mainnet/README.md), [1396–1398](mi-note-cards-1396-1398/README.md), [1399–1400](mi-note-cards-1399-1400/README.md), [1409–1413](mi-note-cards-1409-1413/README.md), [1414–1419](mi-note-cards-1414-1419/README.md), [1420–1430](mi-note-cards-1420-1430/README.md) |
| 111K Sepolia | [Offchain metadata release](111k-sepolia-offchain/README.md), [Seaport release](111k-sepolia-seaport/README.md), [proceeds release](111k-sepolia-proceeds/README.md), [discount release](111k-sepolia-discounts/README.md), [initial release](111k-sepolia/README.md), [October 18 validation](111k-validation-2026-10-18/README.md) |
| Binder packing replacements | [Completed issuance and current export path](binder-packing-replacements-2026-10-20/README.md) |
| Receipt claim Workflows | [Original rollout](receipt-claim-workflow-2026-09-23/README.md), [October 21 recovery verification](receipt-claim-recovery-2026-10-21/verification.json) |
| Mainnet URI migrations | [Migration records and historical tooling](mainnet-uri-migrations-2026-08-05/README.md) |
| Authentication provider retirement | [Recorded retirement](legacy-auth-retirement/README.md) |

Preserve applied SQL, transaction journals, signed evidence, permanent asset
identities, and URI aliases needed by existing on-chain assets. Historical
operation tooling is recovered from the full source revisions recorded in its
release folder, with matching dependencies and runbooks. Private claim credentials
and operator journals remain outside the repository.

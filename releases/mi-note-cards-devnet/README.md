# Mi Note Cards devnet rehearsal

Status recorded on 2026-10-09: the devnet drop is live, with the API and frontend
published and mint activation finalized. The complete mint/open/delivery/receipt
smoke test passed independent on-chain and inventory verification.

| Phase | Verified state |
| --- | --- |
| Shared-program compatibility | Both existing binary suites passed |
| On-chain resources | Both configs, receipt tree, and lookup table finalized |
| Inventory | 1,406 available cards; 2 assigned; all 22 preorder IDs excluded |
| Commerce audit | Passed; authority active and not paused |
| Repository checks | Full `npm run check` passed |
| Mint activation | Finalized; operations config remains unstarted |
| Application publication | API published before frontend; live checks passed |
| Live smoke | Pack 1 opened into cards 897 and 323; three receipts verified |
| Cleanup | Buyer balance zero; cards and receipts owned by the authority |

The [deployment record](deployment.json) contains all five finalized transaction
signatures and the final verification slot, `509194528`. The
[readiness snapshot](readiness.json) records the completed release. The
[final verification](verification.json) records the independent chain checks at
slot `509209645` and inventory checks at slot `509209204`.

The published [devnet page](https://mons.shop/mi_note_cards_devnet) prices packs
at 0.25 SOL. Of the 704-pack supply, 703 remain after the smoke mint.
API version `4a1e94f7-2c75-487d-871e-419a94d666e8`
preceded frontend version `20c782be-2340-45b9-b04d-1fe72d1fefb8`. Live health
and inventory requests, with and without devnet enabled, returned HTTP 200;
the rendered page had no browser errors.

This rehearsal reuses shared program
`8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6` and existing preorder collection
`65JF5n29WqB5Z7YsHQXLAPvgsytHRZDixKzqSq2D1RMv`. It does not deploy or upgrade
a program and does not update existing preorder NFTs.

| Role | Config PDA | Supply | Items per box |
| --- | --- | ---: | ---: |
| Mint | `8Cb6FqM1ymyULJZ6htwJAHH8n4pbMMqMz2yfDLLSicPY` | 704 | 0 |
| Operations | `FdHqdSLxUDenJki3eHXBVf6m49h5nnyM5jNreTHzUS6d` | 715 | 2 |

These are finalized resources. Only the mint role is active; keep the operations
role unstarted. The logical public drop has 704
two-card packs priced at 0.25 devnet SOL, with no discount or Stripe checkout.
Mint proceeds retain the existing preorder 50/50 recipients.

The finalized receipt tree is
`FLHhgXrEEwDWvVkFHPK22cNL3DcZHq1GGxuvkoS2V1rG` (depth 14, buffer 64,
canopy 0). The delivery lookup table is
`5B1c2Q2kATTJcsGxkWsxvqJjNCU8BvQRRUJj9eKCwGG3` and includes both config PDAs.

The [frozen inventory](inventory.json) excludes 22 devnet preorders and contains
1,408 eligible original card IDs, including the eight specials and IDs through
1430. Its SHA-256 is
`198e6c6421cbca20ab3ebec25e7efca07c5fa62072bf8e12dce65e6fbf75242d`.
Initialization used generation `238fd2ea-b62b-454a-9a65-97968204d60c` after
Commerce migration `0036_scoped_inventory_initialization.sql` was applied.
The smoke assigned cards 897 and 323 to pack 1, leaving 1,406 available cards.
The initial deployment Commerce audit passed at authority revision 23 and
documents revision 1080; post-smoke verification confirms documents revision
1081, conserved row-based inventory, and active `d1` authority. Revalidate the frozen manifest
and readiness before activation; never substitute mainnet's different exclusion
list.

The [binary attestation](attestation.json) and [successful local gate](gate-result.json)
record the exact deployed program versions tested with real Metaplex programs.
Both shared program versions passed minting, two-config opening, IDs 1409/1430,
receipts, delivery, supply limits, and negative-path checks locally. Mainnet was
read only; all remote rehearsal mutations target devnet.

Use [the deployment runbook](../../scripts/docs/mi_note_drop_deployment.md).
The hosted item metadata base is `https://cdn.lil.org/nft/mi_note_cards/json/pre`.
Devnet pack/pack-receipt IDs 628–704 intentionally retain missing JSON URLs;
no additional metadata is generated or uploaded. Receipt images remain a
separate publication dependency.

The [activation record](activation.json) preserves the finalized signature and
slot `509201368`. The [smoke record](smoke/35421489-f216-41b3-b684-7b012b59a5f5.json)
contains all finalized transaction signatures, pack/card IDs, receipt URIs, and
matching before/after fingerprints for all 22 preorders. Its `recovered` status
records a later cleanup-only invocation; the final verification establishes that
the full original smoke passed. Activation history remains intact and records
the verified smoke result as passed.

Mainnet activation is outside this rehearsal. No physical shipping or email order
was created. Mi Note customs defaults remain unconfigured until measured card
weight and the USD declared value are supplied.

## Later preorder metadata upgrade

The separate [preorder upgrade runbook](../../scripts/docs/mi_note_preorder_upgrade.md)
converts the 22 existing devnet assets to their corresponding regular card names
and metadata. Its records belong in `preorder-upgrade/`. This later operation
preserves the frozen inventory, permanent exclusions, and original rehearsal
evidence above; future smoke fingerprints use the assets' current metadata.

The [reviewed manifest](preorder-upgrade/manifest.json) identifies all 22 assets.
The [unsigned preview](preorder-upgrade/preview.json) passed all six batches:
30,000 lamports in total fees and a 1,005,840-lamport account rent refund.
[Compatibility evidence](preorder-upgrade/compatibility.json) records the API-first
deployment, frontend deployment, and live checks before conversion.

All 22 conversions completed in six finalized transactions on October 9, 2026.
The [journal](preorder-upgrade/journal.json) preserves the exact signed messages
and per-batch preservation checks. The [completion report](preorder-upgrade/completion.json)
independently verifies those messages and the assets at finalized slot
`509247427`: names and URIs match the targets, while owners, collection,
update authorities, and plugins are preserved. Actual fees and rent refunds
matched the preview.

The [live inventory checks](preorder-upgrade/api-verification.json) cover all 22
cards with devnet visibility enabled and disabled, for capable and legacy
clients. The frozen manifest still validates with the same 22 exclusions and
generation; public inventory was conserved at 1,400 available plus 8 assigned
cards. The future-smoke fingerprint reader accepts the converted assets, while
the historical smoke record remains unchanged. No program upgrade or mainnet
write was performed.

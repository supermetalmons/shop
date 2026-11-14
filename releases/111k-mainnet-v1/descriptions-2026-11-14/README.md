# Mainnet container descriptions — 14 November 2026

Updated 6,077 JSONs at `https://cdn.mons.shop/111k/`, changing only their top-level `description`.

| Items | Token IDs | Count | Description |
| --- | --- | ---: | --- |
| Crates #1–5554 | 111112–116665 | 5,554 | `a sealed crate pack of 20 nfts` |
| Warehouses #1–505 | 116667–117171 | 505 | `a sealed warehouse of 11 crates containing 220 nfts` |
| Relics #1–18 | 117172–117189 | 18 | `a sealed relic of 111 crates containing 2220 nfts` |

Crate #5555, token `116666`, remains byte-identical to its [rare-crate publication](../rare-crate-2026-11-12/116666.json), including its 31-NFT description, rare image, and 2:3 aspect ratio. Names, images, attributes, and other fields in every updated object are unchanged.

The operation was bound to deployment `mainnet-v1`, Ethereum mainnet contract `0x08cded8258730bda384ff198001e47a1b50f7f9d`, and registry revision 9. Each write required its frozen original ETag; registration was checked before every batch and after completion. Objects retain `application/json; charset=utf-8`, `Cache-Control: no-store`, and matching SHA-256 metadata.

- [Application](application.json): all 6,077 conditional writes succeeded.
- [Verification](verification.json): every object matched its prepared bytes in storage and the public CDN; 23 public API checks and 15 unchanged-object checks passed.
- [Scheduler observation](scheduler-observation.json): after 323 seconds, crate and warehouse boundaries, all 18 relics, the rare crate, receipts, collection metadata, and Sepolia samples still passed.
- [Metadata delta](metadata-delta.json): exact scope, descriptions, journal and inventory checksums, and generator test result (22 passed).

The frozen before/after journal, resumable maintenance script, and progress log remain in `.cache/111k-mainnet-descriptions-2026-11-14/`. Preserve that journal for recovery; its checksums are recorded in the delta. Original publication snapshots and historical manifests remain immutable.

The three editable templates now use these descriptions for future generation on either network, preserving the final-crate override. No live Sepolia objects, artwork metadata, receipts, or collection metadata were written. No application deployment, Commerce audit, or contract transaction was performed.

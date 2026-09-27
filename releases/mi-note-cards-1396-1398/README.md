# Mi Note cards 1396–1398

| Card ID | Mi Note 3 token ID | Name | Metadata |
| --- | --- | --- | --- |
| 1396 | 125 | Blue Reaper | [1396.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1396.json) |
| 1397 | 126 | Fallen Angel Drifella | [1397.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1397.json) |
| 1398 | 127 | Oni Reaper | [1398.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1398.json) |

The metadata JSONs, original images, thumbnails, and preorder images are published
on the CDN. Local copies of the metadata JSONs are not retained in this repository.

Release order:

1. Apply commerce migrations through `0023_preorder_card_range.sql`.
2. Verify commerce readiness and deploy the API.
3. Deploy the frontend.

The normal API deployment command applies the migrations and verifies readiness
before deploying the API. This change does not require a new onchain collection.

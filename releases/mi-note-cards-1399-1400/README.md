# Mi Note cards 1399–1400

The metadata JSONs, original images, thumbnails, and preorder images are published
and verified on the CDN. Local copies of the metadata JSONs are not retained in
this repository.

| Card ID | Mi Note 3 token ID | Name | Metadata |
| --- | --- | --- | --- |
| 1399 | 128 | Azure Fallen Angel Drifella | [1399.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1399.json) |
| 1400 | 129 | Azure Holy Knight | [1400.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1400.json) |

Preorder images:

- [1399.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1399.webp)
- [1400.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1400.webp)

The catalog references the original images at
`https://cdn.lil.org/player/mi_note_3/128.jpg` and
`https://cdn.lil.org/player/mi_note_3/129.jpg`, with thumbnails at
`https://cdn.lil.org/player/mi_note_3/mid/128.webp` and
`https://cdn.lil.org/player/mi_note_3/mid/129.webp`.

Deployment order:

1. Apply commerce migrations through `0024_preorder_card_range_1400.sql`.
2. Verify commerce readiness and deploy the API.
3. Deploy the frontend.

The normal API deployment command applies the migrations and verifies readiness
before deploying the API. This change does not require a new onchain collection.

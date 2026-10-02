# Mi Note cards 1414–1419

Six new Mi Note 3 tokens are assigned card IDs 1414–1419. All six metadata JSONs
are published and verified on the CDN. They returned HTTP 200 with
`Content-Type: application/json; charset=utf-8` and match the prepared metadata
byte-for-byte. All six original images, thumbnails, and preorder images returned
HTTP 200 with the expected content types and file signatures on October 2, 2026.

| Card ID | Mi Note 3 token ID | Name | Metadata |
| --- | --- | --- | --- |
| 1414 | 135 | Drifella of Death 999 | [1414.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1414.json) |
| 1415 | 136 | SHADOW SAINT 5555 | [1415.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1415.json) |
| 1416 | 137 | Lost Angel | [1416.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1416.json) |
| 1417 | 139 | Drifella Employee 333 | [1417.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1417.json) |
| 1418 | 140 | Drifella Employee 444 | [1418.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1418.json) |
| 1419 | 141 | Drifella Employee 555 | [1419.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1419.json) |

The supplied export contains no token 138. The trailing whitespace in
`Lost Angel` is trimmed; other new names retain their spelling and capitalization.
Existing catalog records and reserved special cards 1401–1408 are preserved.

The JSONs are hosted at
`https://cdn.lil.org/nft/mi_note_cards/preorder/json/<card-id>.json` with
`Content-Type: application/json`. They match the previous release's metadata
format, including the numeric card ID, `Preorder #<card-id>` display name,
artwork name trait, and `mi note 3` collection trait. Both image fields reference
the corresponding preorder image.

Verified preorder images:

- [1414.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1414.webp)
- [1415.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1415.webp)
- [1416.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1416.webp)
- [1417.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1417.webp)
- [1418.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1418.webp)
- [1419.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1419.webp)

Original images use `https://cdn.lil.org/player/mi_note_3/<token-id>.jpg` and
thumbnails use `https://cdn.lil.org/player/mi_note_3/mid/<token-id>.webp`, for
token IDs 135, 136, 137, 139, 140, and 141.

Predeployment checks passed: the frontend production build and browser bundle
validation, frontend and API deployment dry runs, API startup validation, and
the read-only production commerce health check. The predeployment check found
production at `0030_delivery_recovery.sql`; the API release must apply migration
0031 to enable the new preorder IDs.

Release order:

1. Verify the six published metadata JSONs and their referenced images; completed
   on October 2, 2026.
2. Run `npm run deploy:api`, which applies commerce migrations through
   `0031_preorder_card_range_1419.sql`, verifies readiness, and publishes the API.
3. Run `npm run deploy` to publish the frontend.

The migration preserves existing claims, indexes, guards, and automatic expiry
release. The 1411 supported preorder IDs are 1–1400 and 1409–1419; reserved
specials 1401–1408 remain ineligible. No new onchain collection is required.
